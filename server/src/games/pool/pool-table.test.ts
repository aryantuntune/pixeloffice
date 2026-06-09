// ---------------------------------------------------------------------------
// Pool TABLE lifecycle tests (framework-free): two-human seating, solo-vs-AI,
// rematch reset, and leave/normalize so the table is never left locked.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { POOL_AI_SESSION_ID, type ActiveGame, type GamePlayer, type PoolState } from "@pixeloffice/shared";
import { joinPool, leavePool, rematchPool } from "./pool-table";

const A: GamePlayer = { sessionId: "alice", name: "Alice", avatarId: "a" };
const B: GamePlayer = { sessionId: "bob", name: "Bob", avatarId: "b" };
const C: GamePlayer = { sessionId: "carol", name: "Carol", avatarId: "c" };

function freshTable(): ActiveGame {
  return {
    id: "lounge:pool",
    type: "pool",
    player1: null,
    player2: null,
    score1: 0,
    score2: 0,
    winnerSessionId: null,
    state: null,
    status: "idle",
  };
}

describe("two-human seating", () => {
  it("first human takes seat 1 (group, waiting); second human takes seat 2 (playing)", () => {
    const g = freshTable();
    const r1 = joinPool(g, A, undefined);
    expect(g.player1?.sessionId).toBe("alice");
    expect(g.vsAi).toBe(false);
    expect(g.status).toBe("waiting");
    expect(r1.lock).toEqual(["alice"]);

    const r2 = joinPool(g, B, undefined);
    expect(g.player2?.sessionId).toBe("bob");
    expect(g.status).toBe("playing");
    expect(r2.lock).toEqual(["bob"]);
    // A fresh rack with player1 (alice) to break.
    const st = g.state as PoolState;
    expect(st.currentTurn).toBe("alice");
    expect(st.balls.filter((b) => !b.pocketed)).toHaveLength(16);
  });

  it("a third human becomes a spectator (no seat)", () => {
    const g = freshTable();
    joinPool(g, A, undefined);
    joinPool(g, B, undefined);
    const r3 = joinPool(g, C, undefined);
    expect(r3.spectator).toBe("carol");
    expect(r3.broadcast).toBe(false);
    expect(g.player1?.sessionId).toBe("alice");
    expect(g.player2?.sessionId).toBe("bob");
  });

  it("re-joining when already seated is a no-op (idempotent)", () => {
    const g = freshTable();
    joinPool(g, A, undefined);
    joinPool(g, B, undefined);
    const again = joinPool(g, A, undefined);
    expect(again.broadcast).toBe(false);
    expect(again.lock).toEqual([]);
    expect(g.player1?.sessionId).toBe("alice");
  });

  it("a human is never stuck as spectator behind the AI: takes over the bot seat", () => {
    const g = freshTable();
    joinPool(g, A, "ai");
    expect(g.vsAi).toBe(true);
    expect(g.player2?.sessionId).toBe(POOL_AI_SESSION_ID);
    // Bob walks up and joins: he takes over the AI seat, two-human game starts.
    const rb = joinPool(g, B, undefined);
    expect(g.vsAi).toBe(false);
    expect(g.player2?.sessionId).toBe("bob");
    expect(g.status).toBe("playing");
    expect(rb.lock).toEqual(["bob"]);
  });
});

describe("solo vs AI", () => {
  it("'ai' mode seats the bot and starts immediately, player1 breaks", () => {
    const g = freshTable();
    joinPool(g, A, "ai");
    expect(g.vsAi).toBe(true);
    expect(g.status).toBe("playing");
    const st = g.state as PoolState;
    expect(st.currentTurn).toBe("alice");
  });
});

describe("rematch / not locked after game over", () => {
  it("a seated human can rematch a finished two-human game (same seats, re-break)", () => {
    const g = freshTable();
    joinPool(g, A, undefined);
    joinPool(g, B, undefined);
    // Simulate a finished game.
    g.status = "gameover";
    g.winnerSessionId = "bob";
    (g.state as PoolState).currentTurn = "bob";

    const r = rematchPool(g, "bob");
    expect(r.broadcast).toBe(true);
    expect(g.status).toBe("playing");
    expect(g.winnerSessionId).toBeNull();
    expect(g.player1?.sessionId).toBe("alice");
    expect(g.player2?.sessionId).toBe("bob");
    const st = g.state as PoolState;
    expect(st.currentTurn).toBe("alice"); // player1 re-breaks
    expect(st.balls.filter((b) => !b.pocketed)).toHaveLength(16);
    expect(r.lock.sort()).toEqual(["alice", "bob"]);
  });

  it("rematch works for a solo vs-AI game and only locks the human", () => {
    const g = freshTable();
    joinPool(g, A, "ai");
    g.status = "gameover";
    g.winnerSessionId = POOL_AI_SESSION_ID;

    const r = rematchPool(g, "alice");
    expect(r.broadcast).toBe(true);
    expect(g.status).toBe("playing");
    expect(g.vsAi).toBe(true);
    expect(r.lock).toEqual(["alice"]); // AI seat is synthetic, not locked
  });

  it("rematch is rejected from a spectator or before game over", () => {
    const g = freshTable();
    joinPool(g, A, undefined);
    joinPool(g, B, undefined);
    // Still playing -> rejected.
    expect(rematchPool(g, "alice").broadcast).toBe(false);
    // Over, but requester is not seated -> rejected.
    g.status = "gameover";
    expect(rematchPool(g, "carol").broadcast).toBe(false);
    expect(g.status).toBe("gameover");
  });
});

describe("leave / normalize — table never left locked", () => {
  it("solo vs-AI: the lone human leaving resets the table to idle", () => {
    const g = freshTable();
    joinPool(g, A, "ai");
    const r = leavePool(g, "alice");
    expect(r.unlock).toEqual(["alice"]);
    expect(g.status).toBe("idle");
    expect(g.player1).toBeNull();
    expect(g.player2).toBeNull();
    expect(g.vsAi).toBe(false);
    expect(g.state).toBeNull();
  });

  it("two humans mid-game: the leaver forfeits, the other wins", () => {
    const g = freshTable();
    joinPool(g, A, undefined);
    joinPool(g, B, undefined);
    const r = leavePool(g, "alice");
    expect(r.unlock).toEqual(["alice"]);
    expect(g.status).toBe("gameover");
    expect(g.winnerSessionId).toBe("bob");
  });

  it("AFTER a vs-AI game over, the human leaving does NOT leave the AI stuck in seat 2", () => {
    // This reproduces the original "stuck after a game / 2 players can't join" bug.
    const g = freshTable();
    joinPool(g, A, "ai");
    g.status = "gameover";
    g.winnerSessionId = POOL_AI_SESSION_ID;

    leavePool(g, "alice");
    // The AI seat must be cleared and the table freed (idle) so anyone can start.
    expect(g.player1).toBeNull();
    expect(g.player2).toBeNull();
    expect(g.vsAi).toBe(false);
    expect(g.status).toBe("idle");

    // Two fresh humans can now both seat themselves.
    joinPool(g, B, undefined);
    joinPool(g, C, undefined);
    expect(g.player1?.sessionId).toBe("bob");
    expect(g.player2?.sessionId).toBe("carol");
    expect(g.status).toBe("playing");
  });

  it("leaving after gameover with a remaining human keeps a lone seat waiting (re-join works)", () => {
    const g = freshTable();
    joinPool(g, A, undefined);
    joinPool(g, B, undefined);
    g.status = "gameover";
    g.winnerSessionId = "bob";

    // Alice leaves; Bob remains -> waiting, promoted to seat 1.
    leavePool(g, "alice");
    expect(g.status).toBe("waiting");
    expect(g.player1?.sessionId).toBe("bob");
    expect(g.player2).toBeNull();
    expect(g.winnerSessionId).toBeNull();

    // A new human can take seat 2 and start fresh.
    const r = joinPool(g, C, undefined);
    expect(g.player2?.sessionId).toBe("carol");
    expect(g.status).toBe("playing");
    expect(r.lock).toEqual(["carol"]);
  });

  it("a spectator leaving is a no-op", () => {
    const g = freshTable();
    joinPool(g, A, undefined);
    joinPool(g, B, undefined);
    const r = leavePool(g, "carol");
    expect(r.broadcast).toBe(false);
    expect(g.player1?.sessionId).toBe("alice");
    expect(g.player2?.sessionId).toBe("bob");
  });
});
