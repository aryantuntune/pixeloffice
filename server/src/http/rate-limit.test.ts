import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import {
  TokenBucket,
  clientIp,
  createRateLimiter,
  isHealthCheck,
} from "./rate-limit";

// --- TokenBucket (framework-free algorithm) --------------------------------

describe("TokenBucket", () => {
  it("starts full and allows up to capacity bursts", () => {
    const b = new TokenBucket(3, 1000, 0);
    expect(b.tryRemove(0)).toBe(true);
    expect(b.tryRemove(0)).toBe(true);
    expect(b.tryRemove(0)).toBe(true);
    expect(b.tryRemove(0)).toBe(false); // 4th in same instant is denied
  });

  it("refills linearly over the window", () => {
    const b = new TokenBucket(60, 60_000, 0); // 1 token / 1000ms
    for (let i = 0; i < 60; i++) expect(b.tryRemove(0)).toBe(true);
    expect(b.tryRemove(0)).toBe(false);
    // After 1s exactly one token refills.
    expect(b.tryRemove(1000)).toBe(true);
    expect(b.tryRemove(1000)).toBe(false);
    // After 5 more seconds, 5 tokens.
    expect(b.available(6000)).toBe(5);
  });

  it("never exceeds capacity when idle", () => {
    const b = new TokenBucket(10, 1000, 0);
    expect(b.available(1_000_000)).toBe(10);
    expect(b.isFull(1_000_000)).toBe(true);
  });

  it("reports retryAfterMs when empty", () => {
    const b = new TokenBucket(2, 2000, 0); // 1 token / 1000ms
    b.tryRemove(0);
    b.tryRemove(0);
    expect(b.retryAfterMs(0)).toBe(1000);
    expect(b.retryAfterMs(500)).toBe(500);
    expect(b.retryAfterMs(1000)).toBe(0);
  });
});

// --- helpers ---------------------------------------------------------------

describe("isHealthCheck", () => {
  it("matches GET /health (mounted under /api)", () => {
    expect(isHealthCheck({ method: "GET", path: "/health" } as Request)).toBe(true);
    expect(isHealthCheck({ method: "GET", path: "/api/health" } as Request)).toBe(true);
  });
  it("does not match POSTs or other paths", () => {
    expect(isHealthCheck({ method: "POST", path: "/health" } as Request)).toBe(false);
    expect(isHealthCheck({ method: "GET", path: "/users" } as Request)).toBe(false);
  });
});

describe("clientIp", () => {
  it("ignores X-Forwarded-For when not behind a trusted proxy (anti-spoofing)", () => {
    const req = {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      ip: "9.9.9.9",
      socket: { remoteAddress: "203.0.113.7" },
    } as unknown as Request;
    // The spoofable XFF must be ignored; key off the real socket peer.
    expect(clientIp(req)).toBe("203.0.113.7");
    expect(clientIp(req, false)).toBe("203.0.113.7");
  });
  it("uses Express-resolved req.ip when behind a trusted proxy", () => {
    const req = {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      ip: "1.2.3.4",
      socket: { remoteAddress: "203.0.113.7" },
    } as unknown as Request;
    expect(clientIp(req, true)).toBe("1.2.3.4");
  });
  it("falls back to socket address then req.ip", () => {
    const onlyIp = { headers: {}, ip: "9.9.9.9", socket: {} } as unknown as Request;
    expect(clientIp(onlyIp)).toBe("9.9.9.9");
  });
});

describe("createRateLimiter trust-proxy gating", () => {
  it("does NOT let X-Forwarded-For spoofing mint fresh buckets by default", () => {
    let now = 0;
    const mw = createRateLimiter({ capacity: 1, windowMs: 1000, now: () => now });
    const next = vi.fn();
    const socket = { remoteAddress: "203.0.113.7" } as unknown as Request["socket"];

    const r1 = makeRes();
    mw(makeReq({ headers: { "x-forwarded-for": "1.1.1.1" }, socket }), r1, next);
    const r2 = makeRes();
    mw(makeReq({ headers: { "x-forwarded-for": "2.2.2.2" }, socket }), r2, next);

    expect(r1.statusCode).toBe(200);
    // Same real peer -> same bucket -> second request throttled despite new XFF.
    expect(r2.statusCode).toBe(429);
  });

  it("honors X-Forwarded-For only when trustProxy is set", () => {
    let now = 0;
    const mw = createRateLimiter({
      capacity: 1,
      windowMs: 1000,
      trustProxy: true,
      now: () => now,
    });
    const next = vi.fn();
    const socket = { remoteAddress: "203.0.113.7" } as unknown as Request["socket"];

    // With trustProxy, distinct req.ip (parsed by Express) => distinct buckets.
    const r1 = makeRes();
    mw(makeReq({ ip: "1.1.1.1", socket }), r1, next);
    const r2 = makeRes();
    mw(makeReq({ ip: "2.2.2.2", socket }), r2, next);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
  });
});

// --- middleware ------------------------------------------------------------

interface FakeRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status(code: number): FakeRes;
  json(b: unknown): FakeRes;
  setHeader(k: string, v: string): void;
}

function makeRes(): FakeRes & Response {
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
  };
  return res as unknown as FakeRes & Response;
}

function makeReq(over: Partial<Request> = {}): Request {
  // Default the socket peer to the supplied `ip` so existing per-IP tests stay
  // meaningful under the default (untrusted-proxy) keying that uses the socket
  // address. Callers can still override `socket` explicitly.
  const ip = (over.ip as string | undefined) ?? "10.0.0.1";
  return {
    method: "POST",
    path: "/events",
    headers: {},
    ip,
    socket: { remoteAddress: ip },
    ...over,
  } as Request;
}

describe("createRateLimiter middleware", () => {
  it("allows up to capacity then returns 429", () => {
    let now = 0;
    const mw = createRateLimiter({ capacity: 2, windowMs: 1000, now: () => now });
    const next: NextFunction = vi.fn();

    const r1 = makeRes();
    mw(makeReq(), r1, next);
    const r2 = makeRes();
    mw(makeReq(), r2, next);
    const r3 = makeRes();
    mw(makeReq(), r3, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(r3.statusCode).toBe(429);
    expect(r3.headers["Retry-After"]).toBeDefined();
  });

  it("refills over time", () => {
    let now = 0;
    const mw = createRateLimiter({ capacity: 1, windowMs: 1000, now: () => now });
    const next = vi.fn();

    mw(makeReq(), makeRes(), next); // ok
    const blocked = makeRes();
    mw(makeReq(), blocked, next); // denied
    expect(blocked.statusCode).toBe(429);

    now = 1000; // one token back
    const after = makeRes();
    mw(makeReq(), after, next);
    expect(after.statusCode).toBe(200);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("is a no-op for health checks (never throttled)", () => {
    const mw = createRateLimiter({ capacity: 1, windowMs: 1000 });
    const next = vi.fn();
    for (let i = 0; i < 50; i++) {
      const res = makeRes();
      mw(makeReq({ method: "GET", path: "/health" }), res, next);
      expect(res.statusCode).toBe(200);
    }
    expect(next).toHaveBeenCalledTimes(50);
  });

  it("buckets per IP independently", () => {
    let now = 0;
    const mw = createRateLimiter({ capacity: 1, windowMs: 1000, now: () => now });
    const next = vi.fn();

    const a1 = makeRes();
    mw(makeReq({ ip: "1.1.1.1" }), a1, next);
    const b1 = makeRes();
    mw(makeReq({ ip: "2.2.2.2" }), b1, next);
    expect(a1.statusCode).toBe(200);
    expect(b1.statusCode).toBe(200);

    const a2 = makeRes();
    mw(makeReq({ ip: "1.1.1.1" }), a2, next);
    expect(a2.statusCode).toBe(429); // IP 1 exhausted, IP 2 untouched
  });
});
