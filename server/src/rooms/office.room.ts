// ---------------------------------------------------------------------------
// The Colyseus office room — the ONLY Colyseus-aware module in the server.
//
// It is a thin protocol-handling shell: all business logic lives in the
// framework-free services (presence, events, calendar) injected via the
// container. The room:
//   - authenticates joins via the AuthProvider (no passwords, plan rule)
//   - assigns a desk spawn, holds the live PlayerSnapshot map
//   - validates movement (walkable + 1-tile steps; teleports excepted)
//   - drives the periodic presence/event ticks (the only place that reads the
//     system clock — services always receive `now` from here)
//   - translates service domain events into S2C wire messages
//
// Human agency: meetings/events NEVER auto-move an avatar. Only an explicit
// JOIN_EVENT / JOIN_MEETING message seats the sender at an anchor.
// ---------------------------------------------------------------------------

import { Room, type Client } from "colyseus";
import {
  C2S,
  S2C,
  anchorFor,
  buildOfficeMap,
  isWalkable,
  PresenceState,
  type ChatBroadcastPayload,
  type ChatPayload,
  type Direction,
  type JoinEventPayload,
  type JoinMeetingPayload,
  type MeetingInfo,
  type MovePayload,
  type OfficeMap,
  type PlayerJoinedPayload,
  type PlayerLeftPayload,
  type PlayerMovedPayload,
  type PlayerSnapshot,
  type PlayerTeleportedPayload,
  type PresencePayload,
  type SetStatusPayload,
  type SocialEvent,
  type ToastPayload,
  type WelcomePayload,
} from "@pixeloffice/shared";
import { container } from "../container";

const TICK_MS = 3000;
const MAX_CHAT = 140;
const VALID_STATUSES = new Set(["AVAILABLE", "FOCUS", "BREAK", "AWAY"]);

export class OfficeRoom extends Room {
  maxClients = 120;

  private readonly map: OfficeMap = buildOfficeMap();
  /** Live snapshots keyed by sessionId. The room is the source of truth. */
  private readonly players = new Map<string, PlayerSnapshot>();
  /** The desk seat a player spawned at (for optional return after meetings). */
  private readonly homeSeat = new Map<string, { x: number; y: number }>();
  /**
   * Explicit meeting attendees per meetingId (sessionIds that clicked Join).
   * Seating index is derived from this set — NOT spatial occupancy — so a user
   * merely walking into the room does not bump real joiners onto a taken anchor.
   */
  private readonly meetingAttendees = new Map<string, Set<string>>();

  onCreate(): void {
    this.autoDispose = false;

    // Expose this live room to admin REST (broadcasts) via the registry seam.
    container.registry.room = this;

    this.wireServiceListeners();
    this.registerMessageHandlers();

    // The room is the ONLY clock reader. Services get `now` from here.
    this.clock.setInterval(() => {
      const now = Date.now();
      container.presence.tick(now);
      container.events.tick(now);
    }, TICK_MS);
  }

  // -------------------------------------------------------------------------
  // Service -> wire translation
  // -------------------------------------------------------------------------

  private wireServiceListeners(): void {
    const { presence, events } = container;

    presence.on("change", ({ sessionId, state, source }) => {
      const snap = this.players.get(sessionId);
      if (snap) {
        snap.presence = state;
        snap.source = source;
        // Best-effort persist the LATEST presence (no-op for the in-memory
        // store; RedisPresenceStore swallows its own errors so a Redis blip
        // never affects the live broadcast). Stores only {state, source, atMs}
        // keyed by userId — no surveillance data (plan Principle 2).
        void container.presenceStore.record(snap.userId, state, source, Date.now());
      }
      const payload: PresencePayload = { sessionId, state, source };
      this.broadcast(S2C.PRESENCE, payload);
    });

    presence.on("meeting-started", ({ sessionId, meeting }) => {
      const client = this.clientFor(sessionId);
      if (client) client.send(S2C.MEETING_STARTED, { meeting });
    });

    presence.on("meeting-ended", ({ sessionId, meetingId }) => {
      const attendees = this.meetingAttendees.get(meetingId);
      if (attendees) {
        attendees.delete(sessionId);
        if (attendees.size === 0) this.meetingAttendees.delete(meetingId);
      }
      const client = this.clientFor(sessionId);
      if (client) client.send(S2C.MEETING_ENDED, { meetingId });
    });

    events.on("created", (event: SocialEvent) => {
      this.broadcast(S2C.EVENT_CREATED, { event });
      const toast: ToastPayload = {
        message: `☕ ${event.title} started — join in the ${event.areaName}!`,
        kind: "event",
      };
      this.broadcast(S2C.TOAST, toast);
    });

    events.on("updated", (event: SocialEvent) => {
      this.broadcast(S2C.EVENT_UPDATED, { event });
    });

    events.on("ended", (eventId: string) => {
      this.broadcast(S2C.EVENT_ENDED, { eventId });
      // Presence recomputes on the next tick once participants are gone; force
      // an immediate resolve so leaving an event reflects instantly.
      container.presence.tick(Date.now());
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async onJoin(client: Client, options: unknown): Promise<void> {
    // Authenticate (validates name/department/avatar; rejects garbage).
    const identity = await container.auth.authenticate(options);

    await container.users.save({
      id: identity.userId,
      name: identity.name,
      department: identity.department,
      avatarId: identity.avatarId,
    });

    const seat = this.assignSpawn(identity.department);
    this.homeSeat.set(client.sessionId, seat);

    const snapshot: PlayerSnapshot = {
      sessionId: client.sessionId,
      userId: identity.userId,
      name: identity.name,
      department: identity.department,
      avatarId: identity.avatarId,
      x: seat.x,
      y: seat.y,
      dir: "down",
      presence: PresenceState.AVAILABLE, // resolved immediately below
      source: "SYSTEM",
    };

    const now = Date.now();
    container.presence.track(client.sessionId, identity.userId, now);
    // Immediate resolve so the joining player has a real presence value.
    container.presence.tick(now);
    const resolved = container.presence.getPresence(client.sessionId);
    if (resolved) {
      snapshot.presence = resolved.state;
      snapshot.source = resolved.source;
    }

    this.players.set(client.sessionId, snapshot);

    // Build WELCOME: self, all others, active events, current meeting (if any).
    let currentMeeting: MeetingInfo | null = null;
    try {
      currentMeeting = container.calendar.getCurrentMeeting(client.sessionId, now);
    } catch {
      currentMeeting = null;
    }

    const welcome: WelcomePayload = {
      self: { ...snapshot },
      players: this.othersOf(client.sessionId),
      events: container.events.activeEvents(now),
      meeting: currentMeeting,
    };
    client.send(S2C.WELCOME, welcome);

    // Tell everyone else this player joined.
    const joined: PlayerJoinedPayload = { player: { ...snapshot } };
    this.broadcastExcept(client, S2C.PLAYER_JOINED, joined);
  }

  onLeave(client: Client): void {
    const sessionId = client.sessionId;
    container.presence.untrack(sessionId);
    container.events.removeParticipant(sessionId);
    this.players.delete(sessionId);
    this.homeSeat.delete(sessionId);
    for (const attendees of this.meetingAttendees.values()) {
      attendees.delete(sessionId);
    }

    const left: PlayerLeftPayload = { sessionId };
    this.broadcast(S2C.PLAYER_LEFT, left);
  }

  onDispose(): void {
    if (container.registry.room === this) {
      container.registry.room = null;
    }
  }

  // -------------------------------------------------------------------------
  // Message handlers (protocol)
  // -------------------------------------------------------------------------

  private registerMessageHandlers(): void {
    this.onMessage(C2S.MOVE, (client, payload: MovePayload) => this.handleMove(client, payload));
    this.onMessage(C2S.SET_STATUS, (client, payload: SetStatusPayload) =>
      this.handleSetStatus(client, payload),
    );
    this.onMessage(C2S.CHAT, (client, payload: ChatPayload) => this.handleChat(client, payload));
    this.onMessage(C2S.JOIN_EVENT, (client, payload: JoinEventPayload) =>
      this.handleJoinEvent(client, payload),
    );
    this.onMessage(C2S.LEAVE_EVENT, (client, payload: JoinEventPayload) =>
      this.handleLeaveEvent(client, payload),
    );
    this.onMessage(C2S.JOIN_MEETING, (client, payload: JoinMeetingPayload) =>
      this.handleJoinMeeting(client, payload),
    );
    this.onMessage(C2S.LEAVE_MEETING, (client) => this.handleLeaveMeeting(client));
  }

  private handleMove(client: Client, payload: MovePayload): void {
    const snap = this.players.get(client.sessionId);
    if (!snap) return;

    const x = payload?.x;
    const y = payload?.y;
    const dir = payload?.dir;
    const moving = !!payload?.moving;

    const valid =
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      isValidDir(dir) &&
      isWalkable(this.map, x, y) &&
      manhattan(snap.x, snap.y, x, y) <= 1;

    if (!valid) {
      // Reject: snap the offending client back to our authoritative position.
      const tp: PlayerTeleportedPayload = { sessionId: client.sessionId, x: snap.x, y: snap.y };
      client.send(S2C.PLAYER_TELEPORTED, tp);
      return;
    }

    snap.x = x;
    snap.y = y;
    snap.dir = dir;

    // Movement counts as activity (clears auto-AWAY). No surveillance beyond ts.
    container.presence.activity(client.sessionId, Date.now());

    const moved: PlayerMovedPayload = { sessionId: client.sessionId, x, y, dir, moving };
    this.broadcastExcept(client, S2C.PLAYER_MOVED, moved);
  }

  private handleSetStatus(client: Client, payload: SetStatusPayload): void {
    const state = payload?.state;
    if (typeof state !== "string" || !VALID_STATUSES.has(state)) return;

    container.presence.activity(client.sessionId, Date.now());
    container.presence.setManual(client.sessionId, state as SetStatusPayload["state"]);
    // Immediate tick so the manual change is reflected instantly.
    container.presence.tick(Date.now());
  }

  private handleChat(client: Client, payload: ChatPayload): void {
    const snap = this.players.get(client.sessionId);
    if (!snap) return;
    const raw = typeof payload?.text === "string" ? payload.text.trim() : "";
    if (raw.length === 0) return;
    const text = raw.slice(0, MAX_CHAT);

    container.presence.activity(client.sessionId, Date.now());

    const out: ChatBroadcastPayload = { sessionId: client.sessionId, name: snap.name, text };
    this.broadcast(S2C.CHAT, out);
  }

  private handleJoinEvent(client: Client, payload: JoinEventPayload): void {
    const eventId = payload?.eventId;
    if (typeof eventId !== "string") return;

    container.presence.activity(client.sessionId, Date.now());

    const result = container.events.join(eventId, client.sessionId);
    if (!result) return;

    const anchor = anchorFor(this.map, result.event.areaName, result.anchorIndex);
    this.teleport(client.sessionId, anchor.x, anchor.y);

    // Teleport visible to ALL (including the sender — they clicked Join).
    const tp: PlayerTeleportedPayload = { sessionId: client.sessionId, x: anchor.x, y: anchor.y };
    this.broadcast(S2C.PLAYER_TELEPORTED, tp);

    // Immediate tick so BREAK/EVENT presence is instant.
    container.presence.tick(Date.now());
  }

  private handleLeaveEvent(client: Client, payload: JoinEventPayload): void {
    const eventId = payload?.eventId;
    if (typeof eventId !== "string") return;

    container.presence.activity(client.sessionId, Date.now());
    container.events.leave(eventId, client.sessionId);
    // Recompute presence now that the player has left the event.
    container.presence.tick(Date.now());
  }

  private handleJoinMeeting(client: Client, payload: JoinMeetingPayload): void {
    const meetingId = payload?.meetingId;
    if (typeof meetingId !== "string") return;

    container.presence.activity(client.sessionId, Date.now());

    const now = Date.now();
    let meeting: MeetingInfo | null = null;
    try {
      // The meeting must currently apply to this session and be active.
      meeting = container.calendar.getCurrentMeeting(client.sessionId, now);
    } catch {
      meeting = null;
    }
    if (!meeting || meeting.id !== meetingId) return;

    // Seat by the joiner's stable index within the explicit attendee set for
    // this meeting (idempotent: re-joining keeps the same slot).
    let attendees = this.meetingAttendees.get(meeting.id);
    if (!attendees) {
      attendees = new Set<string>();
      this.meetingAttendees.set(meeting.id, attendees);
    }
    let seatIndex = [...attendees].indexOf(client.sessionId);
    if (seatIndex === -1) {
      seatIndex = attendees.size;
      attendees.add(client.sessionId);
    }
    const anchor = anchorFor(this.map, meeting.roomName, seatIndex);
    this.teleport(client.sessionId, anchor.x, anchor.y);

    // Visible to ALL. Do NOT change manual status — IN_MEETING comes from the
    // calendar source already (the presence engine handles it).
    const tp: PlayerTeleportedPayload = { sessionId: client.sessionId, x: anchor.x, y: anchor.y };
    this.broadcast(S2C.PLAYER_TELEPORTED, tp);
  }

  private handleLeaveMeeting(client: Client): void {
    // Presence-wise a no-op: the calendar still reports IN_MEETING until the
    // meeting ends. Optionally return the player to their desk seat (agency:
    // this only fires from an explicit Leave click).
    container.presence.activity(client.sessionId, Date.now());
    // Drop the explicit attendee record so the seat slot is freed.
    for (const attendees of this.meetingAttendees.values()) {
      attendees.delete(client.sessionId);
    }
    const seat = this.homeSeat.get(client.sessionId);
    if (!seat) return;
    this.teleport(client.sessionId, seat.x, seat.y);
    const tp: PlayerTeleportedPayload = { sessionId: client.sessionId, x: seat.x, y: seat.y };
    this.broadcast(S2C.PLAYER_TELEPORTED, tp);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** First free desk seat in the department, else the fallback spawn. */
  private assignSpawn(department: PlayerSnapshot["department"]): { x: number; y: number } {
    const occupied = new Set<string>();
    for (const p of this.players.values()) {
      occupied.add(`${p.x},${p.y}`);
    }
    for (const desk of this.map.desks) {
      if (desk.department !== department) continue;
      const key = `${desk.seatX},${desk.seatY}`;
      if (!occupied.has(key) && isWalkable(this.map, desk.seatX, desk.seatY)) {
        return { x: desk.seatX, y: desk.seatY };
      }
    }
    // No free desk: fall back to the first walkable, unoccupied tile found by a
    // deterministic ring scan outward from the fallback spawn so overflow users
    // do not stack on the exact same tile.
    const { x: sx, y: sy } = this.map.spawn;
    if (!occupied.has(`${sx},${sy}`) && isWalkable(this.map, sx, sy)) {
      return { x: sx, y: sy };
    }
    for (let r = 1; r < Math.max(this.map.width, this.map.height); r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          // Only the perimeter of the current ring (avoids re-checking inner rings).
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = sx + dx;
          const y = sy + dy;
          if (occupied.has(`${x},${y}`)) continue;
          if (isWalkable(this.map, x, y)) return { x, y };
        }
      }
    }
    // Last resort (map fully occupied): the fallback spawn.
    return { x: sx, y: sy };
  }

  /** Apply a teleport to the authoritative snapshot. */
  private teleport(sessionId: string, x: number, y: number): void {
    const snap = this.players.get(sessionId);
    if (!snap) return;
    snap.x = x;
    snap.y = y;
  }

  /** Snapshot copy of every connected player (admin REST read model). */
  listPlayers(): PlayerSnapshot[] {
    return Array.from(this.players.values()).map((p) => ({ ...p }));
  }

  private othersOf(sessionId: string): PlayerSnapshot[] {
    const out: PlayerSnapshot[] = [];
    for (const [id, p] of this.players) {
      if (id !== sessionId) out.push({ ...p });
    }
    return out;
  }

  private clientFor(sessionId: string): Client | undefined {
    return this.clients.find((c) => c.sessionId === sessionId);
  }

  private broadcastExcept(client: Client, type: string, message: unknown): void {
    this.broadcast(type, message, { except: client });
  }
}

function manhattan(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

function isValidDir(dir: unknown): dir is Direction {
  return dir === "up" || dir === "down" || dir === "left" || dir === "right";
}
