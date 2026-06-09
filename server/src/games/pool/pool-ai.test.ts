// ---------------------------------------------------------------------------
// AI tests: returns a legal in-bounds shot; harder difficulty = tighter aim.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { POOL_TABLE_W, POOL_TABLE_H, type PoolBall, type PoolState } from "@pixeloffice/shared";
import { pickShot } from "./pool-ai";
import { freshPoolState, kindForId } from "./pool-setup";
import { applyShot } from "./pool-physics";
import { resolveShot } from "./pool-rules";
import { makePrng } from "./prng";

const AI = "AI";
const HUMAN = "human";

/** Centered PRNG => the AI's CHOSEN shot, free of difficulty aim noise. */
const noNoise = () => 0.5;

function ball(id: number, x: number, y: number): PoolBall {
  return { id, kind: kindForId(id), x, y, vx: 0, vy: 0, pocketed: false };
}

describe("pickShot: legality + bounds", () => {
  it("returns a finite, in-range shot on the opening rack", () => {
    const state = freshPoolState(AI);
    const shot = pickShot(state, AI, "medium", makePrng(1));
    expect(Number.isFinite(shot.angleRad)).toBe(true);
    expect(shot.power).toBeGreaterThanOrEqual(0);
    expect(shot.power).toBeLessThanOrEqual(1);
  });

  it("is deterministic for a given seed", () => {
    const state = freshPoolState(AI);
    const a = pickShot(state, AI, "hard", makePrng(42));
    const b = pickShot(state, AI, "hard", makePrng(42));
    expect(a).toEqual(b);
  });

  it("a shot from the AI keeps every ball inside the rails", () => {
    const state = freshPoolState(AI);
    const shot = pickShot(state, AI, "medium", makePrng(7));
    const res = applyShot(state.balls, shot.angleRad, shot.power);
    for (const b of res.balls) {
      if (b.pocketed) continue;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x).toBeLessThanOrEqual(POOL_TABLE_W);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeLessThanOrEqual(POOL_TABLE_H);
    }
  });

  it("targets its OWN group once assigned (aims roughly toward a solid)", () => {
    // Cue at left; one solid straight ahead, stripes off to the side.
    const balls: PoolBall[] = [
      ball(0, 40, 50),
      ball(2, 120, 50), // own solid dead ahead
      ball(11, 120, 90), // opponent stripe far below
    ];
    const state: PoolState = {
      balls,
      currentTurn: AI,
      assignedGroups: { [AI]: "solid", [HUMAN]: "stripe" },
      ballInHand: false,
      lastEvent: null,
      animating: false,
    };
    const shot = pickShot(state, AI, "hard", makePrng(3));
    // The aim should be roughly horizontal (toward the solid at the same y), not
    // steeply downward toward the stripe.
    expect(Math.abs(Math.sin(shot.angleRad))).toBeLessThan(0.5);
  });

  it("falls back to a soft shot when there are no legal targets", () => {
    const state: PoolState = {
      balls: [ball(0, 50, 50)],
      currentTurn: AI,
      assignedGroups: { [AI]: "solid", [HUMAN]: "stripe" },
      ballInHand: false,
      lastEvent: null,
      animating: false,
    };
    const shot = pickShot(state, AI, "easy", makePrng(9));
    expect(Number.isFinite(shot.angleRad)).toBe(true);
    expect(shot.power).toBeGreaterThan(0);
  });

  it("power is always clamped into the sane [0.25, 1] range", () => {
    const state = freshPoolState(AI);
    for (let seed = 0; seed < 12; seed++) {
      const shot = pickShot(state, AI, "easy", makePrng(seed));
      expect(shot.power).toBeGreaterThanOrEqual(0.25);
      expect(shot.power).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Legality: the CHOSEN shot (no aim noise) must be a LEGAL, non-scratch shot
// whenever such a shot exists. The AI simulates candidates and scores them, so
// it should never knowingly scratch, never play a no-contact shot, and never hit
// the wrong group first when a clean line exists.
// ---------------------------------------------------------------------------
describe("pickShot: simulation-driven legality (no aim noise)", () => {
  it("does not scratch when a clean own-group pot is available", () => {
    // Cue, an own solid lined up with the right-edge pocket, no obstructions.
    const balls: PoolBall[] = [
      ball(0, 40, 50),
      ball(2, 120, 50), // own solid, in line toward the right-middle... use corner
      ball(11, 160, 20), // opponent stripe out of the way
    ];
    const state: PoolState = {
      balls,
      currentTurn: AI,
      assignedGroups: { [AI]: "solid", [HUMAN]: "stripe" },
      ballInHand: false,
      lastEvent: null,
      animating: false,
    };
    const shot = pickShot(state, AI, "hard", noNoise);
    const sim = applyShot(state.balls, shot.angleRad, shot.power);
    expect(sim.cueScratched).toBe(false);
    expect(sim.firstContactId).not.toBeNull();
    // First contact must be a SOLID (the AI's group), never the stripe.
    expect(kindForId(sim.firstContactId!)).toBe("solid");
  });

  it("hits its own group first (not the opponent's) once assigned", () => {
    const balls: PoolBall[] = [
      ball(0, 40, 50),
      ball(3, 100, 50), // own solid dead ahead
      ball(12, 100, 70), // stripe nearby — easy to wrongly clip
    ];
    const state: PoolState = {
      balls,
      currentTurn: AI,
      assignedGroups: { [AI]: "solid", [HUMAN]: "stripe" },
      ballInHand: false,
      lastEvent: null,
      animating: false,
    };
    const shot = pickShot(state, AI, "hard", noNoise);
    const sim = applyShot(state.balls, shot.angleRad, shot.power);
    expect(sim.firstContactId).not.toBeNull();
    expect(kindForId(sim.firstContactId!)).toBe("solid");
    expect(sim.cueScratched).toBe(false);
  });

  it("the chosen shot on the opening rack is a legal, non-scratch break", () => {
    const state = freshPoolState(AI);
    const shot = pickShot(state, AI, "hard", noNoise);
    const sim = applyShot(state.balls, shot.angleRad, shot.power);
    const res = resolveShot(
      { ...state, balls: state.balls.map((b) => ({ ...b })) },
      AI,
      HUMAN,
      sim,
    );
    expect(sim.cueScratched).toBe(false);
    expect(sim.firstContactId).not.toBeNull();
    expect(res.event.foul).toBe(false);
  });

  it("plays AI vs AI to a winner and the chosen shots never scratch/miss-contact", () => {
    let state = freshPoolState(AI);
    const P1 = AI, P2 = "AI2";
    state.currentTurn = P1;
    let finished = false;
    for (let turn = 0; turn < 300; turn++) {
      const shooter = state.currentTurn;
      const opp = shooter === P1 ? P2 : P1;
      const shot = pickShot(state, shooter, "hard", noNoise);
      const sim = applyShot(state.balls, shot.angleRad, shot.power);
      expect(sim.cueScratched).toBe(false);
      expect(sim.firstContactId).not.toBeNull();
      const res = resolveShot(
        { ...state, balls: state.balls.map((b) => ({ ...b })) },
        shooter,
        opp,
        sim,
      );
      state = res.state;
      if (state.ballInHand) {
        const c = state.balls.find((b) => b.id === 0);
        if (c && c.pocketed) { c.pocketed = false; c.x = 50; c.y = 50; c.vx = 0; c.vy = 0; }
      }
      if (res.winnerSessionId !== undefined) { finished = true; break; }
    }
    expect(finished).toBe(true); // never stalls; always reaches a winner
  });
});

describe("difficulty: harder = less aim noise", () => {
  it("hard deviates from the ideal aim less than easy, on average", () => {
    // A perfectly straight shot: cue and an own-group ball aligned with the
    // (W,50)... use a target that lines up toward a pocket so the ideal angle is
    // well-defined. Measure spread of chosen angles across many seeds.
    const balls: PoolBall[] = [ball(0, 40, 50), ball(2, 100, 50)];
    const base: PoolState = {
      balls,
      currentTurn: AI,
      assignedGroups: { [AI]: "solid", [HUMAN]: "stripe" },
      ballInHand: false,
      lastEvent: null,
      animating: false,
    };

    // The ideal (noise-free) angle is the angle the AI would pick with a PRNG
    // that returns 0.5 (zero centered noise).
    const ideal = pickShot(base, AI, "hard", () => 0.5).angleRad;

    const spread = (difficulty: "easy" | "hard"): number => {
      let sum = 0;
      const N = 40;
      for (let i = 0; i < N; i++) {
        const s = pickShot(base, AI, difficulty, makePrng(1000 + i));
        sum += Math.abs(s.angleRad - ideal);
      }
      return sum / N;
    };

    const easySpread = spread("easy");
    const hardSpread = spread("hard");
    expect(hardSpread).toBeLessThan(easySpread);
  });
});
