// ---------------------------------------------------------------------------
// Wire protocol between client and server (Colyseus message-based).
// This file is the single source of truth — both sides import from here.
// ---------------------------------------------------------------------------

import type {
  AvatarId,
  Department,
  Direction,
  Emote,
  MeetingInfo,
  PlayerSnapshot,
  PresenceSource,
  PresenceState,
  SocialEvent,
  ActiveGame,
  WhiteboardElement,
} from "./types";

export const ROOM_NAME = "office";
export const DEFAULT_SERVER_PORT = 2567;

// ---------------------------- client -> server ----------------------------

export const C2S = {
  MOVE: "move",
  SET_STATUS: "set-status",
  CHAT: "chat",
  EMOTE: "emote",
  JOIN_EVENT: "join-event",
  LEAVE_EVENT: "leave-event",
  JOIN_MEETING: "join-meeting",
  LEAVE_MEETING: "leave-meeting",
  JOIN_GAME: "join-game",
  LEAVE_GAME: "leave-game",
  GAME_INPUT: "game-input",
  /** Edit own profile (name / department / avatar) from the profile modal. */
  UPDATE_PROFILE: "update-profile",
  /**
   * OPT-IN physical-floor sync toggle. The user explicitly turns this ON in
   * Settings to let the server tag them OFFICE/REMOTE from their IP (and, when
   * OFFICE, move them to the detected floor). OFF by default. See
   * SetLocationSyncPayload + S2C.LOCATION + docs/FLOOR-LOCATION-CONTRACT.md.
   */
  SET_LOCATION_SYNC: "set-location-sync",
  /** Ring a player anywhere in the office (or pull them into the call you are in). */
  CALL_INVITE: "call-invite",
  /** Answer a ring: accept / reject / switch (drop current) / merge (one call). */
  CALL_ANSWER: "call-answer",
  /** Join an OPEN meeting-room call while standing in that room. */
  CALL_JOIN: "call-join",
  /** Start a meeting-room call and ring everyone else standing in that room. */
  CALL_START_ROOM: "call-start-room",
  /** Leave a call (or cancel a ring you started). */
  CALL_LEAVE: "call-leave",
  /**
   * Opaque WebRTC SIGNALING (SDP offer/answer + ICE candidates) relayed to one
   * co-located peer. The `data` blob is opaque to the server — media never
   * touches it (P2P mesh). Relayed as S2C.RTC_SIGNAL. See RtcSignalC2S.
   */
  RTC_SIGNAL: "rtc-signal",
  /** Subscribe to a department whiteboard (server replies S2C.WHITEBOARD_STATE). */
  WHITEBOARD_OPEN: "wb-open",
  /** Unsubscribe from a department whiteboard. */
  WHITEBOARD_CLOSE: "wb-close",
  /** Push changed Excalidraw elements to a department whiteboard (broadcast). */
  WHITEBOARD_UPDATE: "wb-update",
  /** Clear a department whiteboard (broadcast to viewers). */
  WHITEBOARD_CLEAR: "wb-clear",
} as const;

/** Options sent when joining the room (dev auth profile). */
export interface JoinOptions {
  name: string;
  department: Department;
  avatarId: AvatarId;
}

/** Sent on every committed tile step and when the avatar stops. */
export interface MovePayload {
  x: number; // tile coords
  y: number;
  dir: Direction;
  moving: boolean;
}

/** Manual status selection. AVAILABLE clears the manual override. */
export interface SetStatusPayload {
  state: "AVAILABLE" | "FOCUS" | "BREAK" | "AWAY";
}

export interface ChatPayload {
  text: string;
}

export interface EmotePayload {
  emote: Emote;
}

export interface JoinEventPayload {
  eventId: string;
}

export interface JoinMeetingPayload {
  meetingId: string;
}

/** Edit the sender's own profile; each field optional, only valid ones apply. */
export interface UpdateProfilePayload {
  name?: string;
  department?: Department;
  avatarId?: AvatarId;
}

/**
 * Toggle OPT-IN physical-floor sync (C2S.SET_LOCATION_SYNC).
 *
 * `enabled: true`  — the user consents: the server classifies their IP
 *   (OFFICE/REMOTE), broadcasts S2C.LOCATION (floor-scoped), and — ONLY if the
 *   classification is OFFICE and the IP maps to a real floor different from the
 *   user's current one — performs the SAME server-side floor change the elevator
 *   uses (a normal S2C.FLOOR_CHANGED follows). This movement is consented (the
 *   user flipped the switch), never employer-forced surveillance.
 * `enabled: false` — sync off: the server clears the user's `place` back to
 *   absent, broadcasts a "cleared" S2C.LOCATION (see LocationPayload), and NEVER
 *   moves the avatar. The game then behaves exactly as if sync were never on.
 *
 * When no office subnets are configured server-side (the zero-config default),
 * enabling sync still works but always classifies REMOTE (no office to match).
 */
export interface SetLocationSyncPayload {
  enabled: boolean;
}

// ---------------------------- server -> client ----------------------------

export const S2C = {
  WELCOME: "welcome",
  PLAYER_JOINED: "player-joined",
  PLAYER_LEFT: "player-left",
  PLAYER_MOVED: "player-moved",
  PLAYER_TELEPORTED: "player-teleported",
  PRESENCE: "presence",
  CHAT: "chat",
  EMOTE: "emote",
  EVENT_CREATED: "event-created",
  EVENT_UPDATED: "event-updated",
  EVENT_ENDED: "event-ended",
  /**
   * Sent ONLY to a player after THEIR OWN avatar stepped onto a portal tile and
   * the server moved them to another floor (human agency: never automatic). It
   * carries the new floor id + the full set of players already on that floor so
   * the client can re-render the world. PLAYER_JOINED/LEFT inform the two
   * floors' other occupants of the crossing.
   */
  FLOOR_CHANGED: "floor-changed",
  MEETING_STARTED: "meeting-started",
  MEETING_ENDED: "meeting-ended",
  TOAST: "toast",
  GAME_UPDATE: "game-update",
  /** A player changed their name / department / avatar (profile edit). */
  PLAYER_UPDATED: "player-updated",
  /**
   * A player's OPT-IN physical-location tag changed (they toggled floor sync).
   * Broadcast FLOOR-SCOPED like the other per-player updates. See LocationPayload
   * for how an OFF/"cleared" state is represented. Turning sync ON may be FOLLOWED
   * by a normal S2C.FLOOR_CHANGED if the detected floor differs (consented);
   * turning it OFF clears the tag and NEVER moves the avatar.
   */
  LOCATION: "location",
  /**
   * A short, human-typable PAIRING CODE for the companion floor-sync helper.
   * Sent ONLY to a client right after THAT client enables floor sync
   * (C2S.SET_LOCATION_SYNC{enabled:true}), and re-sent on (re)join when the
   * session is already enabled. The user pastes this code into the companion
   * (FLOOR_SYNC_PAIR_CODE); the companion includes it as body.pairCode in its
   * POST /api/location/floor-report so the server can tie the report to THIS
   * exact session regardless of IP — fixing NAT / Docker / localhost multi-tab
   * collisions where the IP match is ambiguous. See FloorSyncCodePayload.
   *
   * PRIVACY: the code maps ONLY to {sessionId,userId} in transient in-memory
   * state with a TTL; it is never logged or persisted, and is invalidated on
   * disable / leave. There is no new C2S message for this.
   */
  FLOOR_SYNC_CODE: "floor-sync-code",
  /** Someone is calling you (see CallRingS2C). */
  CALL_RING: "call-ring",
  /** The roster of the call you are in changed (see CallStateS2C). */
  CALL_STATE: "call-state",
  /** A call you were in / invited to is over for you (see CallEndedS2C). */
  CALL_ENDED: "call-ended",
  /** The meeting room you are standing in: who is here + any open room call. */
  ROOM_CALL: "room-call",
  /** Relayed WebRTC signaling from a co-located peer (see RtcSignalS2C). */
  RTC_SIGNAL: "rtc-signal",
  /** Full current state of a whiteboard, sent to a client when it opens one. */
  WHITEBOARD_STATE: "wb-state",
  /** A chunk of the full whiteboard state (for large boards). */
  WHITEBOARD_STATE_CHUNK: "wb-state-chunk",
  /** Changed elements another viewer made on a whiteboard. */
  WHITEBOARD_UPDATE: "wb-update",
  /** A whiteboard was cleared by a viewer. */
  WHITEBOARD_CLEAR: "wb-clear",
} as const;

export interface WhiteboardStateChunkS2C {
  board: string;
  chunkIndex: number;
  totalChunks: number;
  elements: WhiteboardElement[];
}

/**
 * The pairing code for the companion floor-sync helper (S2C.FLOOR_SYNC_CODE).
 * Backward-compatible additive message: older clients ignore the unknown type
 * (the room's "*" handler also tolerates it the other direction). The client
 * stores `code` and surfaces it in Settings as the exact companion command.
 */
export interface FloorSyncCodePayload {
  /** A short, human-typable pairing code (e.g. 6 chars A-Z0-9). */
  code: string;
}

/** A floor's identity as advertised to the client (no geometry — fetched via /api/maps). */
export interface FloorSummary {
  id: string;
  name: string;
  index: number;
}

/** The active building, summarized for the client (floor list, ordered by index). */
export interface BuildingSummary {
  id: string;
  name: string;
  floors: FloorSummary[];
}

export interface WelcomePayload {
  self: PlayerSnapshot;
  /**
   * All OTHER players currently ON THE SELF PLAYER'S FLOOR (self excluded).
   * Floor-scoped: the client only ever knows about co-located players. When a
   * player changes floors a FLOOR_CHANGED message replaces this set.
   */
  players: PlayerSnapshot[];
  /** Currently active social events (scoped to the self player's floor). */
  events: SocialEvent[];
  /** The local user's current meeting, if one is already in progress. */
  meeting: MeetingInfo | null;
  /**
   * The active building summary (floor list). OPTIONAL/backward-compatible: a
   * pre-multifloor client ignores it; a multifloor client renders the floor
   * picker from it. The current floor is `self.floorId`; full floor geometry is
   * fetched from `GET /api/maps/active`.
   */
  building?: BuildingSummary;
}

/**
 * Sent to a player after their OWN movement carried them through a portal. The
 * client tears down its current floor view and rebuilds from this payload. Other
 * players learn of the crossing via PLAYER_LEFT (old floor) + PLAYER_JOINED
 * (new floor). Human agency: only ever follows the player's own committed step.
 */
export interface FloorChangedPayload {
  /** The player's new floor id (matches self.floorId going forward). */
  selfFloorId: string;
  /** The player's new tile position on the destination floor. */
  x: number;
  y: number;
  dir: Direction;
  /** All OTHER players currently on the destination floor (self excluded). */
  players: PlayerSnapshot[];
  /** Active social events on the destination floor. */
  events: SocialEvent[];
}

export interface PlayerJoinedPayload {
  player: PlayerSnapshot;
}

export interface PlayerLeftPayload {
  sessionId: string;
}

/**
 * A player's OPT-IN physical-location tag changed (S2C.LOCATION). Broadcast
 * FLOOR-SCOPED (only co-located clients hear it), and also carried inline on
 * WELCOME/PLAYER_JOINED snapshots (PlayerSnapshot.place) so the badge shows
 * immediately on first paint.
 *
 * Representing OFF / "cleared":
 *   - `place: "OFFICE" | "REMOTE"` is sent while sync is ON.
 *   - When the user turns sync OFF the server sends `cleared: true` (and a
 *     best-effort `place: "REMOTE"` for older clients). On `cleared`, the client
 *     MUST treat the player's `place` as ABSENT (remove the badge) — do NOT show
 *     "Remote". The authoritative snapshot's `place` becomes undefined.
 */
export interface LocationPayload {
  sessionId: string;
  /** The current tag while sync is ON. On a cleared event this is the legacy hint only. */
  place: "OFFICE" | "REMOTE";
  /** True when sync was turned OFF: clear the badge (treat place as absent). */
  cleared?: boolean;
}

/** A player's display profile changed (name / department / avatar). */
export interface PlayerUpdatedPayload {
  sessionId: string;
  name: string;
  department: Department;
  avatarId: AvatarId;
}

export interface PlayerMovedPayload {
  sessionId: string;
  x: number;
  y: number;
  dir: Direction;
  moving: boolean;
}

/** Server moved a player instantly (e.g. user clicked Join on an event/meeting). */
export interface PlayerTeleportedPayload {
  sessionId: string;
  x: number;
  y: number;
}

export interface PresencePayload {
  sessionId: string;
  state: PresenceState;
  source: PresenceSource;
}

export interface ChatBroadcastPayload {
  sessionId: string;
  name: string;
  text: string;
}

export interface EmoteBroadcastPayload {
  sessionId: string;
  emote: Emote;
}

export interface EventCreatedPayload {
  event: SocialEvent;
}

export interface EventUpdatedPayload {
  event: SocialEvent;
}

export interface EventEndedPayload {
  eventId: string;
}

/** Sent only to participants. Client shows a "Join Meeting" button — NEVER auto-teleports. */
export interface MeetingStartedPayload {
  meeting: MeetingInfo;
}

export interface MeetingEndedPayload {
  meetingId: string;
}

export interface ToastPayload {
  message: string;
  kind: "info" | "event" | "meeting" | "broadcast";
}

export interface JoinGamePayload {
  gameId: string;
  /**
   * Pool only: how to start the game when the sender is the FIRST to join an idle
   * pool table. OPTIONAL and backward-compatible:
   *   - "ai"   => start immediately as SOLO vs the server AI (the AI takes seat 2).
   *   - "group" (or absent) => wait for a second human, exactly like the other
   *     lounge games. A later joiner takes seat 2; further joiners spectate.
   * Ignored by non-pool games and by joiners who are not seat 1.
   */
  mode?: "ai" | "group";
}

export interface LeaveGamePayload {
  gameId: string;
}

export interface GameInputPayload {
  gameId: string;
  input: any;
}

export interface GameUpdatePayload {
  game: ActiveGame;
}

// ------------------------------- calls -------------------------------------
// Voice/video CALL SESSIONS. A session is a roster (participants + pending
// invites), owned by the server, reachable from anywhere in the office (no
// distance/floor gate). Media never touches the game server: it flows over
// LiveKit when configured, else a P2P mesh signalled through RTC_SIGNAL.
// PRIVACY (Constitution): the server never logs who called whom, for how long,
// or anything about call content.

/** What media a call carries. */
export type RtcCallKind = "audio" | "video";

/** A participant as the UI needs it (name resolved server-side). */
export interface CallParticipantInfo {
  sessionId: string;
  name: string;
}

export interface CallInviteC2S {
  /** Target player's sessionId (any floor, must be a human). */
  to: string;
  kind: RtcCallKind;
}

/**
 * accept — take the call (only valid when you are not already in one)
 * reject — decline
 * switch — leave your current call, then take this one
 * merge  — fold this call's people into the call you are already in
 */
export type CallAnswer = "accept" | "reject" | "switch" | "merge";

export interface CallAnswerC2S {
  callId: string;
  answer: CallAnswer;
}

export interface CallJoinC2S {
  callId: string;
}

export interface CallStartRoomC2S {
  /** Meeting-room area name the sender is standing in. */
  roomName: string;
  kind: RtcCallKind;
}

export interface CallLeaveC2S {
  callId: string;
}

export interface CallRingS2C {
  callId: string;
  from: string;
  fromName: string;
  kind: RtcCallKind;
  /** Who is already in that call (so the card can read "Alice + 2 others"). */
  participants: CallParticipantInfo[];
}

export interface CallStateS2C {
  callId: string;
  kind: RtcCallKind;
  /** Everyone who has joined, including the recipient. */
  participants: CallParticipantInfo[];
  /** Invited, not yet answered (the caller's "Ringing…" line). */
  pending: CallParticipantInfo[];
  /** Set when this call is bound to a meeting room (open to that room's occupants). */
  roomName?: string;
}

export type CallEndReason = "left" | "rejected" | "cancelled" | "empty";

export interface CallEndedS2C {
  callId: string;
  reason: CallEndReason;
}

/**
 * The meeting room the RECIPIENT is standing in (per-recipient, not a broadcast).
 * `roomName: null` means "not in a meeting room" and clears the client's card.
 */
export interface RoomCallS2C {
  roomName: string | null;
  floorId: string | null;
  /** Humans currently standing in that room, including the recipient. */
  occupants: CallParticipantInfo[];
  /** The open call bound to this room, or null when nobody started one. */
  callId: string | null;
  kind?: RtcCallKind;
  /** True when the recipient is already a participant of `callId`. */
  joined: boolean;
}

/** C2S: opaque WebRTC signaling blob relayed to a peer in the SAME call. */
export interface RtcSignalC2S {
  to: string;
  /** Opaque to the server: `{ sdp }` or `{ candidate }`. */
  data: unknown;
}

/** S2C: relayed WebRTC signaling blob, with the originator identified. */
export interface RtcSignalS2C {
  from: string;
  data: unknown;
}

// ------------------------------- whiteboard --------------------------------
// Per-department collaborative whiteboards backed by Excalidraw. `board` is a
// Department name. The server stores the latest version of each element
// in-memory and relays changes to everyone currently viewing the same board
// (department-scoped, NOT floor-scoped — a team spans floors).

/** C2S: open (subscribe to) / close a department board. */
export interface WhiteboardOpenC2S {
  board: string;
}
export interface WhiteboardCloseC2S {
  board: string;
}

/** C2S: push the elements that changed locally (added/edited/deleted). */
export interface WhiteboardUpdateC2S {
  board: string;
  elements: WhiteboardElement[];
}

/** C2S: clear a board. */
export interface WhiteboardClearC2S {
  board: string;
}

/** S2C: the full current element set of a board (sent to the opener). */
export interface WhiteboardStateS2C {
  board: string;
  elements: WhiteboardElement[];
}

/** S2C: elements another viewer changed (added/edited/deleted). */
export interface WhiteboardUpdateS2C {
  board: string;
  elements: WhiteboardElement[];
}

/** S2C: a board was cleared. */
export interface WhiteboardClearS2C {
  board: string;
}
