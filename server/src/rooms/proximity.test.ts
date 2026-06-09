// ---------------------------------------------------------------------------
// Exhaustive transition tests for the PURE proximity helper (shared). Proximity
// is the gate for voice/video: it decides which peers surface call buttons and
// when a call auto-mutes on leave. Like the presence engine, every distance /
// floor / NPC rule is locked down here.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  chebyshev,
  sameFloor,
  peersWithin,
  canCall,
  PROXIMITY_TILES,
  CALL_REQUEST_TILES,
  type ProximityPeer,
} from "@pixeloffice/shared";

const self: ProximityPeer = { sessionId: "self", x: 10, y: 10, floorId: "ground" };
const peer = (over: Partial<ProximityPeer>): ProximityPeer => ({
  sessionId: "p",
  x: 10,
  y: 10,
  floorId: "ground",
  ...over,
});

describe("chebyshev", () => {
  it("is king-move distance: max(|dx|,|dy|)", () => {
    expect(chebyshev(0, 0, 0, 0)).toBe(0);
    expect(chebyshev(0, 0, 3, 1)).toBe(3);
    expect(chebyshev(0, 0, 2, 2)).toBe(2); // diagonal still counts as 2, not 4
    expect(chebyshev(10, 10, 8, 12)).toBe(2);
  });
});

describe("sameFloor", () => {
  it("treats an absent floorId as ground", () => {
    expect(sameFloor({}, { floorId: "ground" })).toBe(true);
    expect(sameFloor({ floorId: "ground" }, {})).toBe(true);
    expect(sameFloor({ floorId: "floor-1" }, {})).toBe(false);
    expect(sameFloor({ floorId: "floor-1" }, { floorId: "floor-1" })).toBe(true);
  });
});

describe("peersWithin (default radius = 2)", () => {
  it("includes a peer exactly at the radius edge (diagonal)", () => {
    expect(peersWithin(self, [peer({ x: 12, y: 12 })])).toEqual(["p"]); // distance 2
  });

  it("includes adjacent and same-tile peers", () => {
    expect(peersWithin(self, [peer({ x: 10, y: 10 })])).toEqual(["p"]); // on top
    expect(peersWithin(self, [peer({ x: 11, y: 10 })])).toEqual(["p"]); // 1 away
  });

  it("excludes a peer just outside the radius", () => {
    expect(peersWithin(self, [peer({ x: 13, y: 10 })])).toEqual([]); // distance 3
    expect(peersWithin(self, [peer({ x: 10, y: 13 })])).toEqual([]);
  });

  it("excludes self even if positioned on self", () => {
    expect(peersWithin(self, [peer({ sessionId: "self", x: 10, y: 10 })])).toEqual([]);
  });

  it("excludes NPCs (you cannot call ambient NPCs)", () => {
    expect(peersWithin(self, [peer({ isNpc: true })])).toEqual([]);
  });

  it("excludes peers on a different floor", () => {
    expect(peersWithin(self, [peer({ floorId: "floor-1" })])).toEqual([]);
  });

  it("returns every in-range peer, preserving iteration order", () => {
    const out = peersWithin(self, [
      peer({ sessionId: "a", x: 11, y: 11 }),
      peer({ sessionId: "far", x: 20, y: 20 }),
      peer({ sessionId: "b", x: 9, y: 9 }),
    ]);
    expect(out).toEqual(["a", "b"]);
  });

  it("honors a custom radius", () => {
    expect(peersWithin(self, [peer({ x: 14, y: 10 })], 5)).toEqual(["p"]); // distance 4 <= 5
    expect(peersWithin(self, [peer({ x: 16, y: 10 })], 5)).toEqual([]); // distance 6 > 5
  });

  it("transitions in and out of range as a peer walks past (auto-mute gate)", () => {
    const path = [13, 12, 11, 10, 11, 12, 13]; // x positions; y fixed at 10
    const inRange = path.map((x) => peersWithin(self, [peer({ x, y: 10 })]).length === 1);
    // distance: 3(out) 2(in) 1(in) 0(in) 1(in) 2(in) 3(out)
    expect(inRange).toEqual([false, true, true, true, true, true, false]);
  });
});

describe("canCall (request gate, radius = 4)", () => {
  it("allows initiating within the generous request radius", () => {
    expect(canCall(self, peer({ x: 14, y: 10 }))).toBe(true); // distance 4
  });

  it("rejects initiating beyond the request radius", () => {
    expect(canCall(self, peer({ x: 15, y: 10 }))).toBe(false); // distance 5
  });

  it("rejects NPCs, self, and cross-floor targets", () => {
    expect(canCall(self, peer({ isNpc: true }))).toBe(false);
    expect(canCall(self, peer({ sessionId: "self" }))).toBe(false);
    expect(canCall(self, peer({ floorId: "floor-1", x: 10, y: 10 }))).toBe(false);
  });
});

describe("radii constants", () => {
  it("request radius is wider than the button radius (drift slack)", () => {
    expect(CALL_REQUEST_TILES).toBeGreaterThan(PROXIMITY_TILES);
  });
});
