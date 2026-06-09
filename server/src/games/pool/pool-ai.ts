// ---------------------------------------------------------------------------
// Pool AI opponent (framework-free, deterministic given an injected PRNG).
//
// Strategy: GHOST-BALL geometry to enumerate candidate shots (for every legal
// target ball x every pocket, the cue must strike the "ghost ball" one diameter
// behind the target along the target->pocket line), then SIMULATE each candidate
// with the real deterministic physics and SCORE the outcome (legal own-group pot
// best; clean legal contact good; self-scratch / wrong-group / no-contact heavily
// penalized). The AI picks the highest-scoring legal shot, so it never knowingly
// scratches, never plays an illegal first-contact when a legal one exists, and
// always returns an in-bounds, finite, sanely-powered shot. Difficulty adds
// bounded Gaussian-ish aim noise scaled by level (harder => tighter). All
// randomness flows through the injected PRNG — no system clock, no global RNG.
// ---------------------------------------------------------------------------

import {
  POOL_BALL_R,
  POOL_POCKETS,
  type PoolBall,
  type PoolGroup,
  type PoolShotInput,
  type PoolState,
} from "@pixeloffice/shared";
import { applyShot } from "./pool-physics";
import { kindForId } from "./pool-setup";
import type { Prng } from "./prng";

export type PoolDifficulty = "easy" | "medium" | "hard";

/** Max aim noise (radians, +/-) per difficulty. Harder => tighter. */
const NOISE_BY_DIFFICULTY: Record<PoolDifficulty, number> = {
  easy: 0.18,
  medium: 0.09,
  hard: 0.035,
};

/** Power options the AI tries per aim line (clamped to a sane range). */
const POWER_OPTIONS = [0.45, 0.65, 0.85];

/**
 * Max ghost-ball aim lines to SIMULATE per shot. Aim lines are pre-ranked by
 * geometric cost (shortest, straightest first) and only the best few are run
 * through the physics, bounding the per-shot cost while keeping shot quality.
 */
const MAX_SIMULATED_CANDIDATES = 14;

function groupOfKind(kind: PoolBall["kind"]): PoolGroup | null {
  if (kind === "solid") return "solid";
  if (kind === "stripe") return "stripe";
  return null;
}

function groupOf(b: PoolBall): PoolGroup | null {
  return groupOfKind(b.kind);
}

/** Legal target balls for the AI given the current state. */
function legalTargets(state: PoolState, aiId: string): PoolBall[] {
  const live = state.balls.filter((b) => !b.pocketed && b.id !== 0);
  const group = state.assignedGroups[aiId];
  if (!group) {
    // Open table: any non-8 ball.
    return live.filter((b) => b.id !== 8);
  }
  const own = live.filter((b) => groupOf(b) === group);
  if (own.length > 0) return own;
  // Group cleared: legal to shoot the 8.
  return live.filter((b) => b.id === 8);
}

interface AimCandidate {
  angleRad: number;
  /** Geometric cost — lower is better (cue->ghost + target->pocket + cut penalty). */
  cost: number;
}

/** Enumerate ghost-ball aim lines for every legal (target, pocket) pair. */
function aimCandidates(cue: PoolBall, targets: PoolBall[]): AimCandidate[] {
  const out: AimCandidate[] = [];
  for (const t of targets) {
    for (const pocket of POOL_POCKETS) {
      const tpx = pocket.x - t.x;
      const tpy = pocket.y - t.y;
      const tpLen = Math.hypot(tpx, tpy);
      if (tpLen < 1e-6) continue;
      const ux = tpx / tpLen;
      const uy = tpy / tpLen;

      // Ghost ball: where the cue's center must be at contact (one ball-diameter
      // behind the target along the target->pocket line).
      const ghostX = t.x - ux * (POOL_BALL_R * 2);
      const ghostY = t.y - uy * (POOL_BALL_R * 2);

      const cgx = ghostX - cue.x;
      const cgy = ghostY - cue.y;
      const cueDist = Math.hypot(cgx, cgy);
      if (cueDist < 1e-6) continue;

      // Cut-angle feasibility: the cue must push the target toward the pocket
      // (positive alignment between cue->ghost and target->pocket directions).
      const align = (cgx / cueDist) * ux + (cgy / cueDist) * uy;
      if (align <= 0.05) continue;

      const cost = cueDist + tpLen + (1 - align) * 120;
      out.push({ angleRad: Math.atan2(cgy, cgx), cost });
    }
  }
  return out;
}

/**
 * Score a SIMULATED shot outcome for the AI. Higher is better. Encodes the rules
 * the AI must respect: legal first contact, no self-scratch, prefer potting the
 * AI's own group (or any legal ball on an open table). Mirrors pool-rules so the
 * AI never knowingly fouls when a clean shot exists.
 */
function scoreOutcome(
  prev: PoolState,
  aiId: string,
  sim: ReturnType<typeof applyShot>,
): number {
  let score = 0;
  const group = prev.assignedGroups[aiId];
  const tableOpen = Object.keys(prev.assignedGroups).length === 0;

  // Self-scratch is the worst common outcome — never choose it if avoidable.
  if (sim.cueScratched) score -= 1000;

  // First-contact legality.
  if (sim.firstContactId === null) {
    score -= 800; // no contact => guaranteed foul
  } else {
    const firstKind = kindForId(sim.firstContactId);
    if (tableOpen) {
      if (firstKind === "eight") score -= 600; // hitting the 8 first on open table = foul
      else score += 50; // any non-8 first is legal on an open table
    } else if (group) {
      const ownLive = prev.balls.filter(
        (b) => !b.pocketed && groupOf(b) === group,
      ).length;
      const cleared = ownLive === 0;
      if (firstKind === "eight") {
        if (cleared) score += 50; // going for the 8 after clearing is legal
        else score -= 600; // hitting the 8 early = foul
      } else if (groupOfKind(firstKind) === group) {
        score += 50; // legal own-group first contact
      } else {
        score -= 600; // wrong-group first contact = foul
      }
    }
  }

  // Potting credit (only legal-ish pots count toward the positive score).
  for (const id of sim.pocketed) {
    if (id === 0) continue; // scratch handled above
    if (id === 8) {
      const ownLive = group
        ? prev.balls.filter((b) => !b.pocketed && groupOf(b) === group).length
        : 99;
      // Potting the 8 is only good if our group is cleared and we didn't scratch.
      if (group && ownLive === 0 && !sim.cueScratched) score += 500;
      else score -= 1000; // illegal-8 loss
      continue;
    }
    const k = kindForId(id);
    if (tableOpen) {
      score += 120; // potting anything legal opens the table in our favor
    } else if (group && groupOfKind(k) === group) {
      score += 150; // potted our own ball => keep the turn
    } else {
      score += 5; // potted opponent ball: minor (no foul by itself, but no gain)
    }
  }

  return score;
}

/**
 * Compute the best shot the AI can find. Returns a PoolShotInput. Deterministic
 * for a given (state, prng) pair. Always returns an in-bounds, finite shot: it
 * SIMULATES every candidate and picks the highest-scoring legal one, then applies
 * bounded difficulty aim noise. Falls back to a soft straight shot only when there
 * is literally no cue or no legal target.
 */
export function pickShot(
  state: PoolState,
  aiId: string,
  difficulty: PoolDifficulty,
  rng: Prng,
): PoolShotInput {
  const cue = state.balls.find((b) => b.id === 0 && !b.pocketed);
  const targets = legalTargets(state, aiId);

  // Degenerate fallback: no cue or no targets -> a soft straight shot.
  if (!cue || targets.length === 0) {
    return { angleRad: 0, power: 0.3 };
  }

  // Rank aim lines by geometric cost and only simulate the most promising few so
  // the per-shot cost stays bounded (targets x pockets can be large on a full rack).
  const candidates = aimCandidates(cue, targets)
    .sort((a, b) => a.cost - b.cost)
    .slice(0, MAX_SIMULATED_CANDIDATES);

  // Evaluate each (aim, power) pair by SIMULATION and keep the best legal one.
  // Tie-break on geometric cost so the AI prefers the simplest shot, keeping the
  // result deterministic and stable.
  let bestAngle: number | null = null;
  let bestPower = 0.5;
  let bestScore = -Infinity;
  let bestCost = Infinity;

  for (const cand of candidates) {
    for (const power of POWER_OPTIONS) {
      const sim = applyShot(state.balls, cand.angleRad, power);
      const score = scoreOutcome(state, aiId, sim);
      if (score > bestScore || (score === bestScore && cand.cost < bestCost)) {
        bestScore = score;
        bestCost = cand.cost;
        bestAngle = cand.angleRad;
        bestPower = power;
      }
    }
  }

  // Geometric fallback: aim straight at the nearest legal ball (still simulate a
  // couple of powers to dodge an obvious scratch). Used only when no ghost-ball
  // candidate produced a feasible cut (e.g. every target hugs a rail).
  if (bestAngle === null) {
    let nearest = targets[0];
    let nd = Infinity;
    for (const t of targets) {
      const d = Math.hypot(t.x - cue.x, t.y - cue.y);
      if (d < nd) {
        nd = d;
        nearest = t;
      }
    }
    const baseAngle = Math.atan2(nearest.y - cue.y, nearest.x - cue.x);
    for (const power of POWER_OPTIONS) {
      const sim = applyShot(state.balls, baseAngle, power);
      const score = scoreOutcome(state, aiId, sim);
      if (score > bestScore) {
        bestScore = score;
        bestAngle = baseAngle;
        bestPower = power;
      }
    }
    if (bestAngle === null) {
      bestAngle = baseAngle;
      bestPower = 0.5;
    }
  }

  // Aim noise from the injected PRNG (centered). Harder difficulty => less noise.
  const noiseMax = NOISE_BY_DIFFICULTY[difficulty];
  const noise = (rng() - 0.5) * 2 * noiseMax;
  const angle = bestAngle + noise;

  const power = Math.max(0.25, Math.min(1, bestPower));
  return { angleRad: angle, power };
}
