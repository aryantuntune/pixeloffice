// ---------------------------------------------------------------------------
// Ambient office NPCs — framework-free behavior service.
//
// This service owns a roster of server-driven NPC "players" that wander, take
// coffee breaks, occasionally join active social events, and rarely chat. They
// exist purely so the office never feels empty — they are AMBIENCE, not fake
// coworkers:
//   - NPCs NEVER join meetings, never touch HR, never respond to humans.
//   - NPCs never auto-move a HUMAN avatar (human agency is untouched).
//   - No surveillance: NPCs track nothing about real users.
//
// It is intentionally Colyseus-free. `tick(nowMs, activeEvents)` advances every
// NPC's behavior and RETURNS an array of EFFECTS. The OfficeRoom (the only
// Colyseus seam) translates those effects into wire broadcasts. Determinism is
// achieved by injecting BOTH the clock (`now` passed to tick) and a seeded PRNG
// (constructor) — the service never reads the global clock or Math.random.
// ---------------------------------------------------------------------------

import {
  PresenceState,
  type AvatarId,
  type Department,
  type Direction,
  type OfficeMap,
  type PlayerSnapshot,
  type PresenceSource,
  type SocialEvent,
} from "@pixeloffice/shared";
import { isWalkable } from "@pixeloffice/shared";

/** A tiny, fast, fully-deterministic PRNG (mulberry32). Returns [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Behavior state machine for a single NPC. */
export type NpcBehavior =
  | "AT_DESK"
  | "WANDERING"
  | "COFFEE"
  | "AT_EVENT"
  | "RETURNING";

/** A live NPC record. Coordinates are TILE coordinates. */
export interface NpcRecord {
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
  homeSeat: { x: number; y: number };
  behavior: NpcBehavior;
  /** Tile path the NPC is currently walking (consumed one step per tick-step). */
  path: Array<{ x: number; y: number }>;
  /** Final destination tile of the active trip (coffee/event/return target). */
  target: { x: number; y: number } | null;
  /** ms timestamp after which the current behavior may transition. */
  nextDecisionAt: number;
  /** When AT_EVENT, the event being attended (so we leave when it ends). */
  eventId: string | null;
  /** Desk focus/available flips on this schedule (ms timestamp). */
  nextDeskFlipAt: number;
}

/** Effects returned by tick() for the room to translate into wire messages. */
export type NpcEffect =
  | { kind: "move"; sessionId: string; x: number; y: number; dir: Direction; moving: boolean }
  | { kind: "presence"; sessionId: string; state: PresenceState; source: PresenceSource }
  | { kind: "chat"; sessionId: string; name: string; text: string };

interface RosterEntry {
  name: string;
  department: Department;
  avatarId: AvatarId;
}

/** 8 charming defaults spread across all four departments, distinct avatars. */
const DEFAULT_ROSTER: RosterEntry[] = [
  { name: "Pixel Pete", department: "Engineering", avatarId: "emerald" },
  { name: "Buggy Bao", department: "Engineering", avatarId: "ruby" },
  { name: "Maple Quinn", department: "Product", avatarId: "sapphire" },
  { name: "Sundae Sol", department: "Product", avatarId: "amber" },
  { name: "Indigo Wren", department: "Design", avatarId: "violet" },
  { name: "Coco Reyes", department: "Design", avatarId: "slate" },
  { name: "Tilly Park", department: "HR", avatarId: "amber" },
  { name: "Benji Frost", department: "HR", avatarId: "sapphire" },
];

const CHAT_LINES = [
  "anyone for coffee? ☕",
  "shipping it 🚀",
  "brb, refilling",
  "great standup today!",
  "who moved my mug 😅",
  "love this view",
  "happy Friday, team",
  "need a caffeine top-up",
];

// Behavior timing (ms). Generous so the office feels calm, not frantic. These
// are wall-clock durations; the room ticks ~every 3s so steps are paced.
const WANDER_MIN_MS = 20_000;
const WANDER_MAX_MS = 90_000;
const WANDER_STEPS_MIN = 2;
const WANDER_STEPS_MAX = 6;
const COFFEE_LINGER_MS = 30_000;
const DESK_FLIP_MIN_MS = 120_000; // 2 min
const DESK_FLIP_MAX_MS = 300_000; // 5 min
const COFFEE_CHANCE = 0.15; // chance a decision becomes a coffee trip vs wander
const STEPS_PER_TICK = 2; // at most this many move effects per NPC per tick
const CHAT_COOLDOWN_MS = 120_000; // ≤ ~1 canned line per 2 min across ALL NPCs
const CHAT_CHANCE = 0.25; // when eligible + in coffee/lounge

/**
 * Ambient NPC behavior engine. Construct ONCE (the container owns it), give it
 * the office map + a seeded PRNG, then call spawnAll() at room create and
 * tick(now, activeEvents) on the room's clock interval.
 */
export class NpcService {
  private readonly map: OfficeMap;
  private readonly rng: () => number;
  private readonly count: number;
  private readonly npcs = new Map<string, NpcRecord>();
  /** Pre-resolved walkable coffee/lounge destination tiles (chat + trips). */
  private readonly coffeeTiles: Array<{ x: number; y: number }>;
  private readonly loungeTiles: Array<{ x: number; y: number }>;
  /** Last time ANY NPC emitted a canned chat line (rarity cap across all). */
  private lastChatAt = -Infinity;

  /**
   * @param map     office map (collision + anchors); source of walkable tiles.
   * @param rng     seeded PRNG returning [0,1) — injected for determinism.
   * @param count   number of NPCs to spawn (clamped 0..16; 0 disables).
   */
  constructor(map: OfficeMap, rng: () => number, count: number) {
    this.map = map;
    this.rng = rng;
    this.count = clampCount(count);
    this.coffeeTiles = walkableAnchorsOrArea(map, "Coffee Area");
    this.loungeTiles = walkableAnchorsOrArea(map, "Lounge");
  }

  /** Read-only snapshot of NPC sessionIds (for the room's NPC guards). */
  npcSessionIds(): Set<string> {
    return new Set(this.npcs.keys());
  }

  isNpc(sessionId: string): boolean {
    return this.npcs.has(sessionId);
  }

  /** Number of NPCs currently attending a social event (the ≤2 cap subject). */
  eventAttendeeCount(): number {
    return this.countAttendees();
  }

  /**
   * Build the roster and seat each NPC at a desk. Returns the PlayerSnapshots so
   * the room can insert them into its player map (they then ride out on WELCOME
   * naturally — no join broadcast needed at create). Idempotent-ish: calling it
   * again would re-add; the room calls it exactly once in onCreate.
   */
  spawnAll(nowMs: number): PlayerSnapshot[] {
    const snapshots: PlayerSnapshot[] = [];
    if (this.count === 0) return snapshots;

    const roster = DEFAULT_ROSTER.slice(0, this.count);
    const seats = this.assignSeats(roster);

    roster.forEach((entry, i) => {
      const sessionId = `npc-${i + 1}`;
      const seat = seats[i];
      // First desk flip is the AVAILABLE/FOCUS schedule; start AVAILABLE.
      const npc: NpcRecord = {
        sessionId,
        userId: `npc-user-${i + 1}`,
        name: entry.name,
        department: entry.department,
        avatarId: entry.avatarId,
        x: seat.x,
        y: seat.y,
        dir: "down",
        presence: PresenceState.AVAILABLE,
        source: "SYSTEM",
        homeSeat: { x: seat.x, y: seat.y },
        behavior: "AT_DESK",
        path: [],
        target: null,
        nextDecisionAt: nowMs + this.randRange(WANDER_MIN_MS, WANDER_MAX_MS),
        eventId: null,
        nextDeskFlipAt: nowMs + this.randRange(DESK_FLIP_MIN_MS, DESK_FLIP_MAX_MS),
      };
      this.npcs.set(sessionId, npc);
      snapshots.push(this.toSnapshot(npc));
    });

    return snapshots;
  }

  /** Current NPC players as wire snapshots (for any read model). */
  listSnapshots(): PlayerSnapshot[] {
    return Array.from(this.npcs.values()).map((n) => this.toSnapshot(n));
  }

  /**
   * Advance every NPC by one room tick. Returns the effects the room must
   * broadcast. `activeEvents` lets idle NPCs drift to a live social event and
   * leave when it ends. Pure w.r.t. the global clock — `nowMs` is injected.
   */
  tick(nowMs: number, activeEvents: SocialEvent[] = []): NpcEffect[] {
    const effects: NpcEffect[] = [];
    const activeById = new Map(activeEvents.map((e) => [e.id, e]));

    // Choose at most ONE social event for new attendees this tick; 1-2 idle
    // NPCs may drift to it (we cap joiners at 2 total currently attending).
    const targetEvent = this.pickJoinableEvent(activeEvents);

    for (const npc of this.npcs.values()) {
      this.advance(npc, nowMs, activeById, targetEvent, effects);
    }
    return effects;
  }

  // -------------------------------------------------------------------------
  // Per-NPC state machine
  // -------------------------------------------------------------------------

  private advance(
    npc: NpcRecord,
    nowMs: number,
    activeById: Map<string, SocialEvent>,
    targetEvent: SocialEvent | null,
    effects: NpcEffect[],
  ): void {
    // If attending an event that has ended, head back to the desk.
    if (npc.behavior === "AT_EVENT" && (!npc.eventId || !activeById.has(npc.eventId))) {
      this.beginReturn(npc, nowMs);
    }

    switch (npc.behavior) {
      case "AT_DESK": {
        this.maybeFlipDesk(npc, nowMs, effects);
        if (nowMs < npc.nextDecisionAt) return;
        // Decision time: maybe join an event, else coffee, else a short wander.
        if (targetEvent && this.countAttendees() < 2 && this.chance(0.5)) {
          this.beginEventTrip(npc, targetEvent);
        } else if (this.chance(COFFEE_CHANCE) && this.coffeeTiles.length > 0) {
          this.beginCoffeeTrip(npc);
        } else {
          this.beginWander(npc);
        }
        // Re-schedule the next decision regardless of branch.
        npc.nextDecisionAt = nowMs + this.randRange(WANDER_MIN_MS, WANDER_MAX_MS);
        return;
      }

      case "WANDERING": {
        const done = this.walkSteps(npc, effects);
        if (done) {
          // Arrived (or stuck): go back to the desk.
          this.beginReturn(npc, nowMs);
        }
        return;
      }

      case "COFFEE": {
        if (npc.path.length > 0) {
          const arrived = this.walkSteps(npc, effects);
          if (arrived) {
            // Reached the coffee spot: BREAK + linger, maybe chat.
            this.setPresence(npc, PresenceState.BREAK, "SYSTEM", effects);
            npc.nextDecisionAt = nowMs + COFFEE_LINGER_MS;
            this.maybeChat(npc, nowMs, effects);
          }
          return;
        }
        // Lingering: chat occasionally, then return when the timer expires.
        this.maybeChat(npc, nowMs, effects);
        if (nowMs >= npc.nextDecisionAt) {
          this.beginReturn(npc, nowMs);
        }
        return;
      }

      case "AT_EVENT": {
        if (npc.path.length > 0) {
          const arrived = this.walkSteps(npc, effects);
          if (arrived) {
            this.setPresence(npc, PresenceState.BREAK, "SYSTEM", effects);
            this.maybeChat(npc, nowMs, effects);
          }
          return;
        }
        // Idle at the event; chat occasionally. We leave when it ends (handled
        // at the top of advance()).
        this.maybeChat(npc, nowMs, effects);
        return;
      }

      case "RETURNING": {
        const done = this.walkSteps(npc, effects);
        if (done) {
          npc.behavior = "AT_DESK";
          npc.target = null;
          npc.eventId = null;
          // Back at the desk: resolve presence to AVAILABLE (or its desk mode).
          this.setPresence(npc, PresenceState.AVAILABLE, "SYSTEM", effects);
          npc.nextDecisionAt = nowMs + this.randRange(WANDER_MIN_MS, WANDER_MAX_MS);
          npc.nextDeskFlipAt = nowMs + this.randRange(DESK_FLIP_MIN_MS, DESK_FLIP_MAX_MS);
        }
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Behavior transitions
  // -------------------------------------------------------------------------

  /** Flip a seated NPC between AVAILABLE and FOCUS every few minutes. */
  private maybeFlipDesk(npc: NpcRecord, nowMs: number, effects: NpcEffect[]): void {
    if (nowMs < npc.nextDeskFlipAt) return;
    const next = npc.presence === PresenceState.FOCUS ? PresenceState.AVAILABLE : PresenceState.FOCUS;
    this.setPresence(npc, next, "SYSTEM", effects);
    npc.nextDeskFlipAt = nowMs + this.randRange(DESK_FLIP_MIN_MS, DESK_FLIP_MAX_MS);
  }

  private beginWander(npc: NpcRecord): void {
    const steps = Math.round(this.randRange(WANDER_STEPS_MIN, WANDER_STEPS_MAX));
    const dest = this.randomWalkableNear(npc.x, npc.y, steps);
    npc.behavior = "WANDERING";
    npc.target = dest;
    npc.path = this.pathTo(npc.x, npc.y, dest);
  }

  private beginCoffeeTrip(npc: NpcRecord): void {
    const dest = this.pick(this.coffeeTiles);
    npc.behavior = "COFFEE";
    npc.target = dest;
    npc.path = this.pathTo(npc.x, npc.y, dest);
  }

  private beginEventTrip(npc: NpcRecord, event: SocialEvent): void {
    const tiles = walkableAnchorsOrArea(this.map, event.areaName);
    const dest = tiles.length > 0 ? this.pick(tiles) : { x: npc.x, y: npc.y };
    npc.behavior = "AT_EVENT";
    npc.eventId = event.id;
    npc.target = dest;
    npc.path = this.pathTo(npc.x, npc.y, dest);
  }

  private beginReturn(npc: NpcRecord, _nowMs: number): void {
    npc.behavior = "RETURNING";
    npc.eventId = null;
    npc.target = { ...npc.homeSeat };
    npc.path = this.pathTo(npc.x, npc.y, npc.homeSeat);
  }

  /**
   * Consume up to STEPS_PER_TICK path tiles, emitting a move effect per tile so
   * movement looks natural across the 3s tick. Returns true when the path is
   * exhausted (arrival or no path). Each step is guaranteed walkable + adjacent.
   */
  private walkSteps(npc: NpcRecord, effects: NpcEffect[]): boolean {
    if (npc.path.length === 0) return true;
    let stepped = false;
    for (let i = 0; i < STEPS_PER_TICK && npc.path.length > 0; i++) {
      const next = npc.path.shift()!;
      // Defensive: never walk onto a non-walkable tile (map is the authority).
      if (!isWalkable(this.map, next.x, next.y)) {
        npc.path = [];
        break;
      }
      npc.dir = stepDir(npc.x, npc.y, next.x, next.y) ?? npc.dir;
      npc.x = next.x;
      npc.y = next.y;
      stepped = true;
      const moving = npc.path.length > 0;
      effects.push({ kind: "move", sessionId: npc.sessionId, x: npc.x, y: npc.y, dir: npc.dir, moving });
    }
    // Emit a final "stopped" frame when we just arrived this tick.
    if (stepped && npc.path.length === 0) {
      effects.push({ kind: "move", sessionId: npc.sessionId, x: npc.x, y: npc.y, dir: npc.dir, moving: false });
    }
    return npc.path.length === 0;
  }

  // -------------------------------------------------------------------------
  // Chat (rare, capped across ALL NPCs, only in Coffee Area / Lounge)
  // -------------------------------------------------------------------------

  private maybeChat(npc: NpcRecord, nowMs: number, effects: NpcEffect[]): void {
    if (nowMs - this.lastChatAt < CHAT_COOLDOWN_MS) return;
    if (!this.inSocialArea(npc.x, npc.y)) return;
    if (!this.chance(CHAT_CHANCE)) return;
    const text = this.pick(CHAT_LINES);
    this.lastChatAt = nowMs;
    effects.push({ kind: "chat", sessionId: npc.sessionId, name: npc.name, text });
  }

  private inSocialArea(x: number, y: number): boolean {
    return inArea(this.map, "Coffee Area", x, y) || inArea(this.map, "Lounge", x, y);
  }

  // -------------------------------------------------------------------------
  // Seating
  // -------------------------------------------------------------------------

  /**
   * Assign each roster entry the LAST free desk seats in its department
   * (iterate desks in reverse), leaving at least the FIRST 2 seats per
   * department free for humans. Falls back to the home spawn area if a
   * department somehow lacks enough reserved seats.
   */
  private assignSeats(roster: RosterEntry[]): Array<{ x: number; y: number }> {
    const byDept = new Map<Department, Array<{ x: number; y: number }>>();
    for (const dept of new Set(roster.map((r) => r.department))) {
      const deptDesks = this.map.desks.filter((d) => d.department === dept);
      // Reserve the first 2 seats per department for humans; NPCs take from the
      // end of the remaining pool.
      const reserveCount = Math.min(2, deptDesks.length);
      const pool = deptDesks.slice(reserveCount);
      // Walkable seats, taken from the LAST desk backward.
      const seats = pool
        .map((d) => ({ x: d.seatX, y: d.seatY }))
        .filter((s) => isWalkable(this.map, s.x, s.y))
        .reverse();
      byDept.set(dept, seats);
    }

    const cursor = new Map<Department, number>();
    return roster.map((entry) => {
      const seats = byDept.get(entry.department) ?? [];
      const i = cursor.get(entry.department) ?? 0;
      cursor.set(entry.department, i + 1);
      if (i < seats.length) return seats[i];
      // Overflow fallback: the office spawn (never a reserved human seat).
      return { x: this.map.spawn.x, y: this.map.spawn.y };
    });
  }

  // -------------------------------------------------------------------------
  // Pathing + RNG helpers
  // -------------------------------------------------------------------------

  /**
   * Greedy step path from (sx,sy) to (tx,ty): repeatedly step one tile toward
   * the target along whichever axis reduces distance and is walkable. Returns a
   * list of intermediate tiles (excluding the start). Bounded so a blocked
   * target never loops forever; the NPC simply walks as far as it can.
   */
  private pathTo(
    sx: number,
    sy: number,
    target: { x: number; y: number },
  ): Array<{ x: number; y: number }> {
    const path: Array<{ x: number; y: number }> = [];
    let cx = sx;
    let cy = sy;
    const maxSteps = this.map.width + this.map.height;
    const seen = new Set<string>([`${cx},${cy}`]);
    for (let i = 0; i < maxSteps; i++) {
      if (cx === target.x && cy === target.y) break;
      const dx = Math.sign(target.x - cx);
      const dy = Math.sign(target.y - cy);
      // Prefer the axis with the greater remaining distance, then try the other,
      // then any walkable orthogonal neighbor (so we can step around furniture).
      const horizFirst = Math.abs(target.x - cx) >= Math.abs(target.y - cy);
      const candidates: Array<{ x: number; y: number }> = [];
      if (horizFirst) {
        if (dx !== 0) candidates.push({ x: cx + dx, y: cy });
        if (dy !== 0) candidates.push({ x: cx, y: cy + dy });
      } else {
        if (dy !== 0) candidates.push({ x: cx, y: cy + dy });
        if (dx !== 0) candidates.push({ x: cx + dx, y: cy });
      }
      // Detour neighbors (unstick from furniture) in a deterministic order.
      candidates.push(
        { x: cx + 1, y: cy },
        { x: cx - 1, y: cy },
        { x: cx, y: cy + 1 },
        { x: cx, y: cy - 1 },
      );
      let advanced = false;
      for (const c of candidates) {
        const key = `${c.x},${c.y}`;
        if (seen.has(key)) continue;
        if (!isWalkable(this.map, c.x, c.y)) continue;
        cx = c.x;
        cy = c.y;
        seen.add(key);
        path.push({ x: cx, y: cy });
        advanced = true;
        break;
      }
      if (!advanced) break; // fully boxed in
    }
    return path;
  }

  /** A walkable tile reached by `steps` greedy random walkable steps from start. */
  private randomWalkableNear(sx: number, sy: number, steps: number): { x: number; y: number } {
    let cx = sx;
    let cy = sy;
    for (let i = 0; i < steps; i++) {
      const dirs: Array<{ x: number; y: number }> = [
        { x: cx + 1, y: cy },
        { x: cx - 1, y: cy },
        { x: cx, y: cy + 1 },
        { x: cx, y: cy - 1 },
      ];
      const walkable = dirs.filter((d) => isWalkable(this.map, d.x, d.y));
      if (walkable.length === 0) break;
      const choice = walkable[Math.floor(this.rng() * walkable.length)];
      cx = choice.x;
      cy = choice.y;
    }
    return { x: cx, y: cy };
  }

  /** First active event with room for more NPC attendees (≤2 attending). */
  private pickJoinableEvent(activeEvents: SocialEvent[]): SocialEvent | null {
    if (activeEvents.length === 0) return null;
    if (this.countAttendees() >= 2) return null;
    return activeEvents[0];
  }

  private countAttendees(): number {
    let n = 0;
    for (const npc of this.npcs.values()) {
      if (npc.behavior === "AT_EVENT") n++;
    }
    return n;
  }

  private setPresence(
    npc: NpcRecord,
    state: PresenceState,
    source: PresenceSource,
    effects: NpcEffect[],
  ): void {
    if (npc.presence === state && npc.source === source) return;
    npc.presence = state;
    npc.source = source;
    effects.push({ kind: "presence", sessionId: npc.sessionId, state, source });
  }

  private toSnapshot(npc: NpcRecord): PlayerSnapshot {
    return {
      sessionId: npc.sessionId,
      userId: npc.userId,
      name: npc.name,
      department: npc.department,
      avatarId: npc.avatarId,
      x: npc.x,
      y: npc.y,
      dir: npc.dir,
      presence: npc.presence,
      source: npc.source,
      isNpc: true,
    };
  }

  private chance(p: number): boolean {
    return this.rng() < p;
  }

  private randRange(min: number, max: number): number {
    return min + this.rng() * (max - min);
  }

  private pick<T>(arr: T[]): T {
    return arr[Math.floor(this.rng() * arr.length)];
  }
}

// ---------------------------------------------------------------------------
// Module-level pure helpers
// ---------------------------------------------------------------------------

function clampCount(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(16, Math.floor(count));
}

/** Walkable anchor tiles for an area, falling back to scanning the area rect. */
function walkableAnchorsOrArea(map: OfficeMap, areaName: string): Array<{ x: number; y: number }> {
  const anchors = (map.anchors[areaName] ?? []).filter((a) => isWalkable(map, a.x, a.y));
  if (anchors.length > 0) return anchors.map((a) => ({ x: a.x, y: a.y }));
  const area = map.areas.find((a) => a.name === areaName);
  const out: Array<{ x: number; y: number }> = [];
  if (!area) return out;
  for (let y = area.y; y < area.y + area.h; y++) {
    for (let x = area.x; x < area.x + area.w; x++) {
      if (isWalkable(map, x, y)) out.push({ x, y });
    }
  }
  return out;
}

function inArea(map: OfficeMap, areaName: string, x: number, y: number): boolean {
  const area = map.areas.find((a) => a.name === areaName);
  if (!area) return false;
  return x >= area.x && x < area.x + area.w && y >= area.y && y < area.y + area.h;
}

function stepDir(fromX: number, fromY: number, toX: number, toY: number): Direction | null {
  if (toX > fromX) return "right";
  if (toX < fromX) return "left";
  if (toY > fromY) return "down";
  if (toY < fromY) return "up";
  return null;
}

/** Read NPC config from env: NPC_SEED (default 42), NPC_COUNT (default 8). */
export function npcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): {
  seed: number;
  count: number;
} {
  const seed = Number.isFinite(Number(env.NPC_SEED)) && env.NPC_SEED !== undefined && env.NPC_SEED !== ""
    ? Number(env.NPC_SEED)
    : 42;
  const count = env.NPC_COUNT !== undefined && env.NPC_COUNT !== ""
    ? Number(env.NPC_COUNT)
    : 8;
  return { seed, count: Number.isFinite(count) ? count : 8 };
}
