// ---------------------------------------------------------------------------
// Proximity — a single PURE, framework-free helper (no I/O, no clock) that
// answers "which co-located peers are within talking distance of me?".
//
// This is the gate for proximity voice/video: the client shows call buttons for
// peers returned here and auto-mutes / ends a call when a peer drops out of the
// returned set. Kept pure so every distance rule is exhaustively testable
// (see proximity.test.ts), mirroring the presence engine.
//
// Distance is CHEBYSHEV (king-move) on the tile grid: max(|dx|, |dy|). "Within
// two tiles" therefore means anywhere in the surrounding 5x5 box — the intuitive
// reading of standing next to someone, regardless of diagonal.
// ---------------------------------------------------------------------------

/** Default talking radius in tiles (Chebyshev). Approaching within this many
 *  tiles of a peer surfaces the call buttons; leaving it auto-mutes. */
export const PROXIMITY_TILES = 2;

/**
 * A generous radius (tiles) within which a call may be INITIATED. Wider than
 * PROXIMITY_TILES so a click is not rejected if either avatar drifts a tile
 * mid-action; the server uses this only as a soft anti-spam gate on call
 * requests (never to force-disconnect an in-progress call). Pure constant.
 */
export const CALL_REQUEST_TILES = 4;

/** The minimal positional shape proximity needs from a player snapshot. */
export interface ProximityPeer {
  sessionId: string;
  x: number;
  y: number;
  /** Floor the peer is on; absent is treated as the ground floor (wire contract). */
  floorId?: string;
  /** Ambient NPCs are never callable peers. */
  isNpc?: boolean;
}

/** Chebyshev (king-move) tile distance between two points. */
export function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/** True when `a` and `b` are on the same floor (absent => ground). */
export function sameFloor(a: { floorId?: string }, b: { floorId?: string }): boolean {
  return (a.floorId ?? "ground") === (b.floorId ?? "ground");
}

/**
 * The sessionIds of every peer within `radius` tiles of `self`, EXCLUDING self,
 * NPCs, and anyone on a different floor. Order follows iteration order of
 * `others`. Deterministic and side-effect-free.
 */
export function peersWithin(
  self: ProximityPeer,
  others: Iterable<ProximityPeer>,
  radius: number = PROXIMITY_TILES,
): string[] {
  const out: string[] = [];
  for (const p of others) {
    if (p.sessionId === self.sessionId) continue;
    if (p.isNpc) continue;
    if (!sameFloor(self, p)) continue;
    if (chebyshev(self.x, self.y, p.x, p.y) <= radius) out.push(p.sessionId);
  }
  return out;
}

/** True when `self` and the peer are close enough to legally start a call. */
export function canCall(self: ProximityPeer, peer: ProximityPeer, radius: number = CALL_REQUEST_TILES): boolean {
  if (peer.sessionId === self.sessionId) return false;
  if (peer.isNpc) return false;
  if (!sameFloor(self, peer)) return false;
  return chebyshev(self.x, self.y, peer.x, peer.y) <= radius;
}
