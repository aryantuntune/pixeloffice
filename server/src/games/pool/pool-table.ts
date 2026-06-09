// ---------------------------------------------------------------------------
// Pool TABLE lifecycle (framework-free, pure decisions over a plain ActiveGame).
//
// The room owns the live ActiveGame object, presence locking, and broadcasting;
// it delegates the seat/rematch/leave DECISIONS here so the lifecycle is testable
// without Colyseus. Each function mutates the passed game in place (the room
// already treats `games.get(id)` as a mutable record) and returns a small result
// describing side effects the room must perform (lock/unlock presence, broadcast).
//
// Seating contract:
//   - First human -> seat 1 (player1). Group mode by default (status "waiting").
//   - "ai" mode on the first join -> seat 2 becomes the server AI, play starts.
//   - Second HUMAN at a group (non-AI) table -> seat 2, play starts (re-rack).
//   - A human joining a SOLO-vs-AI table where the original human is the ONLY real
//     player MAY take over the AI seat (converting to a two-human game) so a human
//     is never wrongly stuck as a spectator while a real seat is effectively free.
//   - Otherwise (both seats are humans) -> spectator (no seat).
// ---------------------------------------------------------------------------

import {
  POOL_AI_SESSION_ID,
  type ActiveGame,
  type GamePlayer,
  type PoolState,
} from "@pixeloffice/shared";
import { freshPoolState } from "./pool-setup";

const POOL_AI_PLAYER: GamePlayer = {
  sessionId: POOL_AI_SESSION_ID,
  name: "Pool Bot",
  avatarId: "slate",
};

/** What the room must do after a lifecycle decision. */
export interface PoolLifecycleResult {
  /** The sessionId became a seated human and must be locked into FOCUS. */
  lock: string[];
  /** The sessionId left a seat and its FOCUS lock must be released. */
  unlock: string[];
  /** Broadcast the (mutated) game's GAME_UPDATE to everyone. */
  broadcast: boolean;
  /** Send the current game only to this sessionId (spectator catch-up). */
  spectator?: string;
}

function empty(): PoolLifecycleResult {
  return { lock: [], unlock: [], broadcast: false };
}

/** Re-rack a pool game with the current seats; player1 always breaks. */
export function rackPool(game: ActiveGame): void {
  game.winnerSessionId = null;
  game.score1 = 0;
  game.score2 = 0;
  game.state = freshPoolState(game.player1!.sessionId);
  game.status = "playing";
}

/**
 * Seat a joining human at a pool table. Mutates `game`; returns the side effects.
 */
export function joinPool(
  game: ActiveGame,
  player: GamePlayer,
  mode: "ai" | "group" | undefined,
): PoolLifecycleResult {
  const result = empty();
  const sid = player.sessionId;

  // Already seated here: nothing to do (idempotent re-entry).
  if (game.player1?.sessionId === sid || game.player2?.sessionId === sid) {
    return result;
  }

  if (!game.player1) {
    game.player1 = player;
    result.lock.push(sid);
    if (mode === "ai") {
      game.vsAi = true;
      game.player2 = { ...POOL_AI_PLAYER };
      rackPool(game);
    } else {
      game.vsAi = false;
      game.status = "waiting";
    }
    result.broadcast = true;
    return result;
  }

  // Seat 1 is a human; seat 2 open and not an AI table => second human sits.
  if (!game.player2 && !game.vsAi) {
    game.player2 = player;
    result.lock.push(sid);
    rackPool(game);
    result.broadcast = true;
    return result;
  }

  // Seat 1 human, seat 2 is the AI (solo mode): a real human may take over the AI
  // seat so they are never stuck as a spectator behind a bot. Convert to a
  // two-human game and re-rack fresh.
  if (game.vsAi && game.player2?.sessionId === POOL_AI_SESSION_ID && game.player1.sessionId !== sid) {
    game.player2 = player;
    game.vsAi = false;
    result.lock.push(sid);
    rackPool(game);
    result.broadcast = true;
    return result;
  }

  // Both seats are real humans (or otherwise full): spectator.
  result.spectator = sid;
  return result;
}

/**
 * Rematch / "Play again": valid only when the game is OVER and the requester is a
 * seated human, with BOTH seats filled. Re-racks the SAME seats and re-breaks.
 * Returns broadcast=false (no-op) when the request is not allowed.
 */
export function rematchPool(game: ActiveGame, sessionId: string): PoolLifecycleResult {
  const result = empty();
  if (game.status !== "gameover") return result;
  const isP1 = game.player1?.sessionId === sessionId;
  const isP2 = game.player2?.sessionId === sessionId;
  if (!isP1 && !isP2) return result;
  if (!game.player1 || !game.player2) return result;

  if (game.player1.sessionId !== POOL_AI_SESSION_ID) result.lock.push(game.player1.sessionId);
  if (game.player2.sessionId !== POOL_AI_SESSION_ID) result.lock.push(game.player2.sessionId);

  rackPool(game);
  result.broadcast = true;
  return result;
}

/**
 * A player leaves/forfeits a pool table. Frees their seat and normalizes the
 * table so it is NEVER left in a locked terminal state:
 *   - solo-vs-AI, the lone human leaves -> drop the AI seat, table goes idle.
 *   - two humans mid-game -> the remaining human wins by forfeit (gameover).
 *   - otherwise -> collapse to idle when empty, else keep the lone human waiting,
 *     always dropping any leftover AI seat so a new human can take seat 2.
 */
export function leavePool(game: ActiveGame, sessionId: string): PoolLifecycleResult {
  const result = empty();

  let removed = false;
  let wasPlayer1 = false;
  if (game.player1?.sessionId === sessionId) {
    game.player1 = null;
    removed = true;
    wasPlayer1 = true;
  } else if (game.player2?.sessionId === sessionId) {
    game.player2 = null;
    removed = true;
  }
  if (!removed) return result; // spectator left — nothing to free
  result.unlock.push(sessionId);

  if (game.status === "playing") {
    if (game.vsAi) {
      // Lone human left a solo game: drop the AI seat, reset the table to idle.
      game.player1 = null;
      game.player2 = null;
      game.vsAi = false;
      game.status = "idle";
      game.state = null;
      game.winnerSessionId = null;
    } else {
      const remaining = wasPlayer1 ? game.player2 : game.player1;
      if (remaining) {
        game.winnerSessionId = remaining.sessionId;
        game.status = "gameover";
      } else {
        game.status = "idle";
        game.state = null;
      }
    }
  } else {
    // waiting / gameover / idle: normalize. Drop any leftover AI seat so a fresh
    // human can take seat 2 (this is the fix for "stuck after a vs-AI game").
    if (game.vsAi || game.player2?.sessionId === POOL_AI_SESSION_ID) {
      game.player2 = null;
      game.vsAi = false;
    }
    if (!game.player1 && !game.player2) {
      game.status = "idle";
      game.state = null;
      game.vsAi = false;
      game.winnerSessionId = null;
    } else {
      // Promote a lone seat-2 human into seat 1 so player1 (the breaker) is always
      // the occupied seat for a clean re-rack on the next join.
      if (!game.player1 && game.player2) {
        game.player1 = game.player2;
        game.player2 = null;
      }
      game.status = "waiting";
      game.winnerSessionId = null;
    }
  }

  result.broadcast = true;
  return result;
}

/** True when the given pool state is mid-shot animation (input should be dropped). */
export function isPoolAnimating(state: PoolState | null): boolean {
  return !!state && state.animating;
}
