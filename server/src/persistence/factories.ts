// ---------------------------------------------------------------------------
// Persistence factories — the single seam the integrator wires into container.ts.
//
// These functions encapsulate ALL the selection + graceful-degradation logic so
// the container change stays tiny:
//   - DATABASE_URL set & reachable  -> PostgresUserRepository (migrated)
//   - DATABASE_URL set but DOWN     -> warn + InMemoryUserRepository (fallback)
//   - DATABASE_URL unset            -> InMemoryUserRepository (zero-config path)
//   - REDIS_URL set & reachable     -> RedisPresenceStore
//   - REDIS_URL set but DOWN        -> warn + InMemoryPresenceStore (fallback)
//   - REDIS_URL unset               -> InMemoryPresenceStore (zero-config path)
//
// Falling back instead of crashing is non-negotiable: the office must keep
// working if a configured datastore is unavailable (plan Principle 4).
//
// Each factory returns the chosen impl PLUS the owning connection (or null) so
// the integrator can health-check, register a /api/health probe, and end() the
// connection on shutdown.
// ---------------------------------------------------------------------------

import { Database } from "./database";
import { RedisStore } from "./redis";
import {
  InMemoryPresenceStore,
  RedisPresenceStore,
  type PresenceStore,
} from "./presence-store";
import {
  InMemoryUserRepository,
  type UserRepository,
} from "../repositories/user.repository";
import { PostgresUserRepository } from "../repositories/postgres-user.repository";

export interface UserRepositoryResult {
  repository: UserRepository;
  /** Non-null only when Postgres was successfully selected (for health/shutdown). */
  database: Database | null;
  backend: "postgres" | "memory";
}

export interface PresenceStoreResult {
  store: PresenceStore;
  /** Non-null only when Redis was successfully selected (for health/shutdown). */
  redis: RedisStore | null;
  backend: "redis" | "memory";
}

/**
 * Pick the user repository. Tries Postgres when DATABASE_URL is set (health
 * check + migrate); on any failure logs a clear warning and returns in-memory.
 */
export async function createUserRepository(
  env: NodeJS.ProcessEnv = process.env,
): Promise<UserRepositoryResult> {
  const database = Database.fromEnv(env);
  if (!database) {
    return { repository: new InMemoryUserRepository(), database: null, backend: "memory" };
  }

  const ok = await database.health();
  if (!ok) {
    console.warn(
      "[PixelOffice] DATABASE_URL is set but Postgres is unreachable — " +
        "falling back to in-memory user storage (the office keeps working).",
    );
    await safeEnd(database);
    return { repository: new InMemoryUserRepository(), database: null, backend: "memory" };
  }

  try {
    await database.migrate();
  } catch (err) {
    console.warn(
      "[PixelOffice] Postgres reachable but schema migration failed — " +
        "falling back to in-memory user storage:",
      err instanceof Error ? err.message : String(err),
    );
    await safeEnd(database);
    return { repository: new InMemoryUserRepository(), database: null, backend: "memory" };
  }

  console.log("[PixelOffice] using PostgreSQL user storage.");
  return { repository: new PostgresUserRepository(database), database, backend: "postgres" };
}

/**
 * Pick the presence store. Tries Redis when REDIS_URL is set (health check);
 * on any failure logs a clear warning and returns in-memory.
 */
export async function createPresenceStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PresenceStoreResult> {
  const redis = RedisStore.fromEnv(env);
  if (!redis) {
    return { store: new InMemoryPresenceStore(), redis: null, backend: "memory" };
  }

  const ok = await redis.health();
  if (!ok) {
    console.warn(
      "[PixelOffice] REDIS_URL is set but Redis is unreachable — " +
        "falling back to in-memory presence storage (the office keeps working).",
    );
    await safeEnd(redis);
    return { store: new InMemoryPresenceStore(), redis: null, backend: "memory" };
  }

  console.log("[PixelOffice] using Redis presence storage.");
  return { store: new RedisPresenceStore(redis), redis, backend: "redis" };
}

async function safeEnd(closable: { end(): Promise<void> }): Promise<void> {
  try {
    await closable.end();
  } catch {
    /* ignore — we are already degrading */
  }
}
