// ---------------------------------------------------------------------------
// Redis connection wrapper (Layer 4 — Persistence).
//
// A thin wrapper over an ioredis client, used for presence + session storage
// (plan Layer 4). Activated ONLY when REDIS_URL is present; with no env config
// the office runs entirely in-memory (the zero-config path is sacred).
//
// Lifecycle mirrors Database: lazy connect (lazyConnect so construction never
// throws), health(), graceful end().
//
// Framework-independent: imports no Colyseus / Express.
// ---------------------------------------------------------------------------

import Redis, { type RedisOptions } from "ioredis";

export interface RedisConfig {
  /** Redis connection string, e.g. redis://localhost:6379 */
  url: string;
}

/**
 * Owns a single ioredis client. Construct via `RedisStore.fromEnv()` (returns
 * null when REDIS_URL is absent) so callers can fall back to in-memory storage.
 */
export class RedisStore {
  /** The underlying ioredis client (exposed for repositories/stores). */
  readonly client: Redis;

  constructor(config: RedisConfig) {
    const options: RedisOptions = {
      // Connect lazily so a dead Redis at boot does not throw in the
      // constructor — health() decides whether to use it (graceful degradation).
      lazyConnect: true,
      // Bounded retries: don't spin forever against a dead server.
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
    };
    this.client = new Redis(config.url, options);
    // Swallow connection errors at the client level so an unreachable Redis
    // never crashes the process (plan: office must keep working).
    this.client.on("error", (err) => {
      console.error("[PixelOffice][redis] client error:", err.message);
    });
  }

  /**
   * Build from env. Returns null when REDIS_URL is unset so the integrator can
   * choose the in-memory path.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): RedisStore | null {
    const url = env.REDIS_URL?.trim();
    if (!url) return null;
    return new RedisStore({ url });
  }

  /**
   * Verify connectivity (connects lazily on first call). Resolves true on a
   * successful PING, false on any failure (never throws).
   */
  async health(): Promise<boolean> {
    try {
      if (this.client.status !== "ready" && this.client.status !== "connecting") {
        await this.client.connect();
      }
      const pong = await this.client.ping();
      return pong === "PONG";
    } catch (err) {
      console.error(
        "[PixelOffice][redis] health check failed:",
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  }

  /** Close the connection. Safe to call once at shutdown. */
  async end(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
