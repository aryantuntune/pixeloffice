// ---------------------------------------------------------------------------
// PairCodeStore tests — mint / lookup / expiry / invalidate.
//
// The store ties a companion floor report to the exact session that minted the
// code, IP-independent. These pin: a fresh code resolves to its session; an
// unknown code is null; a code is normalized (trim + case-insensitive); expiry
// (TTL) drops it; re-minting for a session invalidates the prior code; and
// invalidateSession (disable / leave) drops it immediately.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { PairCodeStore } from "./pair-code.store";

describe("PairCodeStore", () => {
  it("mints a code that resolves to the owning session", () => {
    const store = new PairCodeStore();
    const now = 1_000;
    const code = store.mint("sess-1", "user-1", now);
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    expect(store.lookup(code, now)).toEqual({ sessionId: "sess-1", userId: "user-1" });
  });

  it("returns null for an unknown / empty code", () => {
    const store = new PairCodeStore();
    expect(store.lookup("NOPE12", 0)).toBeNull();
    expect(store.lookup("", 0)).toBeNull();
    expect(store.lookup(undefined, 0)).toBeNull();
  });

  it("normalizes the code (trim + case-insensitive)", () => {
    const store = new PairCodeStore();
    const code = store.mint("sess-1", "user-1", 0);
    expect(store.lookup(`  ${code.toLowerCase()}  `, 0)).toEqual({
      sessionId: "sess-1",
      userId: "user-1",
    });
  });

  it("expires a code after its TTL", () => {
    const store = new PairCodeStore(1000); // 1s TTL
    const code = store.mint("sess-1", "user-1", 0);
    expect(store.lookup(code, 999)).not.toBeNull();
    expect(store.lookup(code, 1000)).toBeNull(); // expiresAt <= now => gone
    expect(store.size()).toBe(0); // pruned on access
  });

  it("prune(now) sweeps every expired entry", () => {
    const store = new PairCodeStore(1000);
    store.mint("a", "ua", 0);
    store.mint("b", "ub", 0);
    expect(store.size()).toBe(2);
    store.prune(1000);
    expect(store.size()).toBe(0);
  });

  it("re-minting for a session invalidates that session's previous code", () => {
    const store = new PairCodeStore();
    const first = store.mint("sess-1", "user-1", 0);
    const second = store.mint("sess-1", "user-1", 0);
    expect(second).not.toBe(first);
    expect(store.lookup(first, 0)).toBeNull(); // old code dead
    expect(store.lookup(second, 0)).not.toBeNull();
    expect(store.size()).toBe(1); // never accumulates per session
  });

  it("invalidateSession drops the code (disable / leave)", () => {
    const store = new PairCodeStore();
    const code = store.mint("sess-1", "user-1", 0);
    store.invalidateSession("sess-1");
    expect(store.lookup(code, 0)).toBeNull();
    expect(store.size()).toBe(0);
    // Idempotent: invalidating again / an unknown session is a no-op.
    expect(() => store.invalidateSession("sess-1")).not.toThrow();
    expect(() => store.invalidateSession("unknown")).not.toThrow();
  });

  it("keeps distinct sessions independent", () => {
    const store = new PairCodeStore();
    const a = store.mint("a", "ua", 0);
    const b = store.mint("b", "ub", 0);
    expect(a).not.toBe(b);
    store.invalidateSession("a");
    expect(store.lookup(a, 0)).toBeNull();
    expect(store.lookup(b, 0)).toEqual({ sessionId: "b", userId: "ub" });
  });
});
