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
  BuildingSummary,
  RoomCallS2C,
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
  /**
   * The active building summary (floor list) from the WELCOME payload, or null
   * when the server is pre-multifloor. Display-only — the floor indicator reads
   * it to render the building's floors. Optional/backward-compatible: if the
   * integrator never sets it, the floor indicator falls back to showing only the
   * self player's current floor.
   */
  building: BuildingSummary | null;
  /**
   * The self player's current floor id (mirrors `self().floorId`, but tracked
   * explicitly so FLOOR_CHANGED can update it even before the player snapshot is
   * re-seeded). Absent floor data is treated as the ground floor by consumers.
   */
  selfFloorId: string | null;
  /** The meeting room the local user is currently standing in, plus open call info. */
  roomCall: RoomCallS2C | null;
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
      building: null,
      selfFloorId: null,
      roomCall: null,
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

  /**
   * Apply a player's OPT-IN physical-location tag (S2C.LOCATION / inline on a
   * snapshot). Pass `undefined` to clear it (sync turned off => no badge). This
   * is ORTHOGONAL to presence — it never touches `presence`/`source`. Pure data
   * application: privacy-wise the client mirrors only the transient Office/Remote
   * tag, never a location history (plan.md "presence, not surveillance").
   */
  setPlace(sessionId: string, place: "OFFICE" | "REMOTE" | undefined): void {
    const p = this.state.players.get(sessionId);
    if (!p) return;
    p.place = place;
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

  /**
   * Record the active building summary (floor list) from WELCOME. Display-only;
   * the floor indicator renders the building's floors from this. Idempotent.
   */
  setBuilding(building: BuildingSummary | null): void {
    this.state.building = building;
    this.emit();
  }

  /**
   * Record the self player's current floor id (from WELCOME's self.floorId or a
   * FLOOR_CHANGED message). Display-only — never moves an avatar (human agency).
   */
  setSelfFloor(floorId: string | null): void {
    this.state.selfFloorId = floorId;
    this.emit();
  }

  setRoomCall(p: RoomCallS2C | null): void {
    this.state.roomCall = p;
    this.emit();
  }

  /** Convenience: the local player snapshot, if known. */
  self(): PlayerSnapshot | undefined {
    return this.state.players.get(this.state.selfId);
  }

  /**
   * The self player's effective floor id. Prefers the explicitly-tracked floor
   * (FLOOR_CHANGED), then the self snapshot's floorId, defaulting to "ground"
   * for pre-multifloor servers (contract: absent floorId means ground).
   */
  selfFloorId(): string {
    return this.state.selfFloorId ?? this.self()?.floorId ?? "ground";
  }
}
