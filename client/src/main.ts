// ---------------------------------------------------------------------------
// Client composition root. Wires the layers together and contains NO business
// logic itself (presence/meeting rules live server-side; the game renders; the
// HUD displays; this file just bridges network <-> game/HUD).
//
// Flow: show login -> connect (dev profile or OAuth token) -> on WELCOME boot
// the Phaser game + HUD -> translate every S2C message into game-handle / store
// mutations, and forward explicit user actions as C2S messages. Human agency:
// nothing here auto-teleports — Join buttons send JOIN_* only on user click.
//
// Resilience (plan Reliability): the Connection auto-reconnects with backoff.
// After a successful re-join the server sends a FRESH WELCOME with a NEW
// sessionId; we re-bootstrap idempotently (tear down the old game + store, then
// rebuild from the authoritative welcome). A connection banner reflects the
// live state; the login screen only returns when we are truly offline.
// ---------------------------------------------------------------------------

import "./styles.css";
import {
  C2S,
  S2C,
  type ChatBroadcastPayload,
  type Emote,
  type EmoteBroadcastPayload,
  type EventCreatedPayload,
  type EventEndedPayload,
  type EventUpdatedPayload,
  type MeetingEndedPayload,
  type MeetingStartedPayload,
  type PlayerJoinedPayload,
  type PlayerLeftPayload,
  type PlayerMovedPayload,
  type PlayerUpdatedPayload,
  type PlayerTeleportedPayload,
  type PresencePayload,
  type SetStatusPayload,
  type ToastPayload,
  type WelcomePayload,
  type GameUpdatePayload,
  type FloorChangedPayload,
  type LocationPayload,
  type FloorSyncCodePayload,
  type Building,
  type Floor,
  type PlayerSnapshot,
  parseBuilding,
  floorById,
} from "@pixeloffice/shared";
import { Connection, serverHttpBase } from "./net/connection";
import { createOfficeGame, type OfficeGameHandle } from "./game";
import { Store } from "./ui/state";
import {
  createLogin,
  persistLoginProfile,
  readStoredToken,
  clearStoredToken,
  type JoinSubmission,
} from "./ui/login";
import { openProfileModal } from "./ui/profile";
import { createHud, type HudHandle } from "./ui/hud";
import { Toasts } from "./ui/toasts";
import { createAdmin } from "./ui/admin";
import { mountConnectionBanner } from "./ui/connection-banner";
import { mountAttendance, type AttendanceWidgetHandle } from "./ui/attendance";
import { mountCalendarConnect, type CalendarConnectHandle } from "./ui/calendar-connect";
import { mountEmoteBar, type EmoteBarHandle } from "./ui/emote-bar";
import { mountProfileCard, type ProfileCardHandle } from "./ui/profile-card";
import { mountMinimap, type MinimapHandle } from "./ui/minimap";
import { mountSettings, readHideNpcs, type SettingsHandle } from "./ui/settings";
import { mountOnboarding, type OnboardingHandle } from "./ui/onboarding";
import { createMapStudio, type MapStudioHandle } from "./ui/map-studio";

const gameRoot = document.getElementById("game-root")!;
const hudRoot = document.getElementById("hud-root")!;
const loginRoot = document.getElementById("login-root")!;

const toasts = new Toasts(hudRoot);
const banner = mountConnectionBanner(hudRoot);

// Returning from the Google Calendar OAuth flow lands here with
// `#calendar=connected` in the URL fragment (mirrors login.ts's #token handling,
// but kept here so login.ts stays untouched). Strip the fragment immediately so
// it never lingers in the address bar/history, then toast once the HUD exists.
// Note: login.ts's consumeAuthFragment only acts on #token=/#error= and leaves
// an unrelated #calendar= fragment intact, so this read is not racy.
function consumeCalendarFragment(): boolean {
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  if (!hash) return false;
  const params = new URLSearchParams(hash);
  if (params.get("calendar") !== "connected") return false;
  history.replaceState(null, "", location.pathname + location.search);
  return true;
}
const returnedFromCalendarConnect = consumeCalendarFragment();
// Guard so a reconnect re-boot does not re-toast the calendar-connected message.
let calendarToastShown = false;

const login = createLogin({
  parent: loginRoot,
  onSubmit: (opts) => void start(opts),
});

// Live UI handles for the current session. Recreated on each (re)boot so a
// reconnect (fresh sessionId) starts from the server's authoritative truth.
let game: OfficeGameHandle | null = null;
let hud: HudHandle | null = null;
let attendance: AttendanceWidgetHandle | null = null;
let calendarConnect: CalendarConnectHandle | null = null;
let store: Store | null = null;
let storeUnsubscribe: (() => void) | null = null;
let adminMounted = false;
let selfId = ""; // current sessionId; refreshed on every WELCOME
let activeConn: Connection | null = null; // current Connection; closed on relogin

// New social/navigation widgets. The emote bar + profile card are rebuilt per
// session (they bind to the live HUD/connection); the settings popover and
// onboarding tour mount ONCE and persist across reconnects (like admin), reading
// the live game handle lazily. The minimap is rebuilt per session (it binds to
// the current store) but its collapsed state persists in localStorage.
let emoteBar: EmoteBarHandle | null = null;
let profileCard: ProfileCardHandle | null = null;
let minimap: MinimapHandle | null = null;
let settings: SettingsHandle | null = null;
let onboarding: OnboardingHandle | null = null;
// Map Studio (admin building authoring) mounts ONCE and persists across
// reconnects (like admin/settings). It is self-contained: it fetches/saves
// buildings through /api/maps and never touches the live game or avatars.
let mapStudio: MapStudioHandle | null = null;

// Cached active building geometry (parsed from GET /api/maps/active). Multi-floor
// rendering needs the full Floor geometry (areas/solid/desks/portals), but
// WELCOME/FLOOR_CHANGED only carry the lightweight floor list + the player's
// position. We fetch the geometry once per session and look up floors locally so
// a floor change does not block on the network. Refetched on each (re)boot.
let activeBuilding: Building | null = null;
let buildingFetch: Promise<Building | null> | null = null;
// The floor geometry the minimap should draw. The WELCOME floor fetch may resolve
// before the minimap is mounted, so we stash the resolved floor here and apply it
// right after mountMinimap (and on every FLOOR_CHANGED).
let pendingMinimapFloor: Floor | null = null;

/** Fetch + parse the active building geometry once, caching the promise so
 *  concurrent callers (WELCOME + a quick FLOOR_CHANGED) share one request. */
async function loadActiveBuilding(): Promise<Building | null> {
  if (activeBuilding) return activeBuilding;
  if (!buildingFetch) {
    buildingFetch = (async () => {
      try {
        const res = await fetch(`${serverHttpBase()}/api/maps/active`);
        if (!res.ok) return null;
        const body = (await res.json()) as { building?: unknown };
        if (!body?.building) return null;
        const parsed = parseBuilding(body.building);
        activeBuilding = parsed;
        return parsed;
      } catch {
        // Map service unavailable / pre-multifloor server: fall back to the
        // legacy single-floor rendering already booted by createOfficeGame.
        return null;
      } finally {
        buildingFetch = null;
      }
    })();
  }
  return buildingFetch;
}

/** Resolve a floor's geometry by id from the cached/fetched active building. */
async function floorGeometry(floorId: string): Promise<Floor | null> {
  const building = await loadActiveBuilding();
  if (!building) return null;
  return floorById(building, floorId);
}

// Chat-focus flag for the global keys-1-4 emote handler (we must NOT fire an
// emote while the user is typing a chat message). Updated from the HUD's
// onChatFocus callback below.
let chatFocused = false;

// "Following → name" chip (locate): shown after a roster/minimap locate; cleared
// on the user's next local movement (so it never lingers stale).
const followChip = document.createElement("div");
followChip.className = "follow-chip";
followChip.hidden = true;
hudRoot.appendChild(followChip);
let following = false;

function showFollowChip(name: string): void {
  followChip.textContent = `Following → ${name}`;
  followChip.hidden = false;
  following = true;
}
function clearFollowChip(): void {
  if (!following) return;
  following = false;
  followChip.hidden = true;
}

/** True when a modal/popover/typed field would swallow a 1-4 keypress. */
function emoteKeysBlocked(): boolean {
  if (chatFocused) return true;
  const ae = document.activeElement as HTMLElement | null;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) {
    return true;
  }
  // Any open overlay: admin modal, settings popover, profile card, onboarding.
  return !!document.querySelector(
    ".admin-backdrop:not([hidden]), .settings-pop:not([hidden]), .profile-card:not([hidden]), .onboard-overlay:not([hidden])",
  );
}

// Global keys-1-4 → emote. Registered ONCE (module scope); defers to the live
// emoteBar handle and the focus/modal guard above so it never fires while typing.
window.addEventListener("keydown", (e) => {
  if (e.key < "1" || e.key > "4") return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!emoteBar || emoteKeysBlocked()) return;
  emoteBar.triggerIndex(Number(e.key) - 1);
});

async function start(opts: JoinSubmission): Promise<void> {
  // A relogin (after going offline) builds a fresh Connection; close the old one
  // so its retained handlers/room/client do not linger across cycles.
  activeConn?.close();
  const conn = new Connection();
  activeConn = conn;

  // Banner reflects every state change; login only returns when truly offline.
  conn.onState((state) => {
    banner.setState(state);
    if (state === "offline") {
      teardown();
      login.show();
    }
  });

  // Register the WELCOME handler BEFORE connect so we never miss it. It is NOT
  // one-shot: the first welcome boots; every later (reconnect) welcome re-seeds.
  conn.on<WelcomePayload>(S2C.WELCOME, (welcome) => {
    void boot(conn, welcome).catch((err) => {
      conn.close();
      login.showError(serverDownMessage(err));
    });
  });

  conn.onError((code, message) => {
    toasts.show(`Connection error (${code})${message ? `: ${message}` : ""}`, "broadcast");
  });
  // Transient drops are handled by the banner (Reconnecting…). Do NOT show the
  // login screen here — that is driven by the "offline" state above.
  conn.onLeave(() => {
    toasts.show("Connection lost — reconnecting…", "broadcast");
  });

  // Register the S2C bridge ONCE per Connection, here (not in boot). Connection
  // retains + re-attaches handlers across its OWN reconnects, and a full
  // offline->relogin builds a brand-new Connection that gets its own bridge.
  // Handlers read the live game/store/selfId module refs, so they target the
  // current session correctly after each WELCOME re-seed.
  registerBridge(conn);

  try {
    await conn.connect(opts, opts.token);
  } catch (err) {
    login.showError(serverDownMessage(err));
  }
}

async function boot(conn: Connection, welcome: WelcomePayload): Promise<void> {
  // On a reconnect welcome the sessionId changed: tear down the old game/HUD
  // and rebuild from the authoritative welcome (rare path — clarity over micro-
  // optimization). Idempotent: clears stale avatars + store before re-seeding.
  teardownSession();

  // Drop any cached building geometry so this session fetches fresh — a reconnect
  // may follow an admin map re-activation (new joins get the new active building).
  activeBuilding = null;
  buildingFetch = null;
  pendingMinimapFloor = null;

  selfId = welcome.self.sessionId;
  const localStore = new Store(selfId);
  store = localStore;

  // Seed the store from WELCOME (self first, then others, events, meeting).
  localStore.upsertPlayer(welcome.self);
  for (const p of welcome.players) localStore.upsertPlayer(p);
  for (const ev of welcome.events) localStore.upsertEvent(ev);
  if (welcome.meeting) localStore.setMeeting(welcome.meeting);

  // Multi-floor: record the active building (floor picker source) + the player's
  // authoritative current floor so the HUD floor indicator renders. Display-only
  // — the indicator never moves the avatar (floors change by walking into an
  // elevator). Both are optional/back-compat: a pre-multifloor WELCOME omits
  // `building` and the indicator self-hides.
  localStore.setBuilding(welcome.building ?? null);
  localStore.setSelfFloor(welcome.self.floorId ?? null);

  // Boot the Phaser game (it owns/controls the local avatar).
  const localGame: OfficeGameHandle = await createOfficeGame({
    parent: gameRoot,
    self: welcome.self,
    onLocalMove: (x, y, dir, moving) => {
      conn.send(C2S.MOVE, { x, y, dir, moving });
      // Mirror locally so the roster's "current area" tracks self movement.
      localStore.movePlayer(selfId, x, y, dir, moving);
      // Locate is camera-only: as soon as the user walks, stop "following" and
      // let onboarding step 1 auto-advance on the first real movement.
      if (moving) {
        clearFollowChip();
        onboarding?.notifyMoved();
      }
    },
    onAreaChange: (areaName) => localStore.setSelfArea(areaName),
    onInteractPrompt: (prompt, gameId) => localStore.setInteractPrompt(prompt, gameId),
    onGameInteract: (gameId) => {
      conn.send(C2S.JOIN_GAME, { gameId });
    },
    // Double-clicking the local avatar opens the profile modal.
    onProfileOpen: () => {
      const self = localStore.self();
      if (!self) return;
      openProfileModal({
        parent: hudRoot,
        current: { name: self.name, department: self.department, avatarId: self.avatarId },
        onSave: (draft) => {
          conn.send(C2S.UPDATE_PROFILE, draft);
          // Keep reconnects + the next session in sync with the edit.
          conn.updateJoinProfile(draft);
          persistLoginProfile(draft);
          // Optimistic local apply; the server also broadcasts PLAYER_UPDATED.
          localGame.updatePlayer(selfId, draft);
          localStore.upsertPlayer({ ...self, ...draft });
        },
        onLogout: () => {
          void (async () => {
            // End the real greytHR session server-side (best-effort), then drop
            // the local token and return to the sign-in screen.
            const token = readStoredToken();
            try {
              await fetch(`${serverHttpBase()}/api/auth/greythr/logout`, {
                method: "POST",
                headers: token ? { Authorization: `Bearer ${token}` } : {},
              });
            } catch {
              /* best-effort: still sign out locally */
            }
            clearStoredToken();
            conn.close(); // "offline" -> teardown + login screen
          })();
        },
      });
    },
  });
  game = localGame;

  // Render existing remote players into the scene.
  for (const p of welcome.players) localGame.addPlayer(p);

  // Load the player's AUTHORITATIVE floor geometry. The game booted on the
  // legacy ground floor (buildOfficeMap()); if the player's real floor differs
  // (e.g. a reconnect landed them on floor-1) we swap to it. We also do this for
  // the ground floor so its geometry comes from the active building (which may be
  // an admin-authored map), keeping render + collision in sync with the server.
  // Guarded against a stale boot: only apply while this game is still live.
  void (async () => {
    const floor = await floorGeometry(welcome.self.floorId ?? "ground");
    if (!floor || game !== localGame) return;
    localGame.setActiveFloor(floor, welcome.self, welcome.players);
    // Point the minimap at the player's actual floor (it is created below, but
    // may not exist yet if this resolves first — re-applied after mount too).
    minimap?.setFloor(floor);
    pendingMinimapFloor = floor;
  })();

  // Build the HUD now that we can wire its actions to the connection + game.
  hud = createHud(hudRoot, localStore, {
    onSetStatus: (state: SetStatusPayload["state"]) => conn.send(C2S.SET_STATUS, { state }),
    onJoinEvent: (eventId) => conn.send(C2S.JOIN_EVENT, { eventId }),
    onLeaveEvent: (eventId) => conn.send(C2S.LEAVE_EVENT, { eventId }),
    onJoinMeeting: (meetingId) => {
      conn.send(C2S.JOIN_MEETING, { meetingId });
      localStore.markMeetingJoined();
    },
    onLeaveMeeting: (_meetingId) => {
      // LEAVE_MEETING takes no payload server-side (handleLeaveMeeting ignores args).
      conn.send(C2S.LEAVE_MEETING, {});
      localStore.markMeetingLeft();
    },
    onSendChat: (text) => conn.send(C2S.CHAT, { text }),
    onChatFocus: (focused) => localGame.setInputLocked(focused),
    onLeaveGame: (gameId) => conn.send(C2S.LEAVE_GAME, { gameId }),
    onGameInput: (gameId, input) => conn.send(C2S.GAME_INPUT, { gameId, input }),
    onJoinGame: (gameId, mode) => conn.send(C2S.JOIN_GAME, { gameId, mode }),
    onLocate: (sessionId) => locate(sessionId),
    onOpenProfile: (sessionId) => openProfile(sessionId),
    isNpcHidden: () => readHideNpcs(),
    // Camera-only "Find the elevator": pan to the nearest portal on the current
    // floor. Never moves the avatar (human agency — the player walks in to ride).
    onLocateElevator: () => {
      game?.panToNearestPortal();
    },
  });

  const localHud = hud;
  storeUnsubscribe = localStore.subscribe(() => {
    localHud.render();
    minimap?.render();
  });

  // Admin console + attendance widget mount once (persist across reconnects;
  // they read the live connection lazily via getSessionId / fetch).
  if (!adminMounted) {
    createAdmin(hudRoot);
    adminMounted = true;
  }
  const liveSessionId = (): string => {
    try {
      return conn.sessionId;
    } catch {
      return "";
    }
  };

  // Attendance widget self-hides if the HR integration is absent (status 404).
  // Mount once; reusing the instance across reconnects avoids stacking widgets.
  if (!attendance) {
    attendance = mountAttendance(hudRoot, {
      fetchBase: serverHttpBase(),
      getSessionId: liveSessionId,
    });
  } else {
    void attendance.refresh();
  }

  // "Connect Google Calendar" widget self-hides if Google is not configured
  // (status 404) — integrations are optional; the office is unaffected. Mount
  // once and refresh on later reconnects (mirrors attendance/admin/settings) so
  // a WELCOME re-seed never stacks duplicate widgets.
  if (!calendarConnect) {
    calendarConnect = mountCalendarConnect(hudRoot, {
      fetchBase: serverHttpBase(),
      getSessionId: liveSessionId,
    });
  } else {
    void calendarConnect.refresh();
  }

  // --- Round features: emote bar, profile card, minimap, settings, tour -----

  // Emote bar docks beside the chat input (inside the HUD's chat region). It is
  // rebuilt with the HUD each session. We never echo locally — the bubble shows
  // when S2C.EMOTE comes back from the server (handled in the bridge).
  emoteBar = mountEmoteBar(localHud.chatBar(), {
    onEmote: (emote: Emote) => conn.send(C2S.EMOTE, { emote }),
  });

  // Profile card (per session — its Wave button emotes from the live connection).
  profileCard = mountProfileCard(hudRoot, {
    onWave: () => conn.send(C2S.EMOTE, { emote: "WAVE" }),
  });

  // Minimap (per session — binds to this store). Dots redraw on every store
  // change via the subscribe() above; clicking a dot locates (pans) the player.
  minimap = mountMinimap(hudRoot, localStore, {
    onLocate: (sessionId) => locate(sessionId),
    isNpcHidden: () => readHideNpcs(),
  });
  // If the WELCOME floor geometry already resolved (it loads concurrently above),
  // point the freshly-mounted minimap at it so it never lingers on the ground map.
  if (pendingMinimapFloor) minimap.setFloor(pendingMinimapFloor);

  // Settings popover + onboarding tour mount ONCE and persist across reconnects
  // (like admin). They read the LIVE game handle lazily through the `game` ref,
  // so a reconnect that rebuilds the game keeps them working.
  if (!settings) {
    settings = mountSettings(hudRoot, {
      onZoom: (zoom) => game?.setZoom(zoom),
      onReducedMotion: (on) => game?.setReducedMotion(on),
      onHideNpcs: (hidden) => {
        game?.setNpcVisibility(!hidden);
        // Roster + minimap read readHideNpcs() live; re-render to reflect it.
        hud?.render();
        minimap?.render();
      },
      // OPT-IN floor sync. Forward the user's consent to the server over the LIVE
      // connection. `enabled: true` may be followed by a consented S2C.FLOOR_CHANGED
      // (server moves the avatar to the detected floor) + an S2C.LOCATION tagging
      // the badge; `enabled: false` clears the tag and never moves the avatar.
      // Both are handled idempotently in the bridge below. No-op pre-connect.
      onLocationSync: (enabled) => {
        activeConn?.send(C2S.SET_LOCATION_SYNC, { enabled });
        // Turning sync off invalidates the server-side pairing code; clear the
        // one shown in Settings so a stale code is never displayed/copied.
        if (!enabled) settings?.setPairCode(null);
      },
      onShowTour: () => onboarding?.start(),
    });
  }
  if (!onboarding) {
    onboarding = mountOnboarding(hudRoot);
  }
  // Map Studio (admin building authoring) mounts once and auto-adds its own
  // floating trigger button. Self-contained: it talks to /api/maps only and
  // never touches the live game/avatars (changes apply to NEW joins). Persists
  // across reconnects like admin/settings.
  if (!mapStudio) {
    mapStudio = createMapStudio(hudRoot);
  }
  // Re-apply persisted settings to the freshly-built game handle every boot
  // (the game is recreated on each WELCOME, so zoom/motion/NPC must be re-pushed).
  settings.applyToGame();

  login.hide();

  // If we just returned from the calendar OAuth flow, confirm it once the HUD
  // (and thus the toast surface) is live. Re-querying status reflects the new
  // connected state without a manual refresh.
  if (returnedFromCalendarConnect && !calendarToastShown) {
    calendarToastShown = true;
    toasts.show(
      "Google Calendar connected — your meetings now drive your presence",
      "meeting",
    );
  }
}

// ----------------------------------------------------------------------
// Locate + profile helpers (camera-only; never move an avatar — agency rule).
// ----------------------------------------------------------------------

/** Pan the CAMERA to a player, flash their roster row, and show the follow chip
 *  (which clears on the user's next local movement). Never moves any avatar. */
function locate(sessionId: string): void {
  if (!game || !store) return;
  game.panToPlayer(sessionId);
  hud?.flashRow(sessionId);
  const p = store.get().players.get(sessionId);
  if (p) showFollowChip(p.sessionId === selfId ? "you" : p.name);
}

/** Open the profile card for a player from the live store snapshot. */
function openProfile(sessionId: string): void {
  if (!store || !profileCard) return;
  profileCard.open(store.get().players.get(sessionId));
}

// ----------------------------------------------------------------------
// S2C message bridge. Registered once per Connection in start(). Handlers are
// retained by Connection and auto re-attached after its own reconnects; they
// read the live `game`/`store`/`selfId` module refs so a re-seed (each WELCOME)
// targets the current session correctly.
// ----------------------------------------------------------------------
function registerBridge(conn: Connection): void {
  conn.on<PlayerJoinedPayload>(S2C.PLAYER_JOINED, ({ player }) => {
    if (!game || !store) return;
    store.upsertPlayer(player);
    game.addPlayer(player);
    toasts.show(`${player.name} joined the office.`, "info");
  });

  conn.on<PlayerLeftPayload>(S2C.PLAYER_LEFT, ({ sessionId }) => {
    if (!game || !store) return;
    store.removePlayer(sessionId);
    game.removePlayer(sessionId);
  });

  conn.on<PlayerUpdatedPayload>(S2C.PLAYER_UPDATED, ({ sessionId, name, department, avatarId }) => {
    if (!game || !store) return;
    const p = store.get().players.get(sessionId);
    if (p) store.upsertPlayer({ ...p, name, department, avatarId });
    game.updatePlayer(sessionId, { name, department, avatarId });
  });

  conn.on<PlayerMovedPayload>(S2C.PLAYER_MOVED, ({ sessionId, x, y, dir, moving }) => {
    if (!game || !store) return;
    if (sessionId === selfId) return; // local avatar is authoritative client-side
    store.movePlayer(sessionId, x, y, dir, moving);
    game.movePlayer(sessionId, x, y, dir, moving);
  });

  conn.on<PlayerTeleportedPayload>(S2C.PLAYER_TELEPORTED, ({ sessionId, x, y }) => {
    if (!game || !store) return;
    store.teleportPlayer(sessionId, x, y);
    game.teleportPlayer(sessionId, x, y); // may target self (after a Join click)
  });

  conn.on<PresencePayload>(S2C.PRESENCE, ({ sessionId, state, source }) => {
    if (!game || !store) return;
    store.setPresence(sessionId, state, source);
    game.setPresence(sessionId, state);
  });

  conn.on<ChatBroadcastPayload>(S2C.CHAT, ({ sessionId, name, text }) => {
    if (!game) return;
    game.showChatBubble(sessionId, text);
    if (sessionId !== selfId) toasts.show(`${name}: ${text}`, "info");
  });

  // Emote broadcast (includes the sender): the game pops a bubble over the
  // emoting player's avatar. No local echo needed — this single path covers
  // self + everyone (presence, not surveillance: ephemeral, nothing stored).
  conn.on<EmoteBroadcastPayload>(S2C.EMOTE, ({ sessionId, emote }) => {
    game?.showEmote(sessionId, emote);
  });

  conn.on<EventCreatedPayload>(S2C.EVENT_CREATED, ({ event }) => {
    store?.upsertEvent(event);
  });
  conn.on<EventUpdatedPayload>(S2C.EVENT_UPDATED, ({ event }) => {
    store?.upsertEvent(event);
  });
  conn.on<EventEndedPayload>(S2C.EVENT_ENDED, ({ eventId }) => {
    store?.removeEvent(eventId);
  });

  conn.on<MeetingStartedPayload>(S2C.MEETING_STARTED, ({ meeting }) => {
    // Agency rule: show the Join button, NEVER auto-teleport.
    store?.setMeeting(meeting);
    toasts.show(`Meeting starting: ${meeting.title}. Click Join when ready.`, "meeting");
  });
  conn.on<MeetingEndedPayload>(S2C.MEETING_ENDED, ({ meetingId }) => {
    store?.clearMeeting(meetingId);
    toasts.show("Your meeting has ended.", "meeting");
  });

  conn.on<ToastPayload>(S2C.TOAST, ({ message, kind }) => {
    toasts.show(message, kind);
  });

  conn.on<GameUpdatePayload>(S2C.GAME_UPDATE, ({ game }) => {
    if (!store) return;
    store.setGame(game);
  });

  // OPT-IN physical-location tag changed for a co-located player (floor-scoped).
  // Branch on `cleared` FIRST: a cleared event means sync was turned OFF — drop the
  // badge (set place to absent), NEVER show "Remote" (the place hint on a cleared
  // event is a legacy fallback only). Otherwise apply the Office/Remote tag. For
  // SELF this is the confirmation the toggle took effect; turning sync off makes the
  // badge disappear immediately (honest + revocable). A consented floor move (when
  // enabling resolves to a different OFFICE floor) arrives as a separate
  // S2C.FLOOR_CHANGED, handled identically to an elevator crossing above.
  conn.on<LocationPayload>(S2C.LOCATION, ({ sessionId, place, cleared }) => {
    if (!store) return;
    store.setPlace(sessionId, cleared ? undefined : place);
  });

  // Companion PAIRING CODE for THIS session (sent right after we enabled floor
  // sync). Surface it in Settings: the WiFi help block then shows the exact
  // companion command WITH the code, so a floor report is tied to this session
  // regardless of IP (NAT / VPN / Docker / multiple localhost tabs). Transient
  // per-session — never persisted.
  conn.on<FloorSyncCodePayload>(S2C.FLOOR_SYNC_CODE, ({ code }) => {
    settings?.setPairCode(code);
  });

  // Floor change: sent ONLY to the player whose own avatar stepped onto a portal
  // (human agency — the server never moves anyone automatically). Rebuild the
  // floor view from the payload: swap the rendered world to the new floor, reset
  // the roster to the destination floor's occupants, and update the floor
  // indicator. The other floors' occupants learned of the crossing via
  // PLAYER_LEFT (old floor) / PLAYER_JOINED (new floor).
  conn.on<FloorChangedPayload>(S2C.FLOOR_CHANGED, (payload) => {
    if (!game || !store) return;
    const localGame = game;
    const localStore = store;

    // The destination self snapshot: start from the known self, override floor +
    // position with the server's authoritative values for the new floor.
    const prevSelf = localStore.self();
    const self: PlayerSnapshot = {
      ...(prevSelf ?? localStore.get().players.get(selfId)!),
      sessionId: selfId,
      floorId: payload.selfFloorId,
      x: payload.x,
      y: payload.y,
      dir: payload.dir,
    };

    // Reset the store roster to exactly the new floor's occupants (self + others).
    // The roster is floor-scoped server-side, so we drop everyone we knew (all on
    // the OLD floor) and re-seed from the FLOOR_CHANGED set.
    for (const id of [...localStore.get().players.keys()]) {
      if (id !== selfId) localStore.removePlayer(id);
    }
    localStore.upsertPlayer(self);
    for (const p of payload.players) localStore.upsertPlayer(p);

    // Reset events to the destination floor's active events (events are per-floor).
    for (const id of [...localStore.get().events.keys()]) localStore.removeEvent(id);
    for (const ev of payload.events) localStore.upsertEvent(ev);

    // Track the new floor for the HUD indicator (display-only).
    localStore.setSelfFloor(payload.selfFloorId);

    // Locate/follow chip would now point at a player on the old floor — clear it.
    clearFollowChip();

    // Swap the rendered world to the new floor's geometry. The scene tears down
    // every avatar and rebuilds self + others; it NEVER auto-walks (the server
    // already committed the crossing from the player's own step).
    void (async () => {
      const floor = await floorGeometry(payload.selfFloorId);
      if (game !== localGame) return; // a reconnect re-booted under us
      if (floor) {
        localGame.setActiveFloor(floor, self, payload.players);
        // Swap the minimap to the destination floor's geometry so it never shows
        // the wrong floor after an elevator crossing.
        minimap?.setFloor(floor);
        pendingMinimapFloor = floor;
      }
    })();
  });
}

/** Tear down the per-session game/HUD/store (used on reconnect + on offline). */
function teardownSession(): void {
  storeUnsubscribe?.();
  storeUnsubscribe = null;
  attendance?.destroy();
  attendance = null;
  calendarConnect?.destroy();
  calendarConnect = null;
  // Per-session round widgets (emote bar lives inside the HUD's chat region, so
  // destroy it before the HUD; the profile card + minimap are HUD-root siblings).
  emoteBar?.destroy();
  emoteBar = null;
  profileCard?.destroy();
  profileCard = null;
  minimap?.destroy();
  minimap = null;
  clearFollowChip();
  hud?.destroy();
  hud = null;
  if (game) {
    game.destroy();
    game = null;
  }
  store = null;
}

/** Full teardown when the connection is gone for good (return to login). */
function teardown(): void {
  teardownSession();
}

function serverDownMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/refused|failed|network|ECONNREFUSED|WebSocket/i.test(msg)) {
    return "Could not reach the office server. Is it running on :2567?";
  }
  return msg || "Could not join the office.";
}
