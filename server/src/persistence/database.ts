// ---------------------------------------------------------------------------
// PostgreSQL connection wrapper (Layer 4 — Persistence).
//
// A thin wrapper over a `pg` connection Pool. Activated ONLY when the
// DATABASE_URL env var is present; with no env config the office runs entirely
// in-memory (the zero-config path is sacred — see CLAUDE.md / plan Principle 4).
//
// Lifecycle: lazy connect (the Pool connects on first query), health() for the
// readiness probe, and graceful end() on shutdown. At startup the schema in
// db/init.sql is applied idempotently when AUTO_MIGRATE is enabled (default
// true whenever DATABASE_URL is set).
//
// Framework-independent: imports no Colyseus / Express. The only side effect is
// the database connection it owns.
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the bootstrap schema (server/db/init.sql). */
export const INIT_SQL_PATH = resolve(__dirname, "../../db/init.sql");

export interface DatabaseConfig {
  /** Postgres connection string, e.g. postgres://user:pass@host:5432/pixeloffice */
  connectionString: string;
  /** Run db/init.sql at startup. Defaults to true when a connection string is set. */
  autoMigrate?: boolean;
}

/**
 * Owns a single pg Pool. Construct via `Database.fromEnv()` (returns null when
 * DATABASE_URL is absent) so callers can fall back to in-memory storage.
 */
export class Database {
  private readonly pool: Pool;
  private readonly autoMigrate: boolean;
  private migrated = false;

  constructor(config: DatabaseConfig) {
    this.pool = new Pool({ connectionString: config.connectionString });
    this.autoMigrate = config.autoMigrate ?? true;
    // A pool-level error handler prevents an idle client error from crashing
    // the process (plan: recover from service restarts / graceful degradation).
    this.pool.on("error", (err) => {
      console.error("[PixelOffice][db] idle client error:", err.message);
    });
  }

  /**
   * Build from env. Returns null when DATABASE_URL is unset so the integrator
   * can choose the in-memory path. AUTO_MIGRATE=false disables schema bootstrap.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Database | null {
    const connectionString = env.DATABASE_URL?.trim();
    if (!connectionString) return null;
    const autoMigrate = env.AUTO_MIGRATE ? env.AUTO_MIGRATE !== "false" : true;
    return new Database({ connectionString, autoMigrate });
  }

  /** Run a parameterised query. */
  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<QueryResult<R>> {
    return this.pool.query<R>(text, params as unknown[]);
  }

  /** Check out a client for a transaction; caller MUST release it. */
  async connect(): Promise<PoolClient> {
    return this.pool.connect();
  }

  /**
   * Verify connectivity. Resolves true on a successful round-trip, false on any
   * failure (never throws) so callers can degrade to in-memory cleanly.
   */
  async health(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch (err) {
      console.error(
        "[PixelOffice][db] health check failed:",
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  }

  /**
   * Apply db/init.sql idempotently (the SQL uses IF NOT EXISTS). Runs at most
   * once per process and only when autoMigrate is enabled. Throws on SQL error
   * so the factory can decide whether to fall back.
   */
  async migrate(): Promise<void> {
    if (!this.autoMigrate || this.migrated) return;
    const sql = await readFile(INIT_SQL_PATH, "utf8");
    await this.pool.query(sql);
    this.migrated = true;
  }

  /** Close all connections. Safe to call once at shutdown. */
  async end(): Promise<void> {
    await this.pool.end();
  }
}
