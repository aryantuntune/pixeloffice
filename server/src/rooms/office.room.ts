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
  type PresenceSource,
  type SetStatusPayload,
  type SocialEvent,
  type ToastPayload,
  type WelcomePayload,
} from "@pixeloffice/shared";
import { container } from "../container";
import { createLogger } from "../logging/logger";
import { TokenBucket } from "../http/rate-limit";
import { SlotAllocator } from "./slot-allocator";
import type { NpcEffect } from "../npcs/npc.service";

const log = createLogger("room");

const TICK_MS = 3000;
const MAX_CHAT = 140;
const VALID_STATUSES = new Set(["AVAILABLE", "FOCUS", "BREAK", "AWAY"]);

// Per-session message rate limits (token buckets). The websocket message path
// has no equivalent to the REST limiter, so a single client could flood CHAT
// (fanned out to everyone) or MOVE. These caps drop over-limit messages rather
// than broadcasting them. They are generous relative to legitimate play: a
// continuously walking avatar commits ~7 steps/sec (STEP_MS=150 client-side).
const MOVE_RATE = 20; // steps/sec burst + steady budget
const MOVE_WINDOW_MS = 1000;
const CHAT_RATE = 5; // messages/sec
const CHAT_WINDOW_MS = 1000;
const ACTION_RATE = 10; // status/join/leave actions per window
const ACTION_WINDOW_MS = 1000;

export class OfficeRoom extends Room {
  maxClients = 120;

  private readonly map: OfficeMap = buildOfficeMap();
  /** Live snapshots keyed by sessionId. The room is the source of truth. */
  private readonly players = new Map<string, PlayerSnapshot>();
  /** sessionId -> stable userId (the calendar key; survives reconnect upstream). */
  private readonly sessionUser = new Map<string, string>();
  /** The desk seat a player spawned at (for optional return after meetings). */
  private readonly homeSeat = new Map<string, { x: number; y: number }>();
  /**
   * Stable per-meeting seat slots (sessionId -> lowest free index). Seating is
   * derived from this allocator — NOT spatial occupancy and NOT set size — so a
   * mid-meeting leave frees a slot that is reused without colliding with an
   * occupant, and a user merely walking in never bumps a real joiner.
   */
  private readonly meetingSlots = new SlotAllocator();

  /**
   * Sessions still inside onJoin. While present, the presence "change" listener
   * mutates/persists the snapshot but does NOT broadcast PRESENCE — the
   * joining session's resolved presence rides on WELCOME + PLAYER_JOINED, so an
   * early PRESENCE for a session others have not yet been told about (it would
   * arrive before PLAYER_JOINED) is suppressed to keep wire ordering correct.
   */
  private readonly joining = new Set<string>();

  /** Per-session message rate-limit buckets (created lazily on join). */
  private readonly moveBuckets = new Map<string, TokenBucket>();
  private readonly chatBuckets = new Map<string, TokenBucket>();
  private readonly actionBuckets = new Map<string, TokenBucket>();

  // Bound service-listener handlers, retained so onDispose can remove EXACTLY
  // the listeners this instance added to the shared singleton emitters (a 2nd
  // room must not leave stale closures behind that cross-broadcast).
  private onPresenceChange?: (c: { sessionId: string; state: PresenceState; source: PresenceSource }) => void;
  private onMeetingStarted?: (e: { sessionId: string; meeting: MeetingInfo }) => void;
  private onMeetingEnded?: (e: { sessionId: string; meetingId: string }) => void;
  private onEventCreated?: (event: SocialEvent) => void;
  private onEventUpdated?: (event: SocialEvent) => void;
  private onEventEnded?: (eventId: string) => void;

  onCreate(): void {
    this.autoDispose = false;

    // Expose this live room to admin REST (broadcasts) via the registry seam.
    container.registry.room = this;

    this.wireServiceListeners();
    this.registerMessageHandlers();

    // Spawn ambient NPCs so the office never feels empty. They are inserted
    // directly into the authoritative player map BEFORE any client joins, so
    // WELCOME naturally includes them (carrying isNpc=true) — no join broadcast
    // is needed at create. They are server-driven ambience: they never join
    // meetings, never touch HR, and never respond to humans.
    for (const snap of container.npcs.spawnAll(Date.now())) {
      this.players.set(snap.sessionId, snap);
    }

    // The room is the ONLY clock reader. Services get `now` from here.
    this.clock.setInterval(() => {
      const now = Date.now();
      container.presence.tick(now);
      container.events.tick(now);
      // Advance ambient NPCs and translate their effects to wire messages. The
      // NPC service is framework-free; the room is the only Colyseus seam.
      this.applyNpcEffects(container.npcs.tick(now, container.events.activeEvents(now)));
    }, TICK_MS);
  }

  /**
   * Translate framework-free NPC effects into authoritative-snapshot updates +
   * wire broadcasts. NPCs are not real clients, so there is no `except` target —
   * every connected human should see them move/change presence/chat.
   */
  private applyNpcEffects(effects: NpcEffect[]): void {
    for (const effect of effects) {
      const snap = this.players.get(effect.sessionId);
      if (!snap || !snap.isNpc) continue; // only ever mutate NPC snapshots here
      switch (effect.kind) {
        case "move": {
          snap.x = effect.x;
          snap.y = effect.y;
          snap.dir = effect.dir;
          const moved: PlayerMovedPayload = {
            sessionId: effect.sessionId,
            x: effect.x,
            y: effect.y,
            dir: effect.dir,
            moving: effect.moving,
          };
          this.broadcast(S2C.PLAYER_MOVED, moved);
          break;
        }
        case "presence": {
          snap.presence = effect.state;
          snap.source = effect.source;
          const payload: PresencePayload = {
            sessionId: effect.sessionId,
            state: effect.state,
            source: effect.source,
          };
          this.broadcast(S2C.PRESENCE, payload);
          break;
        }
        case "chat": {
          const out: ChatBroadcastPayload = {
            sessionId: effect.sessionId,
            name: effect.name,
            text: effect.text,
          };
          this.broadcast(S2C.CHAT, out);
          break;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Service -> wire translation
  // -------------------------------------------------------------------------

  private wireServiceListeners(): void {
    const { presence, events } = container;

    // presence/events are SHARED singleton emitters. We store bound handlers so
    // onDispose can remove exactly these — otherwise a 2nd room instance (e.g.
    // a maxClients overflow or a reconnect storm during shutdown drain) would
    // leave stale closures that cross-broadcast to the wrong room's clients and
    // leak listeners past Node's 10-listener warning threshold.
    this.onPresenceChange = ({ sessionId, state, source }) => {
      const snap = this.players.get(sessionId);
      // Only react to sessions THIS room owns. A change for a session another
      // room owns must never be persisted or rebroadcast here. NPC snapshots
      // live in this.players too, but their presence is driven exclusively by
      // the NPC service (NPCs are never tracked by the presence service), so
      // guard against ever mutating/persisting an NPC via the human path.
      if (!snap || snap.isNpc) return;
      snap.presence = state;
      snap.source = source;
      // Best-effort persist the LATEST presence (no-op for the in-memory
      // store; RedisPresenceStore swallows its own errors so a Redis blip
      // never affects the live broadcast). Stores only {state, source, atMs}
      // keyed by userId — no surveillance data (plan Principle 2).
      void container.presenceStore.record(snap.userId, state, source, Date.now());
      // Suppress the broadcast while the session is mid-join: WELCOME +
      // PLAYER_JOINED carry the resolved presence, and a PRESENCE that precedes
      // PLAYER_JOINED would reference a session others do not yet know.
      if (this.joining.has(sessionId)) return;
      const payload: PresencePayload = { sessionId, state, source };
      this.broadcast(S2C.PRESENCE, payload);
    };
    presence.on("change", this.onPresenceChange);

    this.onMeetingStarted = ({ sessionId, meeting }) => {
      const client = this.clientFor(sessionId);
      if (!client) return; // not our session
      // A meeting already active at join time is delivered via WELCOME.meeting;
      // skip the redundant (and out-of-order) MEETING_STARTED before WELCOME.
      if (this.joining.has(sessionId)) return;
      log.info("meeting started for participant", { meetingId: meeting.id, title: meeting.title, sessionId });
      client.send(S2C.MEETING_STARTED, { meeting });
    };
    presence.on("meeting-started", this.onMeetingStarted);

    this.onMeetingEnded = ({ sessionId, meetingId }) => {
      const client = this.clientFor(sessionId);
      if (!client) return; // not our session
      this.meetingSlots.release(meetingId, sessionId);
      client.send(S2C.MEETING_ENDED, { meetingId });
    };
    presence.on("meeting-ended", this.onMeetingEnded);

    this.onEventCreated = (event: SocialEvent) => {
      log.info("social event created", { type: event.type, title: event.title, area: event.areaName });
      this.broadcast(S2C.EVENT_CREATED, { event });
      const toast: ToastPayload = {
        message: `☕ ${event.title} started — join in the ${event.areaName}!`,
        kind: "event",
      };
      this.broadcast(S2C.TOAST, toast);
    };
    events.on("created", this.onEventCreated);

    this.onEventUpdated = (event: SocialEvent) => {
      this.broadcast(S2C.EVENT_UPDATED, { event });
    };
    events.on("updated", this.onEventUpdated);

    this.onEventEnded = (eventId: string) => {
      this.broadcast(S2C.EVENT_ENDED, { eventId });
      // Presence recomputes on the next tick once participants are gone; force
      // an immediate resolve so leaving an event reflects instantly.
      container.presence.tick(Date.now());
    };
    events.on("ended", this.onEventEnded);
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
    this.sessionUser.set(client.sessionId, identity.userId);

    // Per-session rate-limit buckets (drop floods rather than fan them out).
    const now = Date.now();
    this.moveBuckets.set(client.sessionId, new TokenBucket(MOVE_RATE, MOVE_WINDOW_MS, now));
    this.chatBuckets.set(client.sessionId, new TokenBucket(CHAT_RATE, CHAT_WINDOW_MS, now));
    this.actionBuckets.set(client.sessionId, new TokenBucket(ACTION_RATE, ACTION_WINDOW_MS, now));

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

    // Insert the snapshot BEFORE the immediate tick: the tick fires the shared
    // presence "change"/"meeting-started" listeners, which read this.players —
    // they must see a consistent map (correct persist + snapshot mutation) and
    // any PRESENCE broadcast must follow WELCOME/PLAYER_JOINED, not precede it
    // (the `joining` guard suppresses the early broadcast).
    this.joining.add(client.sessionId);
    this.players.set(client.sessionId, snapshot);

    container.presence.track(client.sessionId, identity.userId, now);
    // Immediate resolve so the joining player has a real presence value.
    container.presence.tick(now);
    const resolved = container.presence.getPresence(client.sessionId);
    if (resolved) {
      snapshot.presence = resolved.state;
      snapshot.source = resolved.source;
    }

    // Build WELCOME: self, all others, active events, current meeting (if any).
    // Keyed by the STABLE userId (not sessionId) — the calendar seam's contract.
    let currentMeeting: MeetingInfo | null = null;
    try {
      currentMeeting = container.calendar.getCurrentMeeting(identity.userId, now);
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

    // Tell everyone else this player joined (carries the resolved presence).
    const joined: PlayerJoinedPayload = { player: { ...snapshot } };
    this.broadcastExcept(client, S2C.PLAYER_JOINED, joined);

    // Join complete: subsequent presence changes for this session broadcast.
    this.joining.delete(client.sessionId);

    log.info("player joined", {
      name: identity.name,
      department: identity.department,
      sessionId: client.sessionId,
      online: this.players.size,
    });
  }

  onLeave(client: Client): void {
    const sessionId = client.sessionId;
    const leaving = this.players.get(sessionId);
    log.info("player left", { name: leaving?.name, sessionId, online: this.players.size - 1 });
    container.presence.untrack(sessionId);
    container.events.removeParticipant(sessionId);
    this.players.delete(sessionId);
    this.sessionUser.delete(sessionId);
    this.homeSeat.delete(sessionId);
    this.meetingSlots.releaseEverywhere(sessionId);
    this.moveBuckets.delete(sessionId);
    this.chatBuckets.delete(sessionId);
    this.actionBuckets.delete(sessionId);
    this.joining.delete(sessionId);

    const left: PlayerLeftPayload = { sessionId };
    this.broadcast(S2C.PLAYER_LEFT, left);
  }

  onDispose(): void {
    // Remove EXACTLY the listeners this instance added to the shared singleton
    // emitters. Without this a disposed/overflow room's closures stay attached,
    // cross-broadcast to the wrong room, pin this.players, and accumulate past
    // Node's MaxListeners warning.
    const { presence, events } = container;
    if (this.onPresenceChange) presence.off("change", this.onPresenceChange);
    if (this.onMeetingStarted) presence.off("meeting-started", this.onMeetingStarted);
    if (this.onMeetingEnded) presence.off("meeting-ended", this.onMeetingEnded);
    if (this.onEventCreated) events.off("created", this.onEventCreated);
    if (this.onEventUpdated) events.off("updated", this.onEventUpdated);
    if (this.onEventEnded) events.off("ended", this.onEventEnded);

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

    // Tolerate unknown / forward-compatible message types. Without a "*" handler
    // Colyseus disconnects the client (code 4002) on any unrecognised type, so a
    // newer client that adds an additive protocol message against a not-yet-
    // upgraded server would be hard-kicked. Drop it silently instead.
    this.onMessage("*", (client, type) => {
      log.warn("ignored unknown message", { type: String(type), sessionId: client.sessionId });
    });
  }

  /** Spend one token from a per-session bucket; true = allowed, false = drop. */
  private allow(buckets: Map<string, TokenBucket>, sessionId: string): boolean {
    const bucket = buckets.get(sessionId);
    if (!bucket) return false; // unknown/already-left session
    return bucket.tryRemove(Date.now());
  }

  private handleMove(client: Client, payload: MovePayload): void {
    if (!this.allow(this.moveBuckets, client.sessionId)) return;
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
    if (!this.allow(this.actionBuckets, client.sessionId)) return;
    const state = payload?.state;
    if (typeof state !== "string" || !VALID_STATUSES.has(state)) return;

    container.presence.activity(client.sessionId, Date.now());
    container.presence.setManual(client.sessionId, state as SetStatusPayload["state"]);
    // Immediate tick so the manual change is reflected instantly.
    container.presence.tick(Date.now());
  }

  private handleChat(client: Client, payload: ChatPayload): void {
    if (!this.allow(this.chatBuckets, client.sessionId)) return;
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
    if (!this.allow(this.actionBuckets, client.sessionId)) return;
    const eventId = payload?.eventId;
    if (typeof eventId !== "string") return;

    const now = Date.now();
    container.presence.activity(client.sessionId, now);

    // Reject joining an event that has already expired (the lazy tick may not
    // have removed it yet) so we never teleport into a dead area with no BREAK.
    const result = container.events.join(eventId, client.sessionId, now);
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
    if (!this.allow(this.actionBuckets, client.sessionId)) return;
    const eventId = payload?.eventId;
    if (typeof eventId !== "string") return;

    container.presence.activity(client.sessionId, Date.now());
    container.events.leave(eventId, client.sessionId);
    // Recompute presence now that the player has left the event.
    container.presence.tick(Date.now());
  }

  private handleJoinMeeting(client: Client, payload: JoinMeetingPayload): void {
    if (!this.allow(this.actionBuckets, client.sessionId)) return;
    const meetingId = payload?.meetingId;
    if (typeof meetingId !== "string") return;

    const now = Date.now();
    container.presence.activity(client.sessionId, now);

    const userId = this.sessionUser.get(client.sessionId);
    if (!userId) return;
    let meeting: MeetingInfo | null = null;
    try {
      // The meeting must currently apply to this user (stable id) and be active.
      meeting = container.calendar.getCurrentMeeting(userId, now);
    } catch {
      meeting = null;
    }
    if (!meeting || meeting.id !== meetingId) return;

    // Allocate the lowest free seat slot for this meeting (idempotent on
    // re-join; freed slots are reused without colliding with an occupant).
    const seatIndex = this.meetingSlots.assign(meeting.id, client.sessionId);
    const anchor = anchorFor(this.map, meeting.roomName, seatIndex);
    this.teleport(client.sessionId, anchor.x, anchor.y);

    // Visible to ALL. Do NOT change manual status — IN_MEETING comes from the
    // calendar source already (the presence engine handles it).
    const tp: PlayerTeleportedPayload = { sessionId: client.sessionId, x: anchor.x, y: anchor.y };
    this.broadcast(S2C.PLAYER_TELEPORTED, tp);
  }

  private handleLeaveMeeting(client: Client): void {
    if (!this.allow(this.actionBuckets, client.sessionId)) return;
    // Presence-wise a no-op: the calendar still reports IN_MEETING until the
    // meeting ends. Optionally return the player to their desk seat (agency:
    // this only fires from an explicit Leave click).
    container.presence.activity(client.sessionId, Date.now());
    // Free this session's seat slot in every meeting so it can be reused.
    this.meetingSlots.releaseEverywhere(client.sessionId);
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
