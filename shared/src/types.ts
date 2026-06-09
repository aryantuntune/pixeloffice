// ---------------------------------------------------------------------------
// Domain types shared between server and client. Framework-free by design.
// ---------------------------------------------------------------------------

export enum PresenceState {
  AVAILABLE = "AVAILABLE",
  IN_MEETING = "IN_MEETING",
  FOCUS = "FOCUS",
  BREAK = "BREAK",
  AWAY = "AWAY",
  OFFLINE = "OFFLINE",
}

/** Where a presence state came from. Used for transparency in the UI. */
export type PresenceSource = "MANUAL" | "CALENDAR" | "EVENT" | "AUTO" | "SYSTEM";

export type Direction = "up" | "down" | "left" | "right";

export const DEPARTMENTS = ["Engineering", "Product", "Design", "HR"] as const;
export type Department = (typeof DEPARTMENTS)[number];

export const AVATAR_IDS = ["ruby", "sapphire", "emerald", "amber", "violet", "slate"] as const;
export type AvatarId = (typeof AVATAR_IDS)[number];

/** A player as the wire protocol sees them. Coordinates are TILE coordinates. */
export interface PlayerSnapshot {
  sessionId: string;
  userId: string;
  name: string;
  department: Department;
  avatarId: AvatarId;
  x: number;
  y: number;
  dir: Direction;
  presence: PresenceState;
  source: PresenceSource;
  /**
   * The floor this player is currently on (Building.floors[].id, e.g. "ground").
   * The server ALWAYS sets this going forward; it is the migration field for
   * multi-floor support. Declared OPTIONAL only for backward compatibility so
   * pre-multifloor snapshot literals (tests, fixtures) still type-check — any
   * consumer that omits it should treat an absent value as the ground floor
   * ("ground"). The wire always carries a concrete floorId.
   */
  floorId?: string;
  /**
   * The user's OPT-IN physical-location tag, derived SERVER-SIDE from the client
   * IP only (never the WiFi SSID — browsers cannot read it). OPTIONAL and fully
   * backward-compatible:
   *   - absent  => the user has NOT enabled floor sync (the default), OR sync was
   *                turned off. Render no location badge.
   *   - "OFFICE" => the IP fell inside a configured office subnet/CIDR.
   *   - "REMOTE" => the IP did not match any office range (working from home).
   *
   * This is ORTHOGONAL to `presence` (PresenceState): a person can be AVAILABLE
   * AND "OFFICE", FOCUS AND "REMOTE", etc. The two never imply or override each
   * other — `place` says WHERE the user physically is, `presence` says what they
   * are DOING. The tag is set ONLY when the user explicitly enables sync and is
   * cleared (back to absent) when they turn it off; it is never employer-forced.
   *
   * PRIVACY (plan.md "presence, not surveillance"): the server stores ONLY this
   * transient tag + the current floor. It NEVER persists or logs the IP, and
   * NEVER keeps a location history / movement trace / who-was-where-when.
   */
  place?: "OFFICE" | "REMOTE";
  /**
   * True for ambient, server-driven office NPCs (not real users). OPTIONAL and
   * backward-compatible: absent/false means a human player. The client may use
   * it to label/hide NPCs; the server uses it to exclude them from human-only
   * paths (HR session resolution, leave handling, etc.). NPCs never join
   * meetings, never touch HR, and never respond to humans (ambience only).
   */
  isNpc?: boolean;
}

export const SOCIAL_EVENT_TYPES = [
  "COFFEE_BREAK",
  "TEA_BREAK",
  "TEAM_GATHERING",
  "TOWN_HALL",
] as const;
export type SocialEventType = (typeof SOCIAL_EVENT_TYPES)[number];

export interface SocialEvent {
  id: string;
  type: SocialEventType;
  title: string;
  /** Office area the event takes place in (must match an Area name in map.ts). */
  areaName: string;
  startTime: number; // epoch ms
  endTime: number; // epoch ms
  participantIds: string[]; // sessionIds of joined players
}

/** Maps a social event type to the office area where it happens. */
export const EVENT_AREA: Record<SocialEventType, string> = {
  COFFEE_BREAK: "Coffee Area",
  TEA_BREAK: "Coffee Area",
  TEAM_GATHERING: "Lounge",
  TOWN_HALL: "Reception",
};

export interface MeetingInfo {
  id: string;
  title: string;
  startTime: number; // epoch ms
  endTime: number; // epoch ms
  /** Stable user identities (identity.userId) invited. Empty array = everyone in the office. */
  participantIds: string[];
  /** "Meeting Room A" | "Meeting Room B" | "Meeting Room C" */
  roomName: string;
  /**
   * Video-call join link (e.g. a Google Meet URL) for this meeting, when the
   * source calendar event carries one. OPTIONAL and backward-compatible: absent
   * means there is no link to surface. The client renders a "Join" anchor that
   * opens it in a NEW TAB only on an explicit user click (human-agency rule) —
   * an avatar is never auto-teleported or auto-redirected.
   */
  meetLink?: string;
}

/**
 * Lightweight, ephemeral emotes a player can pop over their own avatar. These
 * are pure social expression (presence, not surveillance): the server treats an
 * emote as activity and fans it out to everyone, but stores nothing. OPTIONAL
 * and backward-compatible — an older client that never sends one is unaffected.
 */
export const EMOTES = ["WAVE", "THUMBS_UP", "COFFEE", "HEART"] as const;
export type Emote = (typeof EMOTES)[number];
export const EMOTE_EMOJI: Record<Emote, string> = {
  WAVE: "👋",
  THUMBS_UP: "👍",
  COFFEE: "☕",
  HEART: "❤️",
};

/** Display metadata for presence states (single source of truth for UI colors). */
export const PRESENCE_META: Record<PresenceState, { label: string; color: string; emoji: string }> = {
  [PresenceState.AVAILABLE]: { label: "Available", color: "#3ecf6e", emoji: "" },
  [PresenceState.IN_MEETING]: { label: "In Meeting", color: "#e5544b", emoji: "📅" },
  [PresenceState.FOCUS]: { label: "Focus", color: "#8a63e8", emoji: "🎧" },
  [PresenceState.BREAK]: { label: "Break", color: "#e8a13c", emoji: "☕" },
  [PresenceState.AWAY]: { label: "Away", color: "#9aa3ad", emoji: "💤" },
  [PresenceState.OFFLINE]: { label: "Offline", color: "#5b6470", emoji: "" },
};

// ---------------------------------------------------------------------------
// Whiteboard — one collaborative board PER DEPARTMENT (the board key is the
// Department name), backed by Excalidraw. The wire unit is an Excalidraw
// element kept OPAQUE here: we only depend on `id` + `version` (+ `versionNonce`
// for tie-breaks, `isDeleted` for tombstones) to reconcile concurrent edits.
// Everything else passes through untouched so older clients keep compiling.
// Framework-free + serializable.
// ---------------------------------------------------------------------------
export interface WhiteboardElement {
  /** Excalidraw element id (stable across edits). */
  id: string;
  /** Monotonic edit counter Excalidraw bumps on every change (reconcile key). */
  version: number;
  /** Random tiebreaker when two edits share a version (last-writer-wins). */
  versionNonce?: number;
  /** Tombstone flag — a deleted element is kept so the deletion syncs. */
  isDeleted?: boolean;
  /** All other Excalidraw element fields (type, points, x, y, …) pass through. */
  [key: string]: unknown;
}

export type GameType = "ping-pong" | "tic-tac-toe" | "connect-four" | "pool";

export interface GamePlayer {
  sessionId: string;
  name: string;
  avatarId: string;
}

// ---------------------------------------------------------------------------
// 8-Ball Pool (server-authoritative).
//
// COORDINATE SPACE — TABLE-LOCAL, fixed-size, units = "table units" (tu):
//   - Origin (0,0) is the TOP-LEFT inside corner of the playfield.
//   - The playfield is POOL_TABLE_W x POOL_TABLE_H tu (x rightward, y downward —
//     same screen convention as the rest of the app). It is a fixed 2:1 board.
//   - All ball/pocket positions + velocities are in these units. The client
//     scales tu -> pixels when it renders (documented in POOL-CONTRACT.md).
//   - Deterministic: the physics never reads a clock or Math.random — it takes a
//     seeded PRNG only for the AI's aim noise. A shot is simulated to REST and
//     the final PoolState (+ a per-step trajectory) is broadcast for animation.
// ---------------------------------------------------------------------------

/** Fixed playfield width in table units (inside the cushions). */
export const POOL_TABLE_W = 200;
/** Fixed playfield height in table units (inside the cushions). 2:1 board. */
export const POOL_TABLE_H = 100;
/** Ball radius in table units. */
export const POOL_BALL_R = 2.6;
/** Pocket capture radius in table units (a ball whose center comes within this of a pocket is sunk). */
export const POOL_POCKET_R = 5.0;

/** The six pocket centers (4 corners + 2 mid long-rail), in table units. */
export const POOL_POCKETS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 0, y: 0 },
  { x: POOL_TABLE_W / 2, y: 0 },
  { x: POOL_TABLE_W, y: 0 },
  { x: 0, y: POOL_TABLE_H },
  { x: POOL_TABLE_W / 2, y: POOL_TABLE_H },
  { x: POOL_TABLE_W, y: POOL_TABLE_H },
];

export type PoolBallKind = "cue" | "solid" | "stripe" | "eight";

export interface PoolBall {
  /** 0 = cue, 1..7 = solids, 8 = eight ball, 9..15 = stripes. */
  id: number;
  kind: PoolBallKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pocketed: boolean;
}

/** Which group a player has been assigned once the table "opens". */
export type PoolGroup = "solid" | "stripe";

/**
 * What happened on the last resolved shot — enough for the client to caption it
 * and for the room to drive turn/win logic. Framework-free + serializable.
 */
export interface PoolShotEvent {
  /** Ball ids potted on this shot (in pocket order). */
  potted: number[];
  /** True when the cue ball was pocketed (scratch) or driven off-table. */
  scratch: boolean;
  /** True when the shot was a foul (scratch, wrong-group first contact, no rail/no contact). */
  foul: boolean;
  /** The first ball the cue ball touched, or null if it hit nothing. */
  firstContactId: number | null;
  /** Set when the game ended on this shot: who won. */
  winnerSessionId?: string | null;
  /** Human-readable reason ("potted", "foul", "scratch", "win", "illegal-8-loss"). */
  reason: string;
}

/**
 * The animatable pool game state broadcast in ActiveGame.state. The client can
 * either snap to `balls` (rest positions) or replay `trajectory` (the ordered
 * per-step frames produced by the last simulated shot) for smooth motion.
 */
export interface PoolState {
  balls: PoolBall[];
  /**
   * Whose turn it is: a human player's sessionId, or the literal "AI" when the
   * server AI is to shoot (solo-vs-AI mode).
   */
  currentTurn: string;
  /**
   * Group assignment once the table is no longer open. Keyed by sessionId (and
   * "AI"). Empty object => the table is still OPEN (first legal pot decides).
   */
  assignedGroups: Record<string, PoolGroup>;
  /** True when the next shooter may place the cue ball anywhere (ball-in-hand after a foul). */
  ballInHand: boolean;
  /** The result of the most recently resolved shot (null before the first shot). */
  lastEvent: PoolShotEvent | null;
  /**
   * Ordered animation frames of the LAST shot: each frame is the positions of all
   * balls at a simulation step. OPTIONAL/transient — present right after a shot is
   * resolved so the client can animate from the previous rest to the new rest,
   * then it may be ignored. Each frame is `[{id,x,y,pocketed}]` to keep it compact.
   */
  trajectory?: Array<Array<{ id: number; x: number; y: number; pocketed: boolean }>>;
  /** True while the server is mid-shot resolution (clients disable input). */
  animating: boolean;
}

/** A pool shot: aim + strength. Spin is reserved for a later iteration. */
export interface PoolShotInput {
  /** Aim direction in radians (0 = +x / rightward, increasing clockwise toward +y). */
  angleRad: number;
  /** Cue strength, clamped to [0, 1]. */
  power: number;
  /**
   * Ball-in-hand cue placement (table units). Honored ONLY when state.ballInHand
   * is true; ignored otherwise. Lets the player re-spot the cue before aiming.
   */
  cueX?: number;
  cueY?: number;
}

export interface PongState {
  ballX: number;
  ballY: number;
  paddle1Y: number;
  paddle2Y: number;
}

export interface TicTacToeState {
  board: string[]; // 9 cells: "", "X", "O"
  turn: string; // sessionId
}

export interface ConnectFourState {
  board: string[][]; // 6 rows x 7 cols: "", "R", "Y"
  turn: string; // sessionId
}

export interface ActiveGame {
  id: string;
  type: GameType;
  player1: GamePlayer | null;
  player2: GamePlayer | null;
  score1: number;
  score2: number;
  winnerSessionId: string | null;
  state: PongState | TicTacToeState | ConnectFourState | PoolState | null;
  status: "idle" | "waiting" | "playing" | "gameover";
  /**
   * Pool only: true when the second seat is the server AI (solo-vs-AI mode). For
   * the existing games this is absent. Backward-compatible. When true, player2 is
   * a synthetic GamePlayer with sessionId "AI".
   */
  vsAi?: boolean;
}

/** The synthetic sessionId used for the server AI opponent in solo pool. */
export const POOL_AI_SESSION_ID = "AI";

