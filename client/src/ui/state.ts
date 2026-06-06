// ---------------------------------------------------------------------------
// Tiny logic-free UI store. Holds the server-pushed snapshot the HUD renders
// from. It NEVER computes presence rules — it only mirrors what the server
// tells us (plan rule: presence is resolved server-side). Mutators apply the
// pushed facts and notify subscribers; HUD components re-render from the store.
// ---------------------------------------------------------------------------

import type {
  Direction,
  MeetingInfo,
  PlayerSnapshot,
  PresenceSource,
  PresenceState,
  SocialEvent,
  ActiveGame,
} from "@pixeloffice/shared";

export interface UiState {
  selfId: string;
  /** Every player including self, keyed by sessionId. */
  players: Map<string, PlayerSnapshot>;
  /** Active social events, keyed by event id. */
  events: Map<string, SocialEvent>;
  /** The meeting the local user has been invited to (button shown), or null. */
  myMeeting: MeetingInfo | null;
  /** Whether the local user has clicked Join on myMeeting (label flips). */
  joinedMeeting: boolean;
  /** Current area name of the local player, as reported by the game. */
  selfArea: string;
  activeGames: Map<string, ActiveGame>;
  activeGameId: string | null;
  interactPrompt: string | null;
  interactGameId: string | null;
}

type Listener = (state: UiState) => void;

export class Store {
  private state: UiState;
  private listeners = new Set<Listener>();

  constructor(selfId: string) {
    this.state = {
      selfId,
      players: new Map(),
      events: new Map(),
      myMeeting: null,
      joinedMeeting: false,
      selfArea: "Hallway",
      activeGames: new Map(),
      activeGameId: null,
      interactPrompt: null,
      interactGameId: null,
    };
  }

  get(): UiState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  // --- mutators (pure data application, no presence/meeting logic) ---

  upsertPlayer(p: PlayerSnapshot): void {
    this.state.players.set(p.sessionId, { ...p });
    this.emit();
  }

  removePlayer(sessionId: string): void {
    this.state.players.delete(sessionId);
    this.emit();
  }

  movePlayer(sessionId: string, x: number, y: number, dir: Direction, moving: boolean): void {
    const p = this.state.players.get(sessionId);
    if (!p) return;
    p.x = x;
    p.y = y;
    p.dir = dir;
    void moving;
    this.emit();
  }

  teleportPlayer(sessionId: string, x: number, y: number): void {
    const p = this.state.players.get(sessionId);
    if (!p) return;
    p.x = x;
    p.y = y;
    this.emit();
  }

  setPresence(sessionId: string, presence: PresenceState, source: PresenceSource): void {
    const p = this.state.players.get(sessionId);
    if (!p) return;
    p.presence = presence;
    p.source = source;
    this.emit();
  }

  setSelfArea(area: string): void {
    this.state.selfArea = area || "Hallway";
    this.emit();
  }

  upsertEvent(event: SocialEvent): void {
    this.state.events.set(event.id, event);
    this.emit();
  }

  removeEvent(eventId: string): void {
    this.state.events.delete(eventId);
    this.emit();
  }

  setMeeting(meeting: MeetingInfo | null): void {
    this.state.myMeeting = meeting;
    this.state.joinedMeeting = false;
    this.emit();
  }

  markMeetingJoined(): void {
    this.state.joinedMeeting = true;
    this.emit();
  }

  /** Reset the joined flag (the user clicked Leave) — keeps the meeting card so they can rejoin. */
  markMeetingLeft(): void {
    this.state.joinedMeeting = false;
    this.emit();
  }

  clearMeeting(meetingId: string): void {
    if (this.state.myMeeting && this.state.myMeeting.id !== meetingId) return;
    this.state.myMeeting = null;
    this.state.joinedMeeting = false;
    this.emit();
  }

  setInteractPrompt(prompt: string | null, gameId?: string): void {
    this.state.interactPrompt = prompt;
    this.state.interactGameId = gameId || null;
    this.emit();
  }

  setGame(game: ActiveGame): void {
    this.state.activeGames.set(game.id, game);
    const selfId = this.state.selfId;
    const isPlayer1 = game.player1?.sessionId === selfId;
    const isPlayer2 = game.player2?.sessionId === selfId;
    if (isPlayer1 || isPlayer2) {
      this.state.activeGameId = game.id;
    } else {
      if (this.state.activeGameId === game.id) {
        this.state.activeGameId = null;
      }
    }
    this.emit();
  }

  /** Convenience: the local player snapshot, if known. */
  self(): PlayerSnapshot | undefined {
    return this.state.players.get(this.state.selfId);
  }
}
