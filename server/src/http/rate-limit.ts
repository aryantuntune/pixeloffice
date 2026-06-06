// ---------------------------------------------------------------------------
// Tiny dependency-free in-memory rate limiter (token bucket per client IP).
//
// Goal: protect the admin REST API (event/meeting/broadcast creation) from
// accidental floods without pulling in a dependency. This is intentionally
// simple and process-local — for a multi-instance production deploy you would
// swap in a Redis-backed limiter behind the same Express middleware shape.
//
// Defaults: 60 requests / minute per IP. GET /api/health is ALWAYS a no-op so
// container/load-balancer health checks are never throttled.
//
// Framework note: this is the one place HTTP-shaped logic lives; the limiting
// algorithm itself (TokenBucket) is framework-free and unit-tested directly.
// ---------------------------------------------------------------------------

import type { NextFunction, Request, Response } from "express";

export interface RateLimitOptions {
  /** Bucket capacity = max burst. Also the steady-state budget per window. */
  capacity?: number;
  /** Length of the refill window in ms (capacity tokens refill over this). */
  windowMs?: number;
  /** Predicate: return true to skip limiting for a request (default: GET /health). */
  skip?: (req: Request) => boolean;
  /** Identify the caller. Default: best-effort client IP. */
  keyFor?: (req: Request) => string;
  /**
   * Whether the server sits behind a vetted reverse proxy. Only when true is the
   * client-supplied X-Forwarded-For header honored (via Express's parsed
   * req.ip). Defaults to false so the limiter cannot be bypassed by XFF
   * spoofing on a directly-exposed server. Set TRUST_PROXY (and Express
   * `trust proxy`) to enable it behind a real proxy.
   */
  trustProxy?: boolean;
  /** Injectable clock for tests. Default: Date.now. */
  now?: () => number;
  /** Periodically evict idle buckets so memory does not grow unbounded. */
  sweepIntervalMs?: number;
}

const DEFAULT_CAPACITY = 60;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_SWEEP_MS = 5 * 60_000;

/**
 * A single continuous-refill token bucket. `capacity` tokens refill linearly
 * over `windowMs`. Framework-free + deterministic via an injected clock.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = now;
  }

  /** Refill rate in tokens per millisecond. */
  private get ratePerMs(): number {
    return this.capacity / this.windowMs;
  }

  /** Attempt to spend one token. Returns true if allowed. */
  tryRemove(now: number): boolean {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Tokens currently available (after refilling to `now`). */
  available(now: number): number {
    this.refill(now);
    return Math.floor(this.tokens);
  }

  /** Whole ms until at least one token is available (0 if some now). */
  retryAfterMs(now: number): number {
    this.refill(now);
    if (this.tokens >= 1) return 0;
    const needed = 1 - this.tokens;
    return Math.ceil(needed / this.ratePerMs);
  }

  /** True if the bucket is full (used by the sweeper to evict idle entries). */
  isFull(now: number): boolean {
    this.refill(now);
    return this.tokens >= this.capacity;
  }

  private refill(now: number): void {
    if (now <= this.lastRefill) return;
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerMs);
    this.lastRefill = now;
  }
}

/** Default skip: never throttle health checks (GET /api/health, mounted at /health). */
export function isHealthCheck(req: Request): boolean {
  if (req.method !== "GET") return false;
  // Mounted under /api, so req.path is "/health"; also tolerate a full path.
  return req.path === "/health" || req.path === "/api/health";
}

/**
 * Best-effort client IP used as the rate-limit key.
 *
 * SECURITY: `X-Forwarded-For` is attacker-controlled and is only meaningful when
 * the server actually sits behind a vetted proxy. Honoring it unconditionally
 * lets an attacker mint a fresh bucket per request (random XFF) and defeat the
 * limiter entirely. We therefore ONLY trust XFF when `trustProxy` is true (set
 * via the TRUST_PROXY env / Express `trust proxy`). When trusted, we defer to
 * `req.ip`, which Express resolves from the forwarded chain according to its own
 * `trust proxy` setting rather than blindly taking the first hop. When NOT
 * trusted, we key off the real socket peer address and ignore XFF completely.
 */
export function clientIp(req: Request, trustProxy = false): string {
  if (trustProxy) {
    // Express has already parsed the forwarded chain into req.ip per its
    // `trust proxy` config; fall back to the socket peer if unavailable.
    return req.ip ?? req.socket?.remoteAddress ?? "unknown";
  }
  // Not behind a trusted proxy: never honor client-supplied XFF.
  return req.socket?.remoteAddress ?? req.ip ?? "unknown";
}

/**
 * Create an Express middleware that token-bucket rate-limits per client key.
 * Health checks are skipped by default. Returns a function with a `.buckets`
 * accessor exposed only for tests.
 */
export function createRateLimiter(options: RateLimitOptions = {}) {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const skip = options.skip ?? isHealthCheck;
  const trustProxy = options.trustProxy ?? false;
  const keyFor = options.keyFor ?? ((req: Request) => clientIp(req, trustProxy));
  const now = options.now ?? (() => Date.now());
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_MS;

  const buckets = new Map<string, TokenBucket>();
  let lastSweep = now();

  function sweep(at: number): void {
    if (at - lastSweep < sweepIntervalMs) return;
    lastSweep = at;
    for (const [key, bucket] of buckets) {
      if (bucket.isFull(at)) buckets.delete(key);
    }
  }

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (skip(req)) {
      next();
      return;
    }
    const at = now();
    sweep(at);

    const key = keyFor(req);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(capacity, windowMs, at);
      buckets.set(key, bucket);
    }

    if (bucket.tryRemove(at)) {
      res.setHeader("X-RateLimit-Limit", String(capacity));
      res.setHeader("X-RateLimit-Remaining", String(bucket.available(at)));
      next();
      return;
    }

    const retryAfterMs = bucket.retryAfterMs(at);
    res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
    res.status(429).json({ error: "Too many requests, slow down." });
  };

  // Exposed for tests only — do not rely on this in app code.
  (middleware as unknown as { buckets: Map<string, TokenBucket> }).buckets = buckets;
  return middleware as typeof middleware & { buckets: Map<string, TokenBucket> };
}
