// ---------------------------------------------------------------------------
// PresenceStore contract test suite.
//
// `runPresenceStoreContract` asserts the behaviour EVERY PresenceStore impl must
// satisfy (record overwrites latest, latest reads it back, isolation per user).
// Exported so the Redis impl can reuse the same assertions against a real Redis
// when one is available — guarded by TEST_REDIS_URL so CI (no Redis) skips it.
// ---------------------------------------------------------------------------

import { afterAll, describe, expect, it } from "vitest";
import { PresenceState } from "@pixeloffice/shared";
import { InMemoryPresenceStore, type PresenceStore } from "./presence-store";

export function runPresenceStoreContract(
  label: string,
  makeStore: () => Promise<PresenceStore> | PresenceStore,
): void {
  describe(`PresenceStore contract: ${label}`, () => {
    it("returns null for a user with no recorded presence", async () => {
      const store = await makeStore();
      expect(await store.latest("ghost")).toBeNull();
    });

    it("records and reads back the latest presence", async () => {
      const store = await makeStore();
      await store.record("u1", PresenceState.FOCUS, "MANUAL", 1000);
      expect(await store.latest("u1")).toEqual({
        userId: "u1",
        state: PresenceState.FOCUS,
        source: "MANUAL",
        atMs: 1000,
      });
    });

    it("record overwrites the previous latest (no history surfaced)", async () => {
      const store = await makeStore();
      await store.record("u1", PresenceState.AVAILABLE, "SYSTEM", 1000);
      await store.record("u1", PresenceState.IN_MEETING, "CALENDAR", 2000);
      expect(await store.latest("u1")).toEqual({
        userId: "u1",
        state: PresenceState.IN_MEETING,
        source: "CALENDAR",
        atMs: 2000,
      });
    });

    it("keeps users isolated", async () => {
      const store = await makeStore();
      await store.record("u1", PresenceState.BREAK, "EVENT", 1000);
      await store.record("u2", PresenceState.AWAY, "AUTO", 1500);
      expect((await store.latest("u1"))?.state).toBe(PresenceState.BREAK);
      expect((await store.latest("u2"))?.state).toBe(PresenceState.AWAY);
    });
  });
}

// --- In-memory impl: always run. -------------------------------------------
runPresenceStoreContract("InMemoryPresenceStore", () => new InMemoryPresenceStore());

// --- Redis impl: opt-in via TEST_REDIS_URL (skipped in CI). -----------------
// Guarded so `ioredis` is NEVER imported when the env var is absent — that keeps
// the in-memory suite (and CI) runnable without the `ioredis` dependency.
const TEST_REDIS_URL = process.env.TEST_REDIS_URL;

if (TEST_REDIS_URL) {
  describe("PresenceStore contract: RedisPresenceStore (live Redis)", async () => {
    const { RedisStore } = await import("./redis");
    const { RedisPresenceStore } = await import("./presence-store");
    const redis = new RedisStore({ url: TEST_REDIS_URL });
    await redis.health();

    afterAll(async () => {
      await redis.end();
    });

    runPresenceStoreContract("RedisPresenceStore", async () => {
      // Fresh state per case: drop the presence keys (test Redis only).
      await redis.client.flushdb();
      return new RedisPresenceStore(redis);
    });
  });
} else {
  describe.skip("PresenceStore contract: RedisPresenceStore (live Redis) — set TEST_REDIS_URL to run", () => {
    it("skipped", () => {});
  });
}
