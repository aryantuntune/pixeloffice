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
  /** sessionIds invited. Empty array = everyone in the office. */
  participantIds: string[];
  /** "Meeting Room A" | "Meeting Room B" | "Meeting Room C" */
  roomName: string;
}

/** Display metadata for presence states (single source of truth for UI colors). */
export const PRESENCE_META: Record<PresenceState, { label: string; color: string; emoji: string }> = {
  [PresenceState.AVAILABLE]: { label: "Available", color: "#3ecf6e", emoji: "" },
  [PresenceState.IN_MEETING]: { label: "In Meeting", color: "#e5544b", emoji: "📅" },
  [PresenceState.FOCUS]: { label: "Focus", color: "#8a63e8", emoji: "🎧" },
  [PresenceState.BREAK]: { label: "Break", color: "#e8a13c", emoji: "☕" },
  [PresenceState.AWAY]: { label: "Away", color: "#9aa3ad", emoji: "💤" },
  [PresenceState.OFFLINE]: { label: "Offline", color: "#5b6470", emoji: "" },
};
