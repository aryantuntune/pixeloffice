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

export type GameType = "ping-pong" | "tic-tac-toe" | "connect-four";

export interface GamePlayer {
  sessionId: string;
  name: string;
  avatarId: string;
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
  state: PongState | TicTacToeState | ConnectFourState | null;
  status: "idle" | "waiting" | "playing" | "gameover";
}

