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
  MEETING_STARTED: "meeting-started",
  MEETING_ENDED: "meeting-ended",
  TOAST: "toast",
  GAME_UPDATE: "game-update",
  /** A player changed their name / department / avatar (profile edit). */
  PLAYER_UPDATED: "player-updated",
} as const;

export interface WelcomePayload {
  self: PlayerSnapshot;
  /** All OTHER players currently in the office (self excluded). */
  players: PlayerSnapshot[];
  /** Currently active social events. */
  events: SocialEvent[];
  /** The local user's current meeting, if one is already in progress. */
  meeting: MeetingInfo | null;
}

export interface PlayerJoinedPayload {
  player: PlayerSnapshot;
}

export interface PlayerLeftPayload {
  sessionId: string;
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
