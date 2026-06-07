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
    void boot(conn, welcome);
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

  selfId = welcome.self.sessionId;
  const localStore = new Store(selfId);
  store = localStore;

  // Seed the store from WELCOME (self first, then others, events, meeting).
  localStore.upsertPlayer(welcome.self);
  for (const p of welcome.players) localStore.upsertPlayer(p);
  for (const ev of welcome.events) localStore.upsertEvent(ev);
  if (welcome.meeting) localStore.setMeeting(welcome.meeting);

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
  attendance = mountAttendance(hudRoot, {
    fetchBase: serverHttpBase(),
    getSessionId: liveSessionId,
  });

  // "Connect Google Calendar" widget self-hides if Google is not configured
  // (status 404) — integrations are optional; the office is unaffected.
  calendarConnect = mountCalendarConnect(hudRoot, {
    fetchBase: serverHttpBase(),
    getSessionId: liveSessionId,
  });

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
      onShowTour: () => onboarding?.start(),
    });
  }
  if (!onboarding) {
    onboarding = mountOnboarding(hudRoot);
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
