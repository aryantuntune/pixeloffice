// ---------------------------------------------------------------------------
// PresenceStore (Layer 4 — Presence storage).
//
// Records the LATEST resolved presence per user so it survives a server restart
// or can be read by a future fleet of server instances. This is the "Presence
// storage" + minimal "Event storage" requirement from plan Layer 4.
//
// === NO-SURVEILLANCE BOUNDARY (plan Principle 2 — non-negotiable) ===
// We store ONLY:
//   - the presence STATE (AVAILABLE / IN_MEETING / FOCUS / BREAK / AWAY / OFFLINE)
//   - the explicit SOURCE of that state (MANUAL / CALENDAR / EVENT / AUTO / SYSTEM)
//   - the single timestamp of that change (atMs) — needed to know which value is
//     current, nothing more.
// We do NOT store: keystrokes, mouse, screenshots, per-action activity logs,
// dwell time, productivity metrics, or any browsable per-user history. The
// capped presence-log below is a short rolling buffer for operational debugging
// of state transitions ONLY (state+source+time) and is NOT exposed via any API
// in this version — there are intentionally no history query methods here.
// ---------------------------------------------------------------------------

import type { PresenceSource, PresenceState } from "@pixeloffice/shared";
import type { RedisStore } from "./redis";

/** A single recorded presence value (the only shape we ever persist). */
export interface PresenceRecord {
  userId: string;
  state: PresenceState;
  source: PresenceSource;
  /** Epoch ms of this change. Injected by the caller — stores never read the clock. */
  atMs: number;
}

export interface PresenceStore {
  /** Persist the latest presence for a user. Overwrites the previous latest. */
  record(userId: string, state: PresenceState, source: PresenceSource, atMs: number): Promise<void>;
  /** The most recently recorded presence for a user, or null if none. */
  latest(userId: string): Promise<PresenceRecord | null>;
}

/**
 * Default store. Holds the latest presence per user in a Map. Used whenever
 * REDIS_URL is unset (the zero-config path) and as the fallback when Redis is
 * configured but unreachable at boot.
 */
export class InMemoryPresenceStore implements PresenceStore {
  private readonly latestByUser = new Map<string, PresenceRecord>();

  async record(
    userId: string,
    state: PresenceState,
    source: PresenceSource,
    atMs: number,
  ): Promise<void> {
    this.latestByUser.set(userId, { userId, state, source, atMs });
  }

  async latest(userId: string): Promise<PresenceRecord | null> {
    const found = this.latestByUser.get(userId);
    return found ? { ...found } : null;
  }
}

/** Number of entries retained in the rolling debug log (oldest trimmed). */
const PRESENCE_LOG_CAP = 1000;
/** TTL (seconds) for the latest-presence hash; refreshed on every record. */
const LATEST_TTL_SECONDS = 60 * 60 * 24; // 24h — a presence is "current" only briefly anyway

/**
 * Redis-backed store.
 *  - Latest per user:  HSET office:presence:<userId> {state, source, atMs}
 *                      (with a TTL — we never want stale presence to linger).
 *  - Rolling log:      LPUSH office:presence-log <json> + LTRIM to PRESENCE_LOG_CAP.
 *
 * Retention: the per-user hash expires after LATEST_TTL_SECONDS; the log is
 * capped at PRESENCE_LOG_CAP entries (a bounded ring, not unbounded history).
 * Both hold ONLY {state, source, atMs} — see the no-surveillance note above.
 */
export class RedisPresenceStore implements PresenceStore {
  private static readonly LATEST_KEY = (userId: string) => `office:presence:${userId}`;
  private static readonly LOG_KEY = "office:presence-log";

  constructor(private readonly redis: RedisStore) {}

  async record(
    userId: string,
    state: PresenceState,
    source: PresenceSource,
    atMs: number,
  ): Promise<void> {
    const key = RedisPresenceStore.LATEST_KEY(userId);
    const client = this.redis.client;
    // Pipeline the three writes; failures degrade silently (presence still
    // flows live over the wire — persistence is best-effort, not a dependency).
    try {
      await client
        .multi()
        .hset(key, {
          state,
          source,
          atMs: String(atMs),
        })
        .expire(key, LATEST_TTL_SECONDS)
        .lpush(
          RedisPresenceStore.LOG_KEY,
          JSON.stringify({ userId, state, source, atMs }),
        )
        .ltrim(RedisPresenceStore.LOG_KEY, 0, PRESENCE_LOG_CAP - 1)
        .exec();
    } catch (err) {
      console.error(
        "[PixelOffice][redis] presence record failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async latest(userId: string): Promise<PresenceRecord | null> {
    try {
      const raw = await this.redis.client.hgetall(RedisPresenceStore.LATEST_KEY(userId));
      if (!raw || !raw.state) return null;
      return {
        userId,
        state: raw.state as PresenceState,
        source: raw.source as PresenceSource,
        atMs: Number.parseInt(raw.atMs ?? "0", 10),
      };
    } catch (err) {
      console.error(
        "[PixelOffice][redis] presence latest failed:",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }
}
