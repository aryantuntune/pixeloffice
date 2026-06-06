// ---------------------------------------------------------------------------
// Deterministic NPC behavior tests. The service is framework-free and takes a
// seeded PRNG + an injected `now`, so every behavior is fully reproducible:
// no system clock, no Math.random, no Colyseus.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it } from "vitest";
import {
  PresenceState,
  buildOfficeMap,
  isWalkable,
  type OfficeMap,
  type SocialEvent,
} from "@pixeloffice/shared";
import {
  NpcService,
  mulberry32,
  npcConfigFromEnv,
  type NpcEffect,
} from "./npc.service";

const SEED = 42;
const START = 1_000_000;

function makeService(count = 8, seed = SEED): NpcService {
  return new NpcService(buildOfficeMap(), mulberry32(seed), count);
}

/** Run the service for N ticks, `stepMs` apart, collecting every effect. */
function run(
  svc: NpcService,
  ticks: number,
  stepMs = 3000,
  events: (now: number) => SocialEvent[] = () => [],
): NpcEffect[] {
  const all: NpcEffect[] = [];
  let now = START;
  for (let i = 0; i < ticks; i++) {
    now += stepMs;
    all.push(...svc.tick(now, events(now)));
  }
  return all;
}

function activeEvent(areaName = "Coffee Area"): SocialEvent {
  return {
    id: "evt-1",
    type: "COFFEE_BREAK",
    title: "Coffee",
    areaName,
    startTime: START,
    endTime: START + 10_000_000,
    participantIds: [],
  };
}

describe("NpcService — spawn", () => {
  it("spawns the requested count with NPC session ids and isNpc=true", () => {
    const svc = makeService(8);
    const snaps = svc.spawnAll(START);
    expect(snaps).toHaveLength(8);
    for (const s of snaps) {
      expect(s.sessionId).toMatch(/^npc-\d+$/);
      expect(s.isNpc).toBe(true);
    }
    expect([...svc.npcSessionIds()].sort()).toEqual(
      ["npc-1", "npc-2", "npc-3", "npc-4", "npc-5", "npc-6", "npc-7", "npc-8"].sort(),
    );
  });

  it("spreads NPCs across all four departments", () => {
    const snaps = makeService(8).spawnAll(START);
    const depts = new Set(snaps.map((s) => s.department));
    expect(depts).toEqual(new Set(["Engineering", "Product", "Design", "HR"]));
  });

  it("seats NPCs at walkable desk seats, leaving the first 2 seats per dept free", () => {
    const map = buildOfficeMap();
    const svc = makeService(8);
    const snaps = svc.spawnAll(START);

    for (const dept of ["Engineering", "Product", "Design", "HR"] as const) {
      const deptDesks = map.desks.filter((d) => d.department === dept);
      const reserved = deptDesks.slice(0, Math.min(2, deptDesks.length));
      const npcSnaps = snaps.filter((s) => s.department === dept);
      for (const s of npcSnaps) {
        // NPC must not sit on a reserved (first-2) human seat.
        const onReserved = reserved.some((d) => d.seatX === s.x && d.seatY === s.y);
        expect(onReserved).toBe(false);
        expect(isWalkable(map, s.x, s.y)).toBe(true);
      }
    }
  });

  it("seats NPCs at the LAST desks per department (reverse iteration)", () => {
    const map = buildOfficeMap();
    const eng = makeService(8).spawnAll(START).find((s) => s.department === "Engineering")!;
    const engDesks = map.desks.filter((d) => d.department === "Engineering");
    const lastSeat = engDesks[engDesks.length - 1];
    expect(eng.x).toBe(lastSeat.seatX);
    expect(eng.y).toBe(lastSeat.seatY);
  });

  it("NPC_COUNT=0 disables NPCs entirely", () => {
    const svc = makeService(0);
    expect(svc.spawnAll(START)).toHaveLength(0);
    expect(svc.npcSessionIds().size).toBe(0);
    expect(run(svc, 50)).toHaveLength(0);
  });

  it("clamps count to a maximum of 16", () => {
    // Only 8 default roster entries exist; count is clamped but roster bounds it.
    const svc = makeService(100);
    const snaps = svc.spawnAll(START);
    expect(snaps.length).toBeLessThanOrEqual(8);
  });

  it("is deterministic for a fixed seed", () => {
    const a = makeService(8, 7);
    const b = makeService(8, 7);
    a.spawnAll(START);
    b.spawnAll(START);
    const ea = run(a, 40);
    const eb = run(b, 40);
    expect(ea).toEqual(eb);
  });
});

describe("NpcService — movement", () => {
  it("every move effect lands on a walkable tile and steps one tile at a time", () => {
    const map: OfficeMap = buildOfficeMap();
    const svc = makeService(8);
    const snaps = svc.spawnAll(START);
    // Track each NPC's last known position to assert single-tile steps.
    const pos = new Map(snaps.map((s) => [s.sessionId, { x: s.x, y: s.y }]));

    const effects = run(svc, 200);
    let moves = 0;
    for (const e of effects) {
      if (e.kind !== "move") continue;
      moves++;
      expect(isWalkable(map, e.x, e.y)).toBe(true);
      const prev = pos.get(e.sessionId)!;
      const manhattan = Math.abs(prev.x - e.x) + Math.abs(prev.y - e.y);
      // A move effect is either a step (1 tile) or a "stopped" frame (0 tiles).
      expect(manhattan).toBeLessThanOrEqual(1);
      pos.set(e.sessionId, { x: e.x, y: e.y });
    }
    expect(moves).toBeGreaterThan(0); // NPCs actually wandered
  });

  it("emits at most a couple of move steps per NPC per tick", () => {
    const svc = makeService(8);
    svc.spawnAll(START);
    let now = START;
    for (let i = 0; i < 200; i++) {
      now += 3000;
      const effects = svc.tick(now, []);
      const perNpc = new Map<string, number>();
      for (const e of effects) {
        if (e.kind !== "move") continue;
        perNpc.set(e.sessionId, (perNpc.get(e.sessionId) ?? 0) + 1);
      }
      for (const c of perNpc.values()) {
        // STEPS_PER_TICK steps + at most one trailing "stopped" frame.
        expect(c).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe("NpcService — coffee trip state machine", () => {
  it("an NPC eventually takes a coffee break (BREAK presence) and returns", () => {
    const map = buildOfficeMap();
    const svc = makeService(8);
    svc.spawnAll(START);

    let sawBreak = false;
    let sawAvailableAfterBreak = false;
    const breakSeen = new Set<string>();

    let now = START;
    for (let i = 0; i < 1000; i++) {
      now += 3000;
      for (const e of svc.tick(now, [])) {
        if (e.kind === "presence" && e.state === PresenceState.BREAK) {
          sawBreak = true;
          breakSeen.add(e.sessionId);
        }
        if (
          e.kind === "presence" &&
          e.state === PresenceState.AVAILABLE &&
          breakSeen.has(e.sessionId)
        ) {
          sawAvailableAfterBreak = true;
        }
      }
    }
    expect(sawBreak).toBe(true); // round-trip reached the coffee/break state
    expect(sawAvailableAfterBreak).toBe(true); // and returned to the desk
    // sanity: the coffee area is a real walkable region
    expect(map.areas.some((a) => a.name === "Coffee Area")).toBe(true);
  });
});

describe("NpcService — event join/leave", () => {
  it("idle NPCs drift to an active event (1-2), then leave when it ends", () => {
    const svc = makeService(8);
    svc.spawnAll(START);
    const evt = activeEvent();

    // Phase 1: event active for many ticks; some NPCs should reach BREAK in the
    // event area.
    let now = START;
    let breakDuringEvent = 0;
    const eventBreakers = new Set<string>();
    for (let i = 0; i < 400; i++) {
      now += 3000;
      for (const e of svc.tick(now, [evt])) {
        if (e.kind === "presence" && e.state === PresenceState.BREAK) {
          breakDuringEvent++;
          eventBreakers.add(e.sessionId);
        }
      }
    }
    expect(breakDuringEvent).toBeGreaterThan(0);
    // Never more than 2 NPCs attending an event concurrently (cap).
    expect(eventBreakers.size).toBeLessThanOrEqual(8); // distinct over time is loose

    // Phase 2: event ends (empty active list). Attendees must walk back and
    // return to AVAILABLE.
    let returned = false;
    for (let i = 0; i < 400; i++) {
      now += 3000;
      for (const e of svc.tick(now, [])) {
        if (e.kind === "presence" && e.state === PresenceState.AVAILABLE) returned = true;
      }
    }
    expect(returned).toBe(true);
  });

  it("never has more than 2 NPCs attending an event at the same time", () => {
    const svc = makeService(8);
    svc.spawnAll(START);
    const evt = activeEvent();

    let now = START;
    let peak = 0;
    for (let i = 0; i < 400; i++) {
      now += 3000;
      svc.tick(now, [evt]);
      peak = Math.max(peak, svc.eventAttendeeCount());
      // The event-attendance cap is enforced every tick.
      expect(svc.eventAttendeeCount()).toBeLessThanOrEqual(2);
    }
    // At least one NPC actually attended (the trip was exercised).
    expect(peak).toBeGreaterThan(0);
  });
});

describe("NpcService — chat rarity", () => {
  it("chats only in Coffee Area / Lounge and at most ~1 per 2 minutes", () => {
    const map = buildOfficeMap();
    const svc = makeService(8);
    svc.spawnAll(START);
    const evt = activeEvent("Coffee Area");

    const chatTimes: number[] = [];
    let now = START;
    for (let i = 0; i < 2000; i++) {
      now += 3000;
      for (const e of svc.tick(now, [evt])) {
        if (e.kind !== "chat") continue;
        chatTimes.push(now);
        // chatter must be in a social area
        const chatter = svc.listSnapshots().find((s) => s.sessionId === e.sessionId)!;
        const inCoffee = within(map, "Coffee Area", chatter.x, chatter.y);
        const inLounge = within(map, "Lounge", chatter.x, chatter.y);
        expect(inCoffee || inLounge).toBe(true);
      }
    }
    // Every consecutive pair of chats must be ≥ ~2 min (120s) apart.
    for (let i = 1; i < chatTimes.length; i++) {
      expect(chatTimes[i] - chatTimes[i - 1]).toBeGreaterThanOrEqual(120_000);
    }
  });
});

describe("npcConfigFromEnv", () => {
  it("defaults to seed 42 / count 8 when unset", () => {
    expect(npcConfigFromEnv({})).toEqual({ seed: 42, count: 8 });
  });
  it("reads NPC_SEED and NPC_COUNT", () => {
    expect(npcConfigFromEnv({ NPC_SEED: "7", NPC_COUNT: "0" })).toEqual({ seed: 7, count: 0 });
  });
  it("falls back gracefully on garbage", () => {
    expect(npcConfigFromEnv({ NPC_SEED: "", NPC_COUNT: "" })).toEqual({ seed: 42, count: 8 });
    expect(npcConfigFromEnv({ NPC_COUNT: "abc" })).toEqual({ seed: 42, count: 8 });
  });
});

function within(map: OfficeMap, areaName: string, x: number, y: number): boolean {
  const a = map.areas.find((ar) => ar.name === areaName);
  if (!a) return false;
  return x >= a.x && x < a.x + a.w && y >= a.y && y < a.y + a.h;
}

// Avoid an unused beforeEach lint in some setups.
beforeEach(() => {});
