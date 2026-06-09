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

import type { IncomingMessage } from "node:http";
import { Room, type Client } from "colyseus";
import {
  C2S,
  EMOTES,
  S2C,
  AVATAR_IDS,
  DEPARTMENTS,
  MAIN_OFFICE_FLOOR_ID,
  SPAWN_FLOOR_ID,
  anchorFor,
  isWalkable,
  portalAt,
  PresenceState,
  type AvatarId,
  type Department,
  type UpdateProfilePayload,
  type PlayerUpdatedPayload,
  type ChatBroadcastPayload,
  type ChatPayload,
  type Direction,
  type Emote,
  type EmoteBroadcastPayload,
  type EmotePayload,
  type JoinEventPayload,
  type JoinMeetingPayload,
  type MeetingInfo,
  type MovePayload,
  type Building,
  type Floor,
  type BuildingSummary,
  type FloorChangedPayload,
  type PlayerJoinedPayload,
  type PlayerLeftPayload,
  type PlayerMovedPayload,
  type PlayerSnapshot,
  type PlayerTeleportedPayload,
  type PresencePayload,
  type PresenceSource,
  type SetStatusPayload,
  type SetLocationSyncPayload,
  type LocationPayload,
  type FloorSyncCodePayload,
  type RtcCallC2S,
  type RtcCallS2C,
  type RtcSignalC2S,
  type RtcSignalS2C,
  type RtcCallAction,
  type WhiteboardOpenC2S,
  type WhiteboardCloseC2S,
  type WhiteboardUpdateC2S,
  type WhiteboardClearC2S,
  type WhiteboardStateS2C,
  type WhiteboardUpdateS2C,
  type WhiteboardClearS2C,
  type WhiteboardElement,
  chebyshev,
  CALL_REQUEST_TILES,
  type SocialEvent,
  type ToastPayload,
  type WelcomePayload,
  POOL_AI_SESSION_ID,
  type ActiveGame,
  type GameType,
  type GamePlayer,
  type PongState,
  type TicTacToeState,
  type ConnectFourState,
  type PoolState,
  type PoolShotInput,
} from "@pixeloffice/shared";
import {
  freshPoolState,
  applyShot,
  resolveShot,
  pickShot,
  makePrng,
  joinPool,
  leavePool,
  rematchPool,
  type PoolDifficulty,
  type PoolLifecycleResult,
} from "../games/pool";
import { container } from "../container";
import { createLogger } from "../logging/logger";
import { TokenBucket } from "../http/rate-limit";
import { SlotAllocator } from "./slot-allocator";
import { NpcService, mulberry32, npcConfigFromEnv } from "../npcs/npc.service";
import type { NpcEffect } from "../npcs/npc.service";
import { clientIpFromRequest } from "../location/floor-location.adapter";

const log = createLogger("room");

const TICK_MS = 3000;
const MAX_CHAT = 140;
const MAX_NAME = 24;
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
// WebRTC signaling (SDP/ICE) is bursty during negotiation — ICE alone can emit
// dozens of candidates in under a second. A generous bucket keeps the relay
// flowing while still capping a flood. Call CONTROL reuses the action bucket.
const RTC_SIGNAL_RATE = 80;
const RTC_SIGNAL_WINDOW_MS = 1000;
const RTC_CALL_ACTIONS = new Set<RtcCallAction>([
  "request",
  "accept",
  "reject",
  "cancel",
  "hangup",
]);
// Whiteboard: throttled element-batch updates, plus open/close/clear. Updates
// are debounced client-side (~one batch per change burst), so a modest rate is
// plenty while still bounding abuse.
const WB_RATE = 30;
const WB_WINDOW_MS = 1000;
const WB_MAX_ELEMENTS_PER_MSG = 2000; // cap a single update batch
const WB_MAX_ELEMENT_BYTES = 131072; // 128KB — fits long freedraw strokes (points + pressures)
const WB_DEPARTMENTS = new Set<string>(DEPARTMENTS);

// Same trust-proxy decision the REST rate limiter uses (index.ts). Only when the
// server sits behind a vetted reverse proxy is X-Forwarded-For honored for the
// OPT-IN floor-location classification; otherwise the raw socket peer is used.
const TRUST_PROXY = ["true", "1", "yes"].includes(
  (process.env.TRUST_PROXY ?? "").toLowerCase(),
);

export class OfficeRoom extends Room {
  maxClients = 120;

  /**
   * The active building captured at create. Live players keep this building for
   * their whole session (changing the ACTIVE map via /api/maps applies to NEW
   * rooms/joins only — documented in MULTIFLOOR-CONTRACT.md).
   */
  private readonly building: Building = container.maps.getActiveBuilding();
  /** Fast floorId -> Floor lookup (a Floor IS an OfficeMap, so all map helpers work). */
  private readonly floors = new Map<string, Floor>(
    this.building.floors.map((f) => [f.id, f]),
  );
  /**
   * The ground floor id (index 0). The DEFAULT floor for an absent snapshot
   * floorId (contract: absent => "ground"), for admin-REST events without a
   * floor, and the target of floor-scoped fallbacks. NOTE: this is NOT where new
   * players spawn — that is `spawnFloorId` (the rich main office, now Floor 2).
   */
  private readonly groundFloorId: string =
    (this.building.floors.find((f) => f.index === 0) ?? this.building.floors[0]).id;
  /**
   * The floor a NEW player spawns on (the rich main office — Floor 2 in the
   * default building, exported as SPAWN_FLOOR_ID). Falls back to the ground floor
   * for custom buildings that lack that floor id.
   */
  private readonly spawnFloorId: string = this.floors.has(SPAWN_FLOOR_ID)
    ? SPAWN_FLOOR_ID
    : this.groundFloorId;
  /**
   * The floor whose geometry is exactly buildOfficeMap() (the rich main office),
   * which reuses the SHARED container NPC engine (built on buildOfficeMap). Falls
   * back to the ground floor for custom buildings lacking that floor id.
   */
  private readonly mainOfficeFloorId: string = this.floors.has(MAIN_OFFICE_FLOOR_ID)
    ? MAIN_OFFICE_FLOOR_ID
    : this.groundFloorId;
  /** Per-floor ambient NPC engines (each seeded from that floor's geometry). */
  private readonly npcByFloor = new Map<string, NpcService>();
  /** Reverse index: NPC sessionId -> floorId (NPCs never change floors). */
  private readonly npcFloor = new Map<string, string>();
  /**
   * Floor an event belongs to (eventId -> floorId). Social events are per-floor:
   * an event/meeting belongs to the floor it was created on. Admin REST creates
   * events without a floor, so those default to the ground floor (the legacy
   * single-floor behavior the smoke test asserts). Unmapped ids => ground.
   */
  private readonly eventFloor = new Map<string, string>();
  /** Live snapshots keyed by sessionId. The room is the source of truth. */
  private readonly players = new Map<string, PlayerSnapshot>();
  /** sessionId -> stable userId (the calendar key; survives reconnect upstream). */
  private readonly sessionUser = new Map<string, string>();
  /**
   * sessionId -> the client IP captured in onAuth, for the OPT-IN floor-location
   * classification ONLY. PRIVACY (plan Principle 2): this is transient in-memory
   * state for the duration of the session, NEVER logged, NEVER persisted, NEVER
   * put in any broadcast snapshot, and dropped on leave. It is read solely to
   * classify Office/Remote when (and only when) the user enables floor sync.
   */
  private readonly sessionIp = new Map<string, string | undefined>();
  /** sessionId -> whether the user has OPTED IN to floor sync (default FALSE). */
  private readonly locationSync = new Map<string, boolean>();
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
  /** Per-session WebRTC signaling bucket (bursty ICE; created on join). */
  private readonly rtcBuckets = new Map<string, TokenBucket>();
  /** Per-session whiteboard-stroke bucket (created on join). */
  private readonly wbBuckets = new Map<string, TokenBucket>();
  /** board (department) -> sessionIds currently viewing it (broadcast targets). */
  private readonly wbSubs = new Map<string, Set<string>>();

  /** Active multiplayer games in the lounge. */
  private readonly games = new Map<string, ActiveGame>();
  private pongInterval?: any;
  private pongVelX = 6;
  private pongVelY = 5;
  private paddle1Dir = 0;
  private paddle2Dir = 0;

  /** Per-pool-game AI turn timers (so a leave can cancel a pending AI shot). */
  private readonly poolAiTimers = new Map<string, any>();
  /** Monotonic seed source for deterministic-per-game AI PRNGs. */
  private poolSeedCounter = 0x9e3779b1;
  /** AI difficulty for solo pool (env-overridable; defaults to medium). */
  private readonly poolAiDifficulty: PoolDifficulty =
    (["easy", "medium", "hard"] as const).includes(
      (process.env.POOL_AI_DIFFICULTY ?? "").toLowerCase() as PoolDifficulty,
    )
      ? ((process.env.POOL_AI_DIFFICULTY as string).toLowerCase() as PoolDifficulty)
      : "medium";

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

    // Initialize active lounge games.
    this.games.set("lounge:ping-pong", {
      id: "lounge:ping-pong",
      type: "ping-pong",
      player1: null,
      player2: null,
      score1: 0,
      score2: 0,
      winnerSessionId: null,
      state: { ballX: 300, ballY: 200, paddle1Y: 160, paddle2Y: 160 },
      status: "idle",
    });

    this.games.set("lounge:tic-tac-toe", {
      id: "lounge:tic-tac-toe",
      type: "tic-tac-toe",
      player1: null,
      player2: null,
      score1: 0,
      score2: 0,
      winnerSessionId: null,
      state: { board: Array(9).fill(""), turn: "" },
      status: "idle",
    });

    this.games.set("lounge:connect-four", {
      id: "lounge:connect-four",
      type: "connect-four",
      player1: null,
      player2: null,
      score1: 0,
      score2: 0,
      winnerSessionId: null,
      state: { board: Array(6).fill(null).map(() => Array(7).fill("")), turn: "" },
      status: "idle",
    });

    this.games.set("lounge:pool", {
      id: "lounge:pool",
      type: "pool",
      player1: null,
      player2: null,
      score1: 0,
      score2: 0,
      winnerSessionId: null,
      state: null,
      status: "idle",
    });

    this.wireServiceListeners();
    this.registerMessageHandlers();

    // Spawn ambient NPCs so the office never feels empty — now PER FLOOR. They
    // are inserted into the authoritative player map BEFORE any client joins, so
    // WELCOME naturally includes the joiner's-floor NPCs (carrying isNpc=true).
    // They are server-driven ambience: never join meetings, never touch HR,
    // never respond to humans, and never change floors.
    //
    // The MAIN OFFICE floor (the rich buildOfficeMap layout) reuses the SHARED
    // container NPC engine (built on that exact geometry) so its existing
    // behavior/tests are unchanged. Other floors get fresh per-floor engines
    // (distinct sessionIds via a floor-id prefix so they never collide).
    const npcCfg = npcConfigFromEnv(process.env);
    const now0 = Date.now();
    for (const floor of this.building.floors) {
      let engine: NpcService;
      if (floor.id === this.mainOfficeFloorId) {
        engine = container.npcs; // shared engine = legacy rich-office behavior
      } else {
        engine = new NpcService(floor, mulberry32(npcCfg.seed + floor.index), npcCfg.count);
      }
      this.npcByFloor.set(floor.id, engine);
      for (const snap of engine.spawnAll(now0)) {
        const id = floor.id === this.mainOfficeFloorId ? snap.sessionId : `${floor.id}:${snap.sessionId}`;
        const placed: PlayerSnapshot = { ...snap, sessionId: id, floorId: floor.id };
        this.players.set(id, placed);
        this.npcFloor.set(id, floor.id);
      }
    }

    // The room is the ONLY clock reader. Services get `now` from here.
    this.clock.setInterval(() => {
      const now = Date.now();
      container.presence.tick(now);
      container.events.tick(now);
      // Sweep expired pairing codes (privacy: nothing stale lingers in memory).
      container.pairCodes.prune(now);
      // Advance ambient NPCs PER FLOOR and translate their effects to wire
      // messages (floor-scoped). The NPC service is framework-free; the room is
      // the only Colyseus seam. Events are floor-scoped, so each floor's NPCs
      // only ever see events on their own floor.
      for (const [floorId, engine] of this.npcByFloor) {
        const floorEvents = this.activeEventsOnFloor(floorId, now);
        this.applyNpcEffects(engine.tick(now, floorEvents), floorId);
      }
    }, TICK_MS);
  }

  /**
   * Translate framework-free NPC effects into authoritative-snapshot updates +
   * wire broadcasts. NPCs are not real clients, so there is no `except` target —
   * every connected human should see them move/change presence/chat.
   */
  private applyNpcEffects(effects: NpcEffect[], floorId: string): void {
    // The main office floor uses the shared engine whose sessionIds are stored
    // as-is; other floors prefix the engine sessionId with "<floorId>:". Resolve
    // the authoritative key the same way it was inserted in onCreate.
    const keyFor = (engineSessionId: string): string =>
      floorId === this.mainOfficeFloorId ? engineSessionId : `${floorId}:${engineSessionId}`;

    for (const effect of effects) {
      const sessionId = keyFor(effect.sessionId);
      const snap = this.players.get(sessionId);
      if (!snap || !snap.isNpc) continue; // only ever mutate NPC snapshots here
      switch (effect.kind) {
        case "move": {
          snap.x = effect.x;
          snap.y = effect.y;
          snap.dir = effect.dir;
          const moved: PlayerMovedPayload = {
            sessionId,
            x: effect.x,
            y: effect.y,
            dir: effect.dir,
            moving: effect.moving,
          };
          this.broadcastToFloor(floorId, S2C.PLAYER_MOVED, moved);
          break;
        }
        case "presence": {
          snap.presence = effect.state;
          snap.source = effect.source;
          const payload: PresencePayload = {
            sessionId,
            state: effect.state,
            source: effect.source,
          };
          this.broadcastToFloor(floorId, S2C.PRESENCE, payload);
          break;
        }
        case "chat": {
          const out: ChatBroadcastPayload = {
            sessionId,
            name: effect.name,
            text: effect.text,
          };
          this.broadcastToFloor(floorId, S2C.CHAT, out);
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
      // Floor-scoped: only co-located players see this player's presence change.
      this.broadcastToFloor(snap.floorId ?? this.groundFloorId, S2C.PRESENCE, payload);
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
      // Events are per-floor. Admin REST creates them without a floor, so they
      // belong to the MAIN OFFICE floor (the rich layout that owns Coffee Area /
      // Lounge / Meeting Rooms) — preserving the legacy single-floor behavior now
      // that the rich office is Floor 2. The event's areaName must match an area
      // on that floor's map for anchors to resolve.
      const floorId = this.eventFloor.get(event.id) ?? this.mainOfficeFloorId;
      this.eventFloor.set(event.id, floorId);
      log.info("social event created", { type: event.type, title: event.title, area: event.areaName, floorId });
      this.broadcastToFloor(floorId, S2C.EVENT_CREATED, { event });
      const toast: ToastPayload = {
        message: `☕ ${event.title} started — join in the ${event.areaName}!`,
        kind: "event",
      };
      this.broadcastToFloor(floorId, S2C.TOAST, toast);
    };
    events.on("created", this.onEventCreated);

    this.onEventUpdated = (event: SocialEvent) => {
      const floorId = this.eventFloor.get(event.id) ?? this.mainOfficeFloorId;
      this.broadcastToFloor(floorId, S2C.EVENT_UPDATED, { event });
    };
    events.on("updated", this.onEventUpdated);

    this.onEventEnded = (eventId: string) => {
      const floorId = this.eventFloor.get(eventId) ?? this.mainOfficeFloorId;
      this.eventFloor.delete(eventId);
      this.broadcastToFloor(floorId, S2C.EVENT_ENDED, { eventId });
      // Presence recomputes on the next tick once participants are gone; force
      // an immediate resolve so leaving an event reflects instantly.
      container.presence.tick(Date.now());
    };
    events.on("ended", this.onEventEnded);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Colyseus hands the raw HTTP upgrade request here. We capture ONLY the client
   * IP (honoring the trust-proxy decision) and stash it transiently for the
   * OPT-IN floor-location classification. We do NOT authenticate here (auth lives
   * in onJoin via the AuthProvider); returning true preserves the existing
   * open-join behavior. PRIVACY: the IP is never logged/persisted here.
   */
  onAuth(client: Client, _options: unknown, request?: IncomingMessage): boolean {
    const ip = clientIpFromRequest(
      request?.headers,
      request?.socket?.remoteAddress,
      TRUST_PROXY,
    );
    this.sessionIp.set(client.sessionId, ip);
    return true;
  }

  async onJoin(client: Client, options: unknown): Promise<void> {
    // Authenticate (validates name/department/avatar; rejects garbage).
    const identity = await container.auth.authenticate(options);

    await container.users.save({
      id: identity.userId,
      name: identity.name,
      department: identity.department,
      avatarId: identity.avatarId,
    });

    // New joiners spawn on the rich MAIN OFFICE floor (Floor 2) at a free desk
    // seat, so the default experience lands in the full office at a real desk.
    const spawnFloor = this.floors.get(this.spawnFloorId)!;
    const seat = this.assignSpawn(spawnFloor, identity.department);
    this.homeSeat.set(client.sessionId, seat);
    this.sessionUser.set(client.sessionId, identity.userId);
    // Floor sync is OPT-IN and OFF by default. `place` stays absent on the
    // snapshot until the user explicitly enables sync (SET_LOCATION_SYNC).
    this.locationSync.set(client.sessionId, false);

    // Per-session rate-limit buckets (drop floods rather than fan them out).
    const now = Date.now();
    this.moveBuckets.set(client.sessionId, new TokenBucket(MOVE_RATE, MOVE_WINDOW_MS, now));
    this.chatBuckets.set(client.sessionId, new TokenBucket(CHAT_RATE, CHAT_WINDOW_MS, now));
    this.actionBuckets.set(client.sessionId, new TokenBucket(ACTION_RATE, ACTION_WINDOW_MS, now));
    this.rtcBuckets.set(client.sessionId, new TokenBucket(RTC_SIGNAL_RATE, RTC_SIGNAL_WINDOW_MS, now));
    this.wbBuckets.set(client.sessionId, new TokenBucket(WB_RATE, WB_WINDOW_MS, now));

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
      floorId: this.spawnFloorId,
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
      // Floor-scoped: only co-located players (the joiner spawns on the main office).
      players: this.othersOnFloor(client.sessionId, this.spawnFloorId),
      events: this.activeEventsOnFloor(this.spawnFloorId, now),
      meeting: currentMeeting,
      building: this.buildingSummary(),
    };
    // Colyseus completes the matchmake/join response before the client wrapper
    // has a concrete Room instance to bind retained onMessage handlers to. Send
    // the first room messages on the next tick so the browser cannot miss the
    // bootstrap packet and get stuck after a successful websocket join.
    this.clock.setTimeout(() => {
      client.send(S2C.WELCOME, welcome);

      // Push the state of all active games to the newly joined player.
      for (const game of this.games.values()) {
        client.send(S2C.GAME_UPDATE, { game });
      }
    }, 0);

    // Tell everyone ELSE ON THIS FLOOR the player joined (carries presence).
    const joined: PlayerJoinedPayload = { player: { ...snapshot } };
    this.broadcastToFloorExcept(client, this.spawnFloorId, S2C.PLAYER_JOINED, joined);

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
    const leavingFloorId = leaving?.floorId ?? this.groundFloorId;
    log.info("player left", { name: leaving?.name, sessionId, online: this.players.size - 1 });
    container.presence.untrack(sessionId);
    container.events.removeParticipant(sessionId);
    
    // Remove the leaving player from any active game rooms.
    for (const game of this.games.values()) {
      if (game.player1?.sessionId === sessionId || game.player2?.sessionId === sessionId) {
        this.leaveGame(game, sessionId);
      }
    }

    this.players.delete(sessionId);
    this.sessionUser.delete(sessionId);
    // Drop the transient IP + sync flag (privacy: nothing about the IP outlives
    // the session — it was never logged or persisted in the first place).
    this.sessionIp.delete(sessionId);
    this.locationSync.delete(sessionId);
    // Invalidate any companion pairing code so it cannot resolve to a gone
    // session (privacy: the transient code -> {sessionId,userId} entry is
    // dropped the moment the session leaves).
    container.pairCodes.invalidateSession(sessionId);
    this.homeSeat.delete(sessionId);
    this.meetingSlots.releaseEverywhere(sessionId);
    this.moveBuckets.delete(sessionId);
    this.chatBuckets.delete(sessionId);
    this.actionBuckets.delete(sessionId);
    this.rtcBuckets.delete(sessionId);
    this.wbBuckets.delete(sessionId);
    // Drop this session from every whiteboard it was viewing (no broadcast
    // needed — viewers are not shown a live presence list of the board).
    for (const subs of this.wbSubs.values()) subs.delete(sessionId);
    this.joining.delete(sessionId);

    const left: PlayerLeftPayload = { sessionId };
    // Floor-scoped: only co-located players need to forget this avatar.
    this.broadcastToFloor(leavingFloorId, S2C.PLAYER_LEFT, left);
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
    this.onMessage(C2S.EMOTE, (client, payload: EmotePayload) => this.handleEmote(client, payload));
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
    this.onMessage(C2S.UPDATE_PROFILE, (client, payload: UpdateProfilePayload) =>
      this.handleUpdateProfile(client, payload),
    );
    this.onMessage(C2S.SET_LOCATION_SYNC, (client, payload: SetLocationSyncPayload) =>
      this.handleSetLocationSync(client, payload),
    );
    this.onMessage(C2S.RTC_CALL, (client, payload: RtcCallC2S) => this.handleRtcCall(client, payload));
    this.onMessage(C2S.RTC_SIGNAL, (client, payload: RtcSignalC2S) =>
      this.handleRtcSignal(client, payload),
    );
    this.onMessage(C2S.WHITEBOARD_OPEN, (client, payload: WhiteboardOpenC2S) =>
      this.handleWhiteboardOpen(client, payload),
    );
    this.onMessage(C2S.WHITEBOARD_CLOSE, (client, payload: WhiteboardCloseC2S) =>
      this.handleWhiteboardClose(client, payload),
    );
    this.onMessage(C2S.WHITEBOARD_UPDATE, (client, payload: WhiteboardUpdateC2S) =>
      this.handleWhiteboardUpdate(client, payload),
    );
    this.onMessage(C2S.WHITEBOARD_CLEAR, (client, payload: WhiteboardClearC2S) =>
      this.handleWhiteboardClear(client, payload),
    );
    this.onMessage(C2S.JOIN_GAME, (client, payload: any) => this.handleJoinGame(client, payload));
    this.onMessage(C2S.LEAVE_GAME, (client, payload: any) => this.handleLeaveGame(client, payload));
    this.onMessage(C2S.GAME_INPUT, (client, payload: any) => this.handleGameInput(client, payload));

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

    const floorId = snap.floorId ?? this.groundFloorId;
    const map = this.floors.get(floorId);
    if (!map) return;

    const x = payload?.x;
    const y = payload?.y;
    const dir = payload?.dir;
    const moving = !!payload?.moving;

    const valid =
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      isValidDir(dir) &&
      isWalkable(map, x, y) &&
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

    // Did this committed step land on a portal? If so, the player's OWN movement
    // (human agency: never automatic) carries them to the target floor.
    const portal = portalAt(map as Floor, x, y);
    if (portal && this.floors.has(portal.toFloorId)) {
      // Broadcast the final step on the OLD floor first so co-located players
      // see the avatar reach the portal tile, then perform the crossing.
      const moved: PlayerMovedPayload = { sessionId: client.sessionId, x, y, dir, moving: false };
      this.broadcastToFloorExcept(client, floorId, S2C.PLAYER_MOVED, moved);
      // Resolve a FREE landing tile near the portal target so concurrent riders
      // do not stack on the identical arrival tile (occupancy-aware, scoped to
      // the destination floor — mirrors assignSpawn / the consented-move path).
      const dest = this.floors.get(portal.toFloorId)!;
      const land = this.freeTileNear(dest, portal.toX, portal.toY);
      this.changeFloor(client, snap, floorId, portal.toFloorId, land.x, land.y, dir);
      return;
    }

    const moved: PlayerMovedPayload = { sessionId: client.sessionId, x, y, dir, moving };
    this.broadcastToFloorExcept(client, floorId, S2C.PLAYER_MOVED, moved);
  }

  /**
   * Move a player from one floor to another after they stepped onto a portal.
   * Human agency is preserved: this ONLY ever runs as the direct result of the
   * player's own committed MOVE onto a portal tile — never automatically.
   *
   * Sequencing:
   *   - PLAYER_LEFT to the OLD floor's other occupants (the avatar is gone).
   *   - mutate the snapshot's floor + position.
   *   - PLAYER_JOINED to the NEW floor's other occupants (the avatar arrives).
   *   - FLOOR_CHANGED to the mover with the new floor's full player + event set.
   */
  private changeFloor(
    client: Client,
    snap: PlayerSnapshot,
    fromFloorId: string,
    toFloorId: string,
    toX: number,
    toY: number,
    dir: Direction,
  ): void {
    const now = Date.now();

    // Tell the OLD floor this avatar left it.
    const left: PlayerLeftPayload = { sessionId: client.sessionId };
    this.broadcastToFloorExcept(client, fromFloorId, S2C.PLAYER_LEFT, left);

    // Apply the crossing to the authoritative snapshot.
    snap.floorId = toFloorId;
    snap.x = toX;
    snap.y = toY;
    snap.dir = dir;

    // Tell the NEW floor this avatar arrived.
    const joined: PlayerJoinedPayload = { player: { ...snap } };
    this.broadcastToFloorExcept(client, toFloorId, S2C.PLAYER_JOINED, joined);

    // Tell the mover about their new surroundings (full re-sync of the floor).
    const payload: FloorChangedPayload = {
      selfFloorId: toFloorId,
      x: toX,
      y: toY,
      dir,
      players: this.othersOnFloor(client.sessionId, toFloorId),
      events: this.activeEventsOnFloor(toFloorId, now),
    };
    client.send(S2C.FLOOR_CHANGED, payload);

    log.info("player changed floor", {
      sessionId: client.sessionId,
      from: fromFloorId,
      to: toFloorId,
    });
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

  /**
   * Apply a self-profile edit (name / department / avatar): update the snapshot,
   * persist it, and broadcast PLAYER_UPDATED. Never moves the avatar.
   */
  private handleUpdateProfile(client: Client, payload: UpdateProfilePayload): void {
    if (!this.allow(this.actionBuckets, client.sessionId)) return;
    const snap = this.players.get(client.sessionId);
    if (!snap || snap.isNpc) return; // NPCs never edit profiles

    let changed = false;
    if (typeof payload?.name === "string") {
      const name = payload.name.trim().slice(0, MAX_NAME);
      if (name.length > 0 && name !== snap.name) {
        snap.name = name;
        changed = true;
      }
    }
    if (
      typeof payload?.department === "string" &&
      (DEPARTMENTS as readonly string[]).includes(payload.department) &&
      payload.department !== snap.department
    ) {
      snap.department = payload.department as Department;
      changed = true;
    }
    if (
      typeof payload?.avatarId === "string" &&
      (AVATAR_IDS as readonly string[]).includes(payload.avatarId) &&
      payload.avatarId !== snap.avatarId
    ) {
      snap.avatarId = payload.avatarId as AvatarId;
      changed = true;
    }
    if (!changed) return;

    // Persist to the user record (best-effort) so the edit survives sessions.
    void container.users.save({
      id: snap.userId,
      name: snap.name,
      department: snap.department,
      avatarId: snap.avatarId,
    });

    const updated: PlayerUpdatedPayload = {
      sessionId: client.sessionId,
      name: snap.name,
      department: snap.department,
      avatarId: snap.avatarId,
    };
    // Floor-scoped: only co-located players render this avatar.
    this.broadcastToFloor(snap.floorId ?? this.groundFloorId, S2C.PLAYER_UPDATED, updated);
  }

  /**
   * Toggle OPT-IN physical-floor sync (human agency + privacy).
   *
   * ON (enabled=true): classify the user's IP (Office/Remote), tag the snapshot,
   *   broadcast S2C.LOCATION (floor-scoped). If the classification is OFFICE and
   *   the IP maps to a REAL floor different from the user's current one, perform
   *   the SAME server-side floor change the elevator uses — this is CONSENTED
   *   (the user flipped the switch), not surveillance. When no office subnets are
   *   configured (Noop adapter) every IP classifies REMOTE and nothing moves.
   * OFF (enabled=false): clear `place` back to absent, broadcast a CLEARED
   *   S2C.LOCATION, and NEVER move the avatar.
   *
   * Counts as activity (clears auto-AWAY). Rejects NPCs. Rate-limited via the
   * shared action bucket. PRIVACY: the IP is read for classification only and is
   * never logged or persisted here.
   */
  private handleSetLocationSync(client: Client, payload: SetLocationSyncPayload): void {
    if (!this.allow(this.actionBuckets, client.sessionId)) return;
    const snap = this.players.get(client.sessionId);
    if (!snap || snap.isNpc) return; // NPCs never sync a location
    if (typeof payload?.enabled !== "boolean") return;

    container.presence.activity(client.sessionId, Date.now());

    if (!payload.enabled) {
      // Turn sync OFF: clear the tag, tell co-located clients to drop the badge.
      // Never moves the avatar. Invalidate any pairing code (privacy: the
      // code -> {sessionId,userId} entry must not outlive the opt-in).
      this.locationSync.set(client.sessionId, false);
      container.pairCodes.invalidateSession(client.sessionId);
      if (snap.place === undefined) return; // already off — nothing to broadcast
      snap.place = undefined;
      const cleared: LocationPayload = {
        sessionId: client.sessionId,
        place: "REMOTE", // legacy hint for older clients; `cleared` is authoritative
        cleared: true,
      };
      this.broadcastToFloor(snap.floorId ?? this.groundFloorId, S2C.LOCATION, cleared);
      return;
    }

    // Turn sync ON: classify the transient IP (never logged/persisted).
    this.locationSync.set(client.sessionId, true);

    // Mint (or refresh) this session's companion PAIRING CODE and hand it to
    // THIS client only. The user pastes it into the companion
    // (FLOOR_SYNC_PAIR_CODE) so a floor report resolves to THIS exact session
    // regardless of IP (fixes NAT / Docker / localhost multi-tab collisions).
    // PRIVACY: the code maps only to {sessionId,userId} in memory with a TTL;
    // it is never logged here (we do NOT include it in any log line).
    const userId = this.sessionUser.get(client.sessionId);
    if (userId) {
      const code = container.pairCodes.mint(client.sessionId, userId, Date.now());
      const codePayload: FloorSyncCodePayload = { code };
      client.send(S2C.FLOOR_SYNC_CODE, codePayload);
    }

    const ip = this.sessionIp.get(client.sessionId);
    const place = container.floorLocation.classify(ip);
    snap.place = place;

    // Broadcast the new tag FLOOR-SCOPED (co-located clients only).
    const location: LocationPayload = { sessionId: client.sessionId, place };
    this.broadcastToFloor(snap.floorId ?? this.groundFloorId, S2C.LOCATION, location);

    // Consented floor move: only when OFFICE and the IP maps to a real floor that
    // differs from the current one. Reuses the elevator's floor-change machinery
    // (PLAYER_LEFT/JOINED + FLOOR_CHANGED). Human agency holds: the user opted in.
    if (place !== "OFFICE") return;
    const detected = container.floorLocation.detectFloorId(ip);
    if (!detected || !this.floors.has(detected)) return;
    const currentFloorId = snap.floorId ?? this.groundFloorId;
    if (detected === currentFloorId) return;
    const target = this.floors.get(detected)!;
    const spawn = this.assignSpawn(target, snap.department);
    this.changeFloor(client, snap, currentFloorId, detected, spawn.x, spawn.y, snap.dir);
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
    // Floor-scoped: chat is local to the floor the speaker stands on.
    this.broadcastToFloor(snap.floorId ?? this.groundFloorId, S2C.CHAT, out);
  }

  private handleEmote(client: Client, payload: EmotePayload): void {
    // Emotes are an explicit social action — guard with the SAME per-session
    // action token-bucket as SET_STATUS / JOIN_* so a client cannot flood the
    // fan-out. Over-limit emotes are dropped, never broadcast.
    if (!this.allow(this.actionBuckets, client.sessionId)) return;
    const snap = this.players.get(client.sessionId);
    if (!snap) return; // unknown/already-left session
    const emote = payload?.emote;
    if (!isValidEmote(emote)) return; // drop unknown/garbage emotes

    // Emoting counts as activity (clears auto-AWAY), like chat/status.
    container.presence.activity(client.sessionId, Date.now());

    // Broadcast to ALL ON THIS FLOOR including the sender (own bubble).
    const out: EmoteBroadcastPayload = { sessionId: client.sessionId, emote };
    this.broadcastToFloor(snap.floorId ?? this.groundFloorId, S2C.EMOTE, out);
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

    // Seat the player on the floor the event belongs to. They must already be on
    // that floor (the client only shows events for the floor it is rendering).
    const snap = this.players.get(client.sessionId);
    const floorId = this.eventFloor.get(eventId) ?? snap?.floorId ?? this.mainOfficeFloorId;
    const map = this.floors.get(floorId) ?? this.floors.get(this.mainOfficeFloorId)!;
    const anchor = anchorFor(map, result.event.areaName, result.anchorIndex);
    this.teleport(client.sessionId, anchor.x, anchor.y);

    // Teleport visible to ALL ON THE FLOOR (including the sender — they clicked Join).
    const tp: PlayerTeleportedPayload = { sessionId: client.sessionId, x: anchor.x, y: anchor.y };
    this.broadcastToFloor(floorId, S2C.PLAYER_TELEPORTED, tp);

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

    // Record the explicit Join (human agency) so an "everyone" meeting that was
    // already in progress when this user joined now drives their presence too.
    container.presence.markMeetingJoined(client.sessionId, meeting.id);

    // Allocate the lowest free seat slot for this meeting (idempotent on
    // re-join; freed slots are reused without colliding with an occupant). The
    // meeting room is seated on the player's CURRENT floor (meetings are
    // per-floor; the meeting room name resolves against that floor's anchors,
    // falling back to the MAIN OFFICE floor — which owns the named meeting rooms
    // — if the player's floor lacks the room).
    const snap = this.players.get(client.sessionId);
    const floorId = snap?.floorId ?? this.spawnFloorId;
    let map = this.floors.get(floorId) ?? this.floors.get(this.mainOfficeFloorId)!;
    if (!map.anchors[meeting.roomName]) {
      map = this.floors.get(this.mainOfficeFloorId)!;
    }
    const seatIndex = this.meetingSlots.assign(meeting.id, client.sessionId);
    const anchor = anchorFor(map, meeting.roomName, seatIndex);
    this.teleport(client.sessionId, anchor.x, anchor.y);

    // Visible to ALL ON THE FLOOR. Do NOT change manual status — IN_MEETING comes
    // from the calendar source already (the presence engine handles it).
    const tp: PlayerTeleportedPayload = { sessionId: client.sessionId, x: anchor.x, y: anchor.y };
    this.broadcastToFloor(snap?.floorId ?? this.groundFloorId, S2C.PLAYER_TELEPORTED, tp);
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
    const snap = this.players.get(client.sessionId);
    // The home seat is a desk on the MAIN OFFICE floor (where the player spawned).
    // If the player wandered to another floor, returning them to their desk also
    // returns them to the main office floor (via the same floor-change machinery).
    if (snap && (snap.floorId ?? this.groundFloorId) !== this.spawnFloorId) {
      this.changeFloor(client, snap, snap.floorId ?? this.groundFloorId, this.spawnFloorId, seat.x, seat.y, "down");
      return;
    }
    this.teleport(client.sessionId, seat.x, seat.y);
    const tp: PlayerTeleportedPayload = { sessionId: client.sessionId, x: seat.x, y: seat.y };
    this.broadcastToFloor(this.spawnFloorId, S2C.PLAYER_TELEPORTED, tp);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * First free desk seat in the department on the given floor, else a ring-scan
   * fallback around that floor's spawn. Occupancy is scoped to players ON THAT
   * FLOOR so two players on different floors may share a tile coordinate.
   */
  private assignSpawn(map: Floor, department: PlayerSnapshot["department"]): { x: number; y: number } {
    const occupied = new Set<string>();
    for (const p of this.players.values()) {
      if ((p.floorId ?? this.groundFloorId) !== map.id) continue;
      occupied.add(`${p.x},${p.y}`);
    }
    for (const desk of map.desks) {
      if (desk.department !== department) continue;
      const key = `${desk.seatX},${desk.seatY}`;
      if (!occupied.has(key) && isWalkable(map, desk.seatX, desk.seatY)) {
        return { x: desk.seatX, y: desk.seatY };
      }
    }
    // No free desk: fall back to the first walkable, unoccupied tile found by a
    // deterministic ring scan outward from the fallback spawn so overflow users
    // do not stack on the exact same tile.
    const { x: sx, y: sy } = map.spawn;
    if (!occupied.has(`${sx},${sy}`) && isWalkable(map, sx, sy)) {
      return { x: sx, y: sy };
    }
    for (let r = 1; r < Math.max(map.width, map.height); r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          // Only the perimeter of the current ring (avoids re-checking inner rings).
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = sx + dx;
          const y = sy + dy;
          if (occupied.has(`${x},${y}`)) continue;
          if (isWalkable(map, x, y)) return { x, y };
        }
      }
    }
    // Last resort (map fully occupied): the fallback spawn.
    return { x: sx, y: sy };
  }

  /**
   * Resolve a FREE, walkable, NON-portal landing tile near (seedX,seedY) on
   * `map`, de-stacking concurrent arrivals. Occupancy is scoped to players ON
   * THAT FLOOR. Used by the elevator path so two riders crossing onto the same
   * portal target do not overlap (mirrors assignSpawn's ring-scan). Portal tiles
   * are skipped so a deposited rider never immediately re-triggers a crossing.
   */
  private freeTileNear(map: Floor, seedX: number, seedY: number): { x: number; y: number } {
    const occupied = new Set<string>();
    for (const p of this.players.values()) {
      if ((p.floorId ?? this.groundFloorId) !== map.id) continue;
      occupied.add(`${p.x},${p.y}`);
    }
    const usable = (x: number, y: number): boolean =>
      isWalkable(map, x, y) &&
      !occupied.has(`${x},${y}`) &&
      portalAt(map, x, y) === null;

    if (usable(seedX, seedY)) return { x: seedX, y: seedY };
    for (let r = 1; r < Math.max(map.width, map.height); r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = seedX + dx;
          const y = seedY + dy;
          if (usable(x, y)) return { x, y };
        }
      }
    }
    // Last resort (no free non-portal tile): the seed tile as-is.
    return { x: seedX, y: seedY };
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

  /** The active building's floor ids (for SSID->floor validation). */
  floorIds(): string[] {
    return this.building.floors.map((f) => f.id);
  }

  /**
   * Apply an SSID-derived floor report to live HUMAN sessions sharing `clientIp`
   * (the companion + browser run on the same machine, so they share a LAN IP).
   * The floor-report HTTP route is the ONLY caller; the room stays the only
   * Colyseus-aware module.
   *
   * For each matched session that has OPTED IN to floor sync (locationSync), set
   * place="OFFICE" and, when the resolved floor differs from the current one,
   * perform the SAME consented floor change the elevator/SET_LOCATION_SYNC path
   * uses (free landing tile, PLAYER_LEFT/JOINED + FLOOR_CHANGED), then broadcast
   * S2C.LOCATION (floor-scoped). Sessions that have NOT opted in are left
   * untouched (human agency + opt-in). Returns how many sessions were updated.
   *
   * PRIVACY (AGENTS.md Principle 1): `clientIp` is matched against the transient
   * per-session IP captured in onAuth and is NEVER logged or persisted here; the
   * SSID never reaches this method (it was resolved to a floor id upstream).
   */
  applyFloorReport(clientIp: string | undefined, floorId: string): number {
    if (!clientIp || !this.floors.has(floorId)) return 0;
    let matched = 0;
    // Snapshot the session ids first: changeFloor mutates while we iterate.
    const sessionIds = Array.from(this.sessionIp.keys());
    for (const sessionId of sessionIds) {
      if (this.sessionIp.get(sessionId) !== clientIp) continue;
      matched += this.applyFloorToSession(sessionId, floorId);
    }
    return matched;
  }

  /**
   * Apply an SSID-derived floor report to ONE explicitly identified session,
   * IGNORING IP. The floor-report HTTP route calls this when the companion sent
   * a valid PAIRING CODE (S2C.FLOOR_SYNC_CODE), which ties the report to the
   * exact session that minted it — fixing the IP-match ambiguity behind NAT, a
   * VPN egress, Docker, or several localhost tabs.
   *
   * The opt-in gate + consented-change + privacy rules are IDENTICAL to the
   * IP-matched path (it delegates to the same applyFloorToSession helper):
   * a code for a NOT-opted-in session is a benign no-op (returns 0). The caller
   * resolved code -> sessionId; this method never sees the code, IP, or SSID.
   */
  applyFloorReportBySession(sessionId: string, floorId: string): number {
    if (!this.floors.has(floorId)) return 0;
    return this.applyFloorToSession(sessionId, floorId);
  }

  /**
   * Apply the resolved floor to a single session IF it has opted in. Shared by
   * the IP-matched and pair-code paths. Returns 1 when applied, else 0. Performs
   * the consented floor change (when the floor differs) + the S2C.LOCATION tag.
   * PRIVACY: no IP/SSID/code is referenced here — only the live session state.
   */
  private applyFloorToSession(sessionId: string, floorId: string): number {
    // OPT-IN gate: only act for sessions that explicitly enabled floor sync.
    if (this.locationSync.get(sessionId) !== true) return 0;
    const snap = this.players.get(sessionId);
    if (!snap || snap.isNpc) return 0;
    const client = this.clientFor(sessionId);
    if (!client) return 0;

    // A floor report means the user is physically in the office.
    snap.place = "OFFICE";
    const currentFloorId = snap.floorId ?? this.groundFloorId;

    if (currentFloorId !== floorId) {
      // Consented floor change (the user opted in) — reuse elevator machinery.
      const target = this.floors.get(floorId)!;
      const land = this.freeTileNear(target, target.spawn.x, target.spawn.y);
      this.changeFloor(client, snap, currentFloorId, floorId, land.x, land.y, snap.dir);
    }

    // Broadcast the Office tag on the (possibly new) floor (co-located only).
    const location: LocationPayload = { sessionId, place: "OFFICE" };
    this.broadcastToFloor(snap.floorId ?? this.groundFloorId, S2C.LOCATION, location);
    return 1;
  }

  /** Other players (excluding `sessionId`) currently on `floorId`. */
  private othersOnFloor(sessionId: string, floorId: string): PlayerSnapshot[] {
    const out: PlayerSnapshot[] = [];
    for (const [id, p] of this.players) {
      if (id === sessionId) continue;
      if ((p.floorId ?? this.groundFloorId) !== floorId) continue;
      out.push({ ...p });
    }
    return out;
  }

  /** Active social events scoped to a floor (admin events default to ground). */
  private activeEventsOnFloor(floorId: string, now: number): SocialEvent[] {
    return container.events.activeEvents(now).filter((e) => {
      const ef = this.eventFloor.get(e.id) ?? this.mainOfficeFloorId;
      return ef === floorId;
    });
  }

  /** The active building's floor list (id/name/index) for the WELCOME payload. */
  private buildingSummary(): BuildingSummary {
    return {
      id: this.building.id,
      name: this.building.name,
      floors: this.building.floors.map((f) => ({ id: f.id, name: f.name, index: f.index })),
    };
  }

  private clientFor(sessionId: string): Client | undefined {
    return this.clients.find((c) => c.sessionId === sessionId);
  }

  /** The floorId a given client (human) is currently on. */
  private floorIdOfClient(client: Client): string {
    return this.players.get(client.sessionId)?.floorId ?? this.groundFloorId;
  }

  /** Send a message only to HUMAN clients currently on `floorId`. */
  private broadcastToFloor(floorId: string, type: string, message: unknown): void {
    for (const c of this.clients) {
      if (this.floorIdOfClient(c) === floorId) c.send(type, message);
    }
  }

  /** Send to HUMAN clients on `floorId` except `except`. */
  private broadcastToFloorExcept(
    except: Client,
    floorId: string,
    type: string,
    message: unknown,
  ): void {
    for (const c of this.clients) {
      if (c === except) continue;
      if (this.floorIdOfClient(c) === floorId) c.send(type, message);
    }
  }

  // -------------------------------------------------------------------------
  // Proximity voice/video signaling relay (P2P WebRTC).
  //
  // The room is a DUMB RELAY: it validates the target is a same-floor human and
  // forwards the opaque payload to that one peer. Media is peer-to-peer and
  // never touches the server. PRIVACY (Constitution: presence, not surveillance)
  // — we NEVER log who called whom, call kind, duration, or any call content.
  // -------------------------------------------------------------------------

  /**
   * Resolve the target client IFF it is a HUMAN currently on the SAME floor as
   * the sender (and not the sender themselves). Returns undefined otherwise so
   * the caller silently drops the relay. Same-floor is the hard gate; an
   * additional distance gate is applied only to call *requests* (see below).
   */
  private rtcPeer(client: Client, targetSessionId: unknown): Client | undefined {
    if (typeof targetSessionId !== "string" || targetSessionId === client.sessionId) return undefined;
    const me = this.players.get(client.sessionId);
    const them = this.players.get(targetSessionId);
    if (!me || me.isNpc || !them || them.isNpc) return undefined;
    const myFloor = me.floorId ?? this.groundFloorId;
    const theirFloor = them.floorId ?? this.groundFloorId;
    if (myFloor !== theirFloor) return undefined;
    return this.clientFor(targetSessionId);
  }

  /** Relay proximity call control (request/accept/reject/cancel/hangup). */
  private handleRtcCall(client: Client, payload: RtcCallC2S): void {
    if (!this.allow(this.actionBuckets, client.sessionId)) return;
    const kind = payload?.kind;
    const action = payload?.action;
    if (kind !== "audio" && kind !== "video") return;
    if (!RTC_CALL_ACTIONS.has(action)) return;

    const me = this.players.get(client.sessionId);
    if (!me || me.isNpc) return;
    const peer = this.rtcPeer(client, payload?.to);
    if (!peer) return;

    // Soft anti-spam gate: a call may only be INITIATED when the two avatars are
    // genuinely near (a touch wider than the UI's button radius so a click is
    // not lost to a one-tile drift). accept/reject/cancel/hangup are NOT
    // distance-gated so an in-progress call survives normal walking.
    if (action === "request") {
      const them = this.players.get(peer.sessionId)!;
      if (chebyshev(me.x, me.y, them.x, them.y) > CALL_REQUEST_TILES) return;
    }

    const out: RtcCallS2C = { from: client.sessionId, fromName: me.name, kind, action };
    peer.send(S2C.RTC_CALL, out);
  }

  /** Relay an opaque WebRTC signaling blob (SDP offer/answer or ICE) to a peer. */
  private handleRtcSignal(client: Client, payload: RtcSignalC2S): void {
    if (!this.allow(this.rtcBuckets, client.sessionId)) return;
    if (payload?.data === undefined) return;
    const peer = this.rtcPeer(client, payload?.to);
    if (!peer) return;
    const out: RtcSignalS2C = { from: client.sessionId, data: payload.data };
    peer.send(S2C.RTC_SIGNAL, out);
  }

  // -------------------------------------------------------------------------
  // Per-department collaborative whiteboards.
  //
  // `board` is a Department name. Boards are DEPARTMENT-scoped (a team spans
  // floors), not floor-scoped: strokes go to everyone currently VIEWING that
  // board. The server stores strokes (WhiteboardService) so a late opener gets
  // the full board. PRIVACY: only the drawing is kept — never who drew what.
  // -------------------------------------------------------------------------

  /** Subscriber set for a board (created on first open). */
  private wbSubscribers(board: string): Set<string> {
    let set = this.wbSubs.get(board);
    if (!set) {
      set = new Set();
      this.wbSubs.set(board, set);
    }
    return set;
  }

  /** Send to every HUMAN client currently viewing `board` except `exceptId`. */
  private broadcastToBoard(board: string, exceptId: string | null, type: string, message: unknown): void {
    const subs = this.wbSubs.get(board);
    if (!subs) return;
    for (const c of this.clients) {
      if (c.sessionId === exceptId) continue;
      if (subs.has(c.sessionId)) c.send(type, message);
    }
  }

  private handleWhiteboardOpen(client: Client, payload: WhiteboardOpenC2S): void {
    if (!this.allow(this.actionBuckets, client.sessionId)) return;
    const board = payload?.board;
    if (!WB_DEPARTMENTS.has(board)) return;
    const snap = this.players.get(client.sessionId);
    if (!snap || snap.isNpc) return;
    this.wbSubscribers(board).add(client.sessionId);
    const state: WhiteboardStateS2C = { board, elements: container.whiteboard.elements(board) };
    client.send(S2C.WHITEBOARD_STATE, state);
  }

  private handleWhiteboardClose(client: Client, payload: WhiteboardCloseC2S): void {
    const board = payload?.board;
    if (typeof board !== "string") return;
    this.wbSubs.get(board)?.delete(client.sessionId);
  }

  private handleWhiteboardUpdate(client: Client, payload: WhiteboardUpdateC2S): void {
    if (!this.allow(this.wbBuckets, client.sessionId)) return;
    const board = payload?.board;
    if (!WB_DEPARTMENTS.has(board)) return;
    const snap = this.players.get(client.sessionId);
    if (!snap || snap.isNpc) return;
    // Must be a viewer of the board to edit it (open it first).
    if (!this.wbSubs.get(board)?.has(client.sessionId)) return;
    const elements = sanitizeElements(payload?.elements);
    if (elements.length === 0) return;
    // Merge by version; only rebroadcast what actually changed (drops echoes).
    const applied = container.whiteboard.applyElements(board, elements);
    if (applied.length === 0) return;
    const out: WhiteboardUpdateS2C = { board, elements: applied };
    this.broadcastToBoard(board, client.sessionId, S2C.WHITEBOARD_UPDATE, out);
  }

  private handleWhiteboardClear(client: Client, payload: WhiteboardClearC2S): void {
    if (!this.allow(this.actionBuckets, client.sessionId)) return;
    const board = payload?.board;
    if (!WB_DEPARTMENTS.has(board)) return;
    const snap = this.players.get(client.sessionId);
    if (!snap || snap.isNpc) return;
    if (!this.wbSubs.get(board)?.has(client.sessionId)) return;
    container.whiteboard.clear(board);
    const out: WhiteboardClearS2C = { board };
    // Include the sender so every viewer (incl. the clearer's other tabs) resets.
    this.broadcastToBoard(board, null, S2C.WHITEBOARD_CLEAR, out);
  }

  // -------------------------------------------------------------------------
  // Lounge Games logic
  // -------------------------------------------------------------------------

  private handleJoinGame(client: Client, payload: { gameId: string; mode?: "ai" | "group" }): void {
    if (!this.allow(this.actionBuckets, client.sessionId)) return;
    const gameId = payload?.gameId;
    if (typeof gameId !== "string") return;
    const game = this.games.get(gameId);
    if (!game) return;

    const snap = this.players.get(client.sessionId);
    if (!snap) return;

    // A player already at THIS pool table as a human seat that is already full +
    // playing => extra joiners become spectators (no seat). They simply receive
    // the broadcast GAME_UPDATE like everyone else; nothing to do here.
    // Check if player is already in this game or another game
    for (const g of this.games.values()) {
      if (g.player1?.sessionId === client.sessionId || g.player2?.sessionId === client.sessionId) {
        return; // already in a game
      }
    }

    const gamePlayer: GamePlayer = {
      sessionId: client.sessionId,
      name: snap.name,
      avatarId: snap.avatarId,
    };

    if (game.type === "pool") {
      this.handleJoinPool(client, game, gamePlayer, payload?.mode);
      return;
    }

    if (!game.player1) {
      game.player1 = gamePlayer;
      game.status = "waiting";
    } else if (!game.player2) {
      game.player2 = gamePlayer;
      game.status = "playing";
      this.resetGameState(game);
    } else {
      return; // game is full
    }

    // Lock player's walking: set presence to FOCUS
    container.presence.activity(client.sessionId, Date.now());
    container.presence.setManual(client.sessionId, "FOCUS");
    container.presence.tick(Date.now());

    this.broadcast(S2C.GAME_UPDATE, { game });
  }

  /**
   * Pool join. Supports SOLO vs AI ("ai") and GROUP (two humans, then spectators).
   *   - Seat 1 empty: take it. If mode is "ai", seat 2 becomes the server AI and
   *     play starts immediately; otherwise wait for a second human.
   *   - Seat 1 a human, seat 2 empty, NOT vs-AI: take seat 2, play starts.
   *   - Both seats taken (or vs-AI in progress): spectator — no seat.
   * The AI never occupies a real client, so only humans get FOCUS presence.
   */
  private handleJoinPool(
    client: Client,
    game: ActiveGame,
    gamePlayer: GamePlayer,
    mode: "ai" | "group" | undefined,
  ): void {
    const result = joinPool(game, gamePlayer, mode);
    this.applyPoolLifecycle(game, result);
    // player1 always breaks, so the AI never needs scheduling at join time.
  }

  /** Apply a framework-free pool lifecycle decision: presence locks + broadcast. */
  private applyPoolLifecycle(game: ActiveGame, result: PoolLifecycleResult): void {
    for (const sid of result.lock) this.lockForGame(sid);
    for (const sid of result.unlock) {
      container.presence.setManual(sid, "AVAILABLE");
      container.presence.tick(Date.now());
    }
    if (result.spectator) {
      const c = this.clientFor(result.spectator);
      if (c) c.send(S2C.GAME_UPDATE, { game });
    }
    if (result.broadcast) this.broadcast(S2C.GAME_UPDATE, { game });
  }

  /** Set a human to FOCUS for the duration of a game (locks ambient walking UI). */
  private lockForGame(sessionId: string): void {
    container.presence.activity(sessionId, Date.now());
    container.presence.setManual(sessionId, "FOCUS");
    container.presence.tick(Date.now());
  }

  private resetGameState(game: ActiveGame): void {
    game.winnerSessionId = null;
    if (game.type === "ping-pong") {
      game.score1 = 0;
      game.score2 = 0;
      game.state = {
        ballX: 300,
        ballY: 200,
        paddle1Y: 160,
        paddle2Y: 160,
      };
      if (!this.pongInterval) {
        this.pongInterval = this.clock.setInterval(() => this.tickPong(), 40);
      }
    } else if (game.type === "tic-tac-toe") {
      game.state = {
        board: Array(9).fill(""),
        turn: game.player1!.sessionId,
      } as TicTacToeState;
    } else if (game.type === "connect-four") {
      game.state = {
        board: Array(6).fill(null).map(() => Array(7).fill("")),
        turn: game.player1!.sessionId,
      } as ConnectFourState;
    } else if (game.type === "pool") {
      game.score1 = 0;
      game.score2 = 0;
      // Player 1 always breaks.
      game.state = freshPoolState(game.player1!.sessionId);
    }
  }

  private handleLeaveGame(client: Client, payload: { gameId: string }): void {
    if (!this.allow(this.actionBuckets, client.sessionId)) return;
    const gameId = payload?.gameId;
    if (typeof gameId !== "string") return;
    const game = this.games.get(gameId);
    if (!game) return;
    this.leaveGame(game, client.sessionId);
  }

  private leaveGame(game: ActiveGame, sessionId: string): void {
    // Pool has its own lifecycle (AI seat + forfeit + AI timer cleanup).
    if (game.type === "pool") {
      this.leavePool(game, sessionId);
      return;
    }

    let removed = false;
    if (game.player1?.sessionId === sessionId) {
      game.player1 = null;
      removed = true;
    } else if (game.player2?.sessionId === sessionId) {
      game.player2 = null;
      removed = true;
    }

    if (removed) {
      container.presence.setManual(sessionId, "AVAILABLE");
      container.presence.tick(Date.now());

      if (game.status === "playing") {
        if (game.player1) {
          game.status = "waiting";
        } else if (game.player2) {
          game.status = "waiting";
        } else {
          game.status = "idle";
        }
      } else if (game.status === "waiting" || game.status === "gameover") {
        if (!game.player1 && !game.player2) {
          game.status = "idle";
        } else {
          game.status = "waiting";
        }
      }

      // If no active ping-pong game is running, stop interval
      let anyPongRunning = false;
      for (const g of this.games.values()) {
        if (g.type === "ping-pong" && g.status === "playing") {
          anyPongRunning = true;
        }
      }
      if (!anyPongRunning && this.pongInterval) {
        this.pongInterval.clear();
        this.pongInterval = undefined;
      }

      this.broadcast(S2C.GAME_UPDATE, { game });
    }
  }

  private tickPong(): void {
    const game = this.games.get("lounge:ping-pong");
    if (!game || game.status !== "playing" || !game.state) return;
    const state = game.state as PongState;

    // Move paddles
    const paddleSpeed = 8;
    const paddleHeight = 80;
    const courtHeight = 400;

    if (this.paddle1Dir === -1) {
      state.paddle1Y = Math.max(0, state.paddle1Y - paddleSpeed);
    } else if (this.paddle1Dir === 1) {
      state.paddle1Y = Math.min(courtHeight - paddleHeight, state.paddle1Y + paddleSpeed);
    }

    if (this.paddle2Dir === -1) {
      state.paddle2Y = Math.max(0, state.paddle2Y - paddleSpeed);
    } else if (this.paddle2Dir === 1) {
      state.paddle2Y = Math.min(courtHeight - paddleHeight, state.paddle2Y + paddleSpeed);
    }

    // Move ball
    state.ballX += this.pongVelX;
    state.ballY += this.pongVelY;

    // Bounce off top and bottom walls
    if (state.ballY <= 4) {
      state.ballY = 4;
      this.pongVelY = -this.pongVelY;
    } else if (state.ballY >= 396) {
      state.ballY = 396;
      this.pongVelY = -this.pongVelY;
    }

    // Bounce off paddles
    if (this.pongVelX < 0 && state.ballX <= 30 && state.ballX >= 20) {
      if (state.ballY >= state.paddle1Y && state.ballY <= state.paddle1Y + 80) {
        state.ballX = 30;
        this.pongVelX = -this.pongVelX;
        const hitOffset = (state.ballY - (state.paddle1Y + 40)) / 40;
        this.pongVelY = hitOffset * 6;
      }
    }

    if (this.pongVelX > 0 && state.ballX >= 570 && state.ballX <= 580) {
      if (state.ballY >= state.paddle2Y && state.ballY <= state.paddle2Y + 80) {
        state.ballX = 570;
        this.pongVelX = -this.pongVelX;
        const hitOffset = (state.ballY - (state.paddle2Y + 40)) / 40;
        this.pongVelY = hitOffset * 6;
      }
    }

    // Out of bounds
    if (state.ballX < 0) {
      game.score2++;
      this.resetBall();
    } else if (state.ballX > 600) {
      game.score1++;
      this.resetBall();
    }

    // Check game over
    if (game.score1 >= 5) {
      game.winnerSessionId = game.player1!.sessionId;
      game.status = "gameover";
      if (this.pongInterval) {
        this.pongInterval.clear();
        this.pongInterval = undefined;
      }
    } else if (game.score2 >= 5) {
      game.winnerSessionId = game.player2!.sessionId;
      game.status = "gameover";
      if (this.pongInterval) {
        this.pongInterval.clear();
        this.pongInterval = undefined;
      }
    }

    this.broadcast(S2C.GAME_UPDATE, { game });
  }

  private resetBall(): void {
    const game = this.games.get("lounge:ping-pong");
    if (!game || !game.state) return;
    const state = game.state as PongState;
    state.ballX = 300;
    state.ballY = 200;
    this.pongVelX = this.pongVelX > 0 ? -6 : 6;
    this.pongVelY = (Math.random() > 0.5 ? 1 : -1) * (2 + Math.random() * 3);
  }

  private handleGameInput(client: Client, payload: { gameId: string, input: any }): void {
    if (!this.allow(this.actionBuckets, client.sessionId)) return;
    const gameId = payload?.gameId;
    if (typeof gameId !== "string") return;
    const game = this.games.get(gameId);
    if (!game) return;

    const input = payload?.input;
    if (!input) return;

    // Rematch / "Play again": valid AFTER a pool game is over. Handled before the
    // "must be playing" gate so a finished table is never left locked. A seated
    // player resets the rack with the SAME seats and re-breaks.
    if (game.type === "pool" && input.rematch === true) {
      this.handlePoolRematch(client.sessionId, game);
      return;
    }

    if (game.status !== "playing") return;

    if (game.type === "pool") {
      this.handlePoolShot(client.sessionId, game, input);
      return;
    }

    if (game.type === "ping-pong") {
      const isPlayer1 = game.player1?.sessionId === client.sessionId;
      const isPlayer2 = game.player2?.sessionId === client.sessionId;
      if (!isPlayer1 && !isPlayer2) return;

      const dir = input.dir; // "up" | "down" | "stop"
      const val = dir === "up" ? -1 : dir === "down" ? 1 : 0;
      if (isPlayer1) {
        this.paddle1Dir = val;
      } else {
        this.paddle2Dir = val;
      }
    } else if (game.type === "tic-tac-toe") {
      const state = game.state as TicTacToeState;
      if (state.turn !== client.sessionId) return;

      const cellIndex = input.cellIndex;
      if (typeof cellIndex !== "number" || cellIndex < 0 || cellIndex > 8) return;
      if (state.board[cellIndex] !== "") return;

      const symbol = client.sessionId === game.player1!.sessionId ? "X" : "O";
      state.board[cellIndex] = symbol;

      if (this.checkTicTacToeWin(state.board, symbol)) {
        game.winnerSessionId = client.sessionId;
        // Credit the winner so the scoreboard / "Final Score" reflect the round
        // (mirrors ping-pong, which already increments score1/score2).
        if (client.sessionId === game.player1!.sessionId) game.score1++;
        else game.score2++;
        game.status = "gameover";
      } else if (state.board.every((c) => c !== "")) {
        game.winnerSessionId = null; // draw
        game.status = "gameover";
      } else {
        state.turn = client.sessionId === game.player1!.sessionId ? game.player2!.sessionId : game.player1!.sessionId;
      }

      this.broadcast(S2C.GAME_UPDATE, { game });
    } else if (game.type === "connect-four") {
      const state = game.state as ConnectFourState;
      if (state.turn !== client.sessionId) return;

      const colIndex = input.colIndex;
      if (typeof colIndex !== "number" || colIndex < 0 || colIndex > 6) return;

      let droppedRow = -1;
      for (let r = 5; r >= 0; r--) {
        if (state.board[r][colIndex] === "") {
          droppedRow = r;
          break;
        }
      }
      if (droppedRow === -1) return;

      const token = client.sessionId === game.player1!.sessionId ? "R" : "Y";
      state.board[droppedRow][colIndex] = token;

      if (this.checkConnectFourWin(state.board, token)) {
        game.winnerSessionId = client.sessionId;
        // Credit the winner so the scoreboard / "Final Score" reflect the round
        // (mirrors ping-pong, which already increments score1/score2).
        if (client.sessionId === game.player1!.sessionId) game.score1++;
        else game.score2++;
        game.status = "gameover";
      } else if (state.board.every((row) => row.every((c) => c !== ""))) {
        game.winnerSessionId = null; // draw
        game.status = "gameover";
      } else {
        state.turn = client.sessionId === game.player1!.sessionId ? game.player2!.sessionId : game.player1!.sessionId;
      }

      this.broadcast(S2C.GAME_UPDATE, { game });
    }
  }

  // -------------------------------------------------------------------------
  // 8-Ball Pool (server-authoritative; framework-free engine in games/pool/**).
  // -------------------------------------------------------------------------

  /**
   * Validate a human shot, simulate it deterministically, apply 8-ball rules,
   * broadcast the resulting animation state, then advance the turn (and schedule
   * the AI's reply in solo mode). Spectators are simply ignored as shooters.
   */
  private handlePoolShot(sessionId: string, game: ActiveGame, input: unknown): void {
    const state = game.state as PoolState | null;
    if (!state || state.animating) return; // mid-shot: drop input

    // Only the player whose turn it is may shoot. The AI shoots via its timer.
    if (state.currentTurn !== sessionId) return;
    // The shooter must occupy a real seat (not a spectator).
    if (game.player1?.sessionId !== sessionId && game.player2?.sessionId !== sessionId) return;

    const shot = this.parsePoolShot(input);
    if (!shot) return;

    this.applyPoolShot(game, sessionId, shot);
  }

  private parsePoolShot(input: unknown): PoolShotInput | null {
    if (!input || typeof input !== "object") return null;
    const i = input as Record<string, unknown>;
    const angleRad = i.angleRad;
    const power = i.power;
    if (typeof angleRad !== "number" || !Number.isFinite(angleRad)) return null;
    if (typeof power !== "number" || !Number.isFinite(power)) return null;
    const shot: PoolShotInput = {
      angleRad,
      power: Math.max(0, Math.min(1, power)),
    };
    if (typeof i.cueX === "number" && Number.isFinite(i.cueX)) shot.cueX = i.cueX;
    if (typeof i.cueY === "number" && Number.isFinite(i.cueY)) shot.cueY = i.cueY;
    return shot;
  }

  /**
   * Core shot pipeline shared by humans + AI. Simulates to rest, applies rules,
   * sets winner/score, broadcasts the animation, and schedules the AI if it is
   * the AI's turn next.
   */
  private applyPoolShot(game: ActiveGame, shooter: string, shot: PoolShotInput): void {
    const state = game.state as PoolState;
    const p1 = game.player1!.sessionId;
    const p2 = game.player2!.sessionId;
    const opponent = shooter === p1 ? p2 : p1;

    // Honor ball-in-hand re-spot before the shot (clamped on the client; we trust
    // only finite numbers inside the playfield-ish range — physics clamps anyway).
    const balls = state.balls.map((b) => ({ ...b }));
    if (state.ballInHand && typeof shot.cueX === "number" && typeof shot.cueY === "number") {
      const cue = balls.find((b) => b.id === 0);
      if (cue) {
        cue.pocketed = false;
        cue.x = shot.cueX;
        cue.y = shot.cueY;
        cue.vx = 0;
        cue.vy = 0;
      }
    } else if (state.ballInHand) {
      // Ball-in-hand but no placement given: re-spot a pocketed cue to the head spot.
      const cue = balls.find((b) => b.id === 0);
      if (cue && cue.pocketed) {
        cue.pocketed = false;
        cue.x = 50; // POOL_TABLE_W * 0.25
        cue.y = 50; // POOL_TABLE_H / 2
        cue.vx = 0;
        cue.vy = 0;
      }
    }

    const sim = applyShot(balls, shot.angleRad, shot.power);
    const result = resolveShot({ ...state, balls }, shooter, opponent, sim);

    const next = result.state;
    next.trajectory = sim.trajectory;
    game.state = next;

    if (result.winnerSessionId !== undefined) {
      game.winnerSessionId = result.winnerSessionId; // may be "AI"
      game.status = "gameover";
      // Cancel any pending AI timer for this game.
      const t = this.poolAiTimers.get(game.id);
      if (t) {
        t.clear();
        this.poolAiTimers.delete(game.id);
      }
      this.broadcast(S2C.GAME_UPDATE, { game });
      return;
    }

    this.broadcast(S2C.GAME_UPDATE, { game });

    // Solo vs AI: if it is now the AI's turn, schedule the AI's reply after a
    // short delay so the client can animate the human's shot first.
    if (game.vsAi && next.currentTurn === POOL_AI_SESSION_ID && game.status === "playing") {
      this.scheduleAiPoolTurn(game);
    }
  }

  /**
   * A player leaves/forfeits a pool game. Frees their seat, releases FOCUS, and:
   *   - cancels any pending AI timer for this game,
   *   - if a game was in progress with two seats, the remaining HUMAN seat wins
   *     by forfeit (vs-AI leaves simply end the game, no winner),
   *   - resets the table to idle once empty so the station frees up.
   */
  private leavePool(game: ActiveGame, sessionId: string): void {
    // Cancel a pending AI shot for this table before mutating seats.
    const timer = this.poolAiTimers.get(game.id);
    if (timer) {
      timer.clear();
      this.poolAiTimers.delete(game.id);
    }

    const result = leavePool(game, sessionId);
    this.applyPoolLifecycle(game, result);
  }

  /**
   * Rematch / "Play again". Valid only when the pool game is OVER and the
   * requester occupies a real seat (spectators and the AI cannot trigger it). The
   * SAME seats are kept (human-vs-AI or the two humans), the rack is reset, player1
   * re-breaks, status returns to "playing", and a fresh GAME_UPDATE is broadcast.
   * The table is never left in a terminal/locked state.
   */
  private handlePoolRematch(sessionId: string, game: ActiveGame): void {
    if (game.type !== "pool") return;

    // Cancel any stale AI timer before (potentially) re-racking.
    const t = this.poolAiTimers.get(game.id);
    if (t) {
      t.clear();
      this.poolAiTimers.delete(game.id);
    }

    const result = rematchPool(game, sessionId);
    if (!result.broadcast) return; // not allowed (not over / not seated / no opponent)
    this.applyPoolLifecycle(game, result);

    // If (somehow) the AI is to break, schedule it. With player1 always breaking
    // and the AI in seat 2, this is a no-op in practice.
    const st = game.state as PoolState | null;
    if (game.vsAi && st && st.currentTurn === POOL_AI_SESSION_ID) {
      this.scheduleAiPoolTurn(game);
    }
  }

  /** Schedule the AI's pool shot after a brief, animation-friendly delay. */
  private scheduleAiPoolTurn(game: ActiveGame): void {
    const existing = this.poolAiTimers.get(game.id);
    if (existing) existing.clear();
    const timer = this.clock.setTimeout(() => {
      this.poolAiTimers.delete(game.id);
      const g = this.games.get(game.id);
      if (!g || g.type !== "pool" || g.status !== "playing") return;
      if (!g.vsAi) return;
      const st = g.state as PoolState | null;
      if (!st || st.currentTurn !== POOL_AI_SESSION_ID) return;

      // Deterministic per-shot PRNG seed (advances each AI shot).
      const seed = (this.poolSeedCounter = (this.poolSeedCounter + 0x9e3779b1) | 0);
      const shot = pickShot(st, POOL_AI_SESSION_ID, this.poolAiDifficulty, makePrng(seed));
      this.applyPoolShot(g, POOL_AI_SESSION_ID, shot);
    }, 1400);
    this.poolAiTimers.set(game.id, timer);
  }

  private checkTicTacToeWin(board: string[], symbol: string): boolean {
    const lines = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8],
      [0, 3, 6], [1, 4, 7], [2, 5, 8],
      [0, 4, 8], [2, 4, 6]
    ];
    return lines.some((line) => line.every((idx) => board[idx] === symbol));
  }

  private checkConnectFourWin(board: string[][], token: string): boolean {
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 4; c++) {
        if (board[r][c] === token && board[r][c+1] === token && board[r][c+2] === token && board[r][c+3] === token) return true;
      }
    }
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 7; c++) {
        if (board[r][c] === token && board[r+1][c] === token && board[r+2][c] === token && board[r+3][c] === token) return true;
      }
    }
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        if (board[r][c] === token && board[r+1][c+1] === token && board[r+2][c+2] === token && board[r+3][c+3] === token) return true;
      }
    }
    for (let r = 3; r < 6; r++) {
      for (let c = 0; c < 4; c++) {
        if (board[r][c] === token && board[r-1][c+1] === token && board[r-2][c+2] === token && board[r-3][c+3] === token) return true;
      }
    }
    return false;
  }
}

function manhattan(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

function isValidDir(dir: unknown): dir is Direction {
  return dir === "up" || dir === "down" || dir === "left" || dir === "right";
}

/**
 * Validate an inbound batch of Excalidraw elements before merging/broadcasting.
 * We treat each element as opaque JSON but REQUIRE the reconcile keys (string
 * id, finite numeric version) and bound the batch + per-element size so a
 * malicious client cannot inject huge payloads. Malformed elements are dropped
 * individually; the surviving ones are returned.
 */
function sanitizeElements(raw: unknown): WhiteboardElement[] {
  if (!Array.isArray(raw)) return [];
  const out: WhiteboardElement[] = [];
  for (const item of raw.slice(0, WB_MAX_ELEMENTS_PER_MSG)) {
    if (!item || typeof item !== "object") continue;
    const el = item as Partial<WhiteboardElement>;
    if (typeof el.id !== "string" || el.id.length === 0 || el.id.length > 64) continue;
    if (typeof el.version !== "number" || !Number.isFinite(el.version)) continue;
    let size = 0;
    try {
      size = JSON.stringify(item).length;
    } catch {
      continue; // not serializable (circular / BigInt) — reject
    }
    if (size > WB_MAX_ELEMENT_BYTES) continue;
    out.push(item as WhiteboardElement);
  }
  return out;
}

const EMOTE_SET: ReadonlySet<string> = new Set(EMOTES);

/** True only for a known emote token. Pure helper (exported for tests). */
export function isValidEmote(emote: unknown): emote is Emote {
  return typeof emote === "string" && EMOTE_SET.has(emote);
}
