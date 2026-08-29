import { describe, expect, it } from "vitest";
import { redisRetryStrategy } from "./redis";

describe("redisRetryStrategy", () => {
  it("never gives up (never returns null/undefined), even after many failures", () => {
    for (const times of [1, 2, 3, 4, 10, 100, 100_000]) {
      expect(redisRetryStrategy(times)).toEqual(expect.any(Number));
    }
  });

  it("backs off with each attempt, capped at 5s", () => {
    expect(redisRetryStrategy(1)).toBe(200);
    expect(redisRetryStrategy(5)).toBe(1000);
    expect(redisRetryStrategy(1000)).toBe(5000);
  });
});
