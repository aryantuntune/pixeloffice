import { describe, expect, it } from "vitest";
import { InMemoryGoogleTokenStore, RedisGoogleTokenStore } from "./google-token.store";

describe("InMemoryGoogleTokenStore", () => {
  it("round-trips a record and lists connected users", () => {
    const store = new InMemoryGoogleTokenStore();
    expect(store.get("u1")).toBeNull();
    expect(store.connectedUserIds()).toEqual([]);

    store.save("u1", { refreshToken: "RT1", scope: "cal", email: "a@b.com" });
    const rec = store.get("u1");
    expect(rec?.refreshToken).toBe("RT1");
    expect(rec?.scope).toBe("cal");
    expect(typeof rec?.connectedAtMs).toBe("number");
    expect(store.connectedUserIds()).toEqual(["u1"]);
  });

  it("overwrites an existing grant on re-save", () => {
    const store = new InMemoryGoogleTokenStore();
    store.save("u1", { refreshToken: "old" });
    store.save("u1", { refreshToken: "new" });
    expect(store.get("u1")?.refreshToken).toBe("new");
    expect(store.connectedUserIds()).toEqual(["u1"]);
  });

  it("deletes a grant (disconnect)", () => {
    const store = new InMemoryGoogleTokenStore();
    store.save("u1", { refreshToken: "RT" });
    store.delete("u1");
    expect(store.get("u1")).toBeNull();
    expect(store.connectedUserIds()).toEqual([]);
  });

  it("preserves an explicitly supplied connectedAtMs", () => {
    const store = new InMemoryGoogleTokenStore();
    store.save("u1", { refreshToken: "RT", connectedAtMs: 123 });
    expect(store.get("u1")?.connectedAtMs).toBe(123);
  });
});

describe("RedisGoogleTokenStore", () => {
  function fakeRedis() {
    const kv = new Map<string, string>();
    const sets = new Map<string, Set<string>>();
    return {
      client: {
        async set(key: string, value: string) {
          kv.set(key, value);
        },
        async get(key: string) {
          return kv.get(key) ?? null;
        },
        async del(key: string) {
          kv.delete(key);
        },
        async sadd(key: string, value: string) {
          const set = sets.get(key) ?? new Set<string>();
          set.add(value);
          sets.set(key, set);
        },
        async srem(key: string, value: string) {
          sets.get(key)?.delete(value);
        },
        async smembers(key: string) {
          return [...(sets.get(key) ?? new Set<string>())];
        },
        rawValue(key: string) {
          return kv.get(key) ?? null;
        },
      },
    };
  }

  it("persists calendar grants and connected user ids in Redis", async () => {
    const redis = fakeRedis();
    const store = new RedisGoogleTokenStore(redis);

    await store.save("google:user@example.com", {
      refreshToken: "refresh",
      scope: "calendar",
      email: "user@example.com",
      connectedAtMs: 123,
    });

    expect(await store.get("google:user@example.com")).toEqual({
      refreshToken: "refresh",
      scope: "calendar",
      email: "user@example.com",
      connectedAtMs: 123,
    });
    expect(await store.connectedUserIds()).toEqual(["google:user@example.com"]);
  });

  it("removes the Redis record and set membership on disconnect", async () => {
    const redis = fakeRedis();
    const store = new RedisGoogleTokenStore(redis);

    await store.save("u1", { refreshToken: "refresh" });
    await store.delete("u1");

    expect(await store.get("u1")).toBeNull();
    expect(await store.connectedUserIds()).toEqual([]);
  });

  it("encrypts refresh-token records at rest when an encryption key is configured", async () => {
    const redis = fakeRedis();
    const store = new RedisGoogleTokenStore(redis, "test-secret");

    await store.save("u1", {
      refreshToken: "refresh-token-secret",
      scope: "calendar",
      connectedAtMs: 123,
    });

    const raw = redis.client.rawValue(
      "pixeloffice:google-calendar:token:dTE",
    );
    expect(raw).not.toContain("refresh-token-secret");
    expect(raw).not.toContain("calendar");
    expect(await store.get("u1")).toEqual({
      refreshToken: "refresh-token-secret",
      scope: "calendar",
      connectedAtMs: 123,
    });
  });
});
