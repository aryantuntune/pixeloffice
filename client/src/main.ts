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
  type EventCreatedPayload,
  type EventEndedPayload,
  type EventUpdatedPayload,
  type MeetingEndedPayload,
  type MeetingStartedPayload,
  type PlayerJoinedPayload,
  type PlayerLeftPayload,
  type PlayerMovedPayload,
  type PlayerTeleportedPayload,
  type PresencePayload,
  type SetStatusPayload,
  type ToastPayload,
  type WelcomePayload,
} from "@pixeloffice/shared";
import { Connection, serverHttpBase } from "./net/connection";
import { createOfficeGame, type OfficeGameHandle } from "./game";
import { Store } from "./ui/state";
import { createLogin, type JoinSubmission } from "./ui/login";
import { createHud, type HudHandle } from "./ui/hud";
import { Toasts } from "./ui/toasts";
import { createAdmin } from "./ui/admin";
import { mountConnectionBanner } from "./ui/connection-banner";
import { mountAttendance, type AttendanceWidgetHandle } from "./ui/attendance";

const gameRoot = document.getElementById("game-root")!;
const hudRoot = document.getElementById("hud-root")!;
const loginRoot = document.getElementById("login-root")!;

const toasts = new Toasts(hudRoot);
const banner = mountConnectionBanner(hudRoot);

const login = createLogin({
  parent: loginRoot,
  onSubmit: (opts) => void start(opts),
});

// Live UI handles for the current session. Recreated on each (re)boot so a
// reconnect (fresh sessionId) starts from the server's authoritative truth.
let game: OfficeGameHandle | null = null;
let hud: HudHandle | null = null;
let attendance: AttendanceWidgetHandle | null = null;
let store: Store | null = null;
let storeUnsubscribe: (() => void) | null = null;
let adminMounted = false;
let selfId = ""; // current sessionId; refreshed on every WELCOME

async function start(opts: JoinSubmission): Promise<void> {
  const conn = new Connection();

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
    },
    onAreaChange: (areaName) => localStore.setSelfArea(areaName),
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
  });

  const localHud = hud;
  storeUnsubscribe = localStore.subscribe(() => localHud.render());

  // Admin console + attendance widget mount once (persist across reconnects;
  // they read the live connection lazily via getSessionId / fetch).
  if (!adminMounted) {
    createAdmin(hudRoot);
    adminMounted = true;
  }
  // Attendance widget self-hides if the HR integration is absent (status 404).
  attendance = mountAttendance(hudRoot, {
    fetchBase: serverHttpBase(),
    getSessionId: () => {
      try {
        return conn.sessionId;
      } catch {
        return "";
      }
    },
  });

  login.hide();

  // ----------------------------------------------------------------------
  // S2C message bridge. Handlers are RETAINED by Connection and auto re-attached
  // after a reconnect — register them ONCE (guarded below). They read the live
  // `game`/`store`/`selfId` module refs so a reconnect rebind targets the new
  // session correctly.
  // ----------------------------------------------------------------------
  registerBridge(conn);
}

let bridgeRegistered = false;

function registerBridge(conn: Connection): void {
  if (bridgeRegistered) return;
  bridgeRegistered = true;

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
}

/** Tear down the per-session game/HUD/store (used on reconnect + on offline). */
function teardownSession(): void {
  storeUnsubscribe?.();
  storeUnsubscribe = null;
  attendance?.destroy();
  attendance = null;
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
