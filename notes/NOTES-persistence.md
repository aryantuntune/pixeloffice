# NOTES — Persistence Builder (Layer 4: PostgreSQL + Redis)

Wiring instructions for the INTEGRATOR. All persistence code is OPT-IN via env
vars. With no env config nothing changes: in-memory user repo + in-memory
presence store, exactly as today. The zero-config `npm install && npm run dev`
path stays sacred.

## 1. Dependencies to install (root or `-w server`)

```
npm install -w server pg@^8 ioredis@^5
npm install -w server -D @types/pg
```

(`ioredis` ships its own types — no @types needed.)

## 2. Files I added (all new, none of yours edited)

- `server/src/persistence/database.ts` — `Database` (pg Pool wrapper): `fromEnv()`,
  `query`, `connect`, `health()`, `migrate()` (runs `db/init.sql` idempotently),
  `end()`.
- `server/src/persistence/redis.ts` — `RedisStore` (ioredis wrapper): `fromEnv()`,
  `.client`, `health()`, `end()`. lazyConnect so a dead Redis never throws at boot.
- `server/src/persistence/presence-store.ts` — `PresenceStore` interface +
  `InMemoryPresenceStore` (default) + `RedisPresenceStore`.
- `server/src/persistence/factories.ts` — `createUserRepository(env)` and
  `createPresenceStore(env)`: selection + graceful fallback. **Use these.**
- `server/src/repositories/postgres-user.repository.ts` — `PostgresUserRepository`
  (implements the EXISTING `UserRepository` interface; upsert by id).
- `server/db/init.sql` — schema bootstrap (`users` table + indexes).
- `docker-compose.yml` (root) — postgres:16-alpine + redis:7-alpine (+ optional
  `app` service under profile `app`).
- Tests: `server/src/repositories/user-repository.contract.test.ts`,
  `server/src/persistence/presence-store.contract.test.ts` (in-memory always run;
  pg/redis suites guarded by `TEST_DATABASE_URL` / `TEST_REDIS_URL` and only
  import the driver modules when those are set — CI passes without pg/ioredis).

## 3. container.ts changes (the whole point — keep it tiny)

The factories are async and do a health check, so make container construction
async. Replace the two synchronous lines:

```ts
const users: UserRepository = new InMemoryUserRepository();
// (no presence store today)
```

with a one-time async init. Recommended minimal edit — add at top:

```ts
import { createUserRepository, createPresenceStore } from "./persistence/factories";
import type { PresenceStore } from "./persistence/presence-store";
import type { Database } from "./persistence/database";
import type { RedisStore } from "./persistence/redis";
```

Then build users + presence store via the factories. Two integration shapes —
pick one:

### Option A (preferred): async `initContainer()` awaited in index.ts

Convert the module-level singletons into an `initContainer()` that index.ts
awaits before `httpServer.listen`. Inside it:

```ts
const userResult = await createUserRepository(process.env);
const presenceStoreResult = await createPresenceStore(process.env);
const users: UserRepository = userResult.repository;
const presenceStore: PresenceStore = presenceStoreResult.store;
```

Expose on the container: `users`, `presenceStore`, and (for /health + shutdown)
`userResult.database` and `presenceStoreResult.redis`.

### Option B (no async refactor): keep in-memory default, swap lazily

If you want to avoid making the container async, leave the current
`InMemoryUserRepository` as the default and only call the factories when the env
vars are present, awaiting inside `OfficeRoom.onCreate` (already async) before
first use. Option A is cleaner; prefer it.

`auth`, `calendar`, `events`, `presence` are unchanged.

## 4. index.ts changes (only if Option A)

- `await initContainer()` before `httpServer.listen(...)`.
- Graceful shutdown: on SIGINT/SIGTERM call
  `await container.userResult.database?.end()` and
  `await container.presenceStoreResult.redis?.end()`.

## 5. Presence-store recording hook (1 line in room wiring)

In `server/src/rooms/office.room.ts`, inside `wireServiceListeners()`, the
existing `presence.on("change", ...)` handler already has `sessionId, state,
source` and looks up `const snap = this.players.get(sessionId)`. Add one line
inside that handler (the snapshot carries `userId`):

```ts
presence.on("change", ({ sessionId, state, source }) => {
  const snap = this.players.get(sessionId);
  if (snap) {
    snap.presence = state;
    snap.source = source;
    // NEW: best-effort persist latest presence (no-op for in-memory store).
    void container.presenceStore.record(snap.userId, state, source, Date.now());
  }
  // ...existing broadcast unchanged...
});
```

`record` is fire-and-forget (`void`); RedisPresenceStore swallows its own errors
so a Redis blip never affects the live broadcast. Note: this requires
`container.presenceStore` to exist (step 3). If you defer container changes, skip
this line — the feature degrades to "not persisted", office still works.

## 6. Env vars (add to .env.example)

```
# --- Optional persistence (Layer 4). Unset = in-memory, zero-config. ---
# DATABASE_URL=postgres://pixeloffice:pixeloffice@localhost:5432/pixeloffice
# REDIS_URL=redis://localhost:6379
# AUTO_MIGRATE=true   # default true when DATABASE_URL set; set false to skip db/init.sql
```

## 7. Selection + failure semantics (already implemented in factories.ts)

- DATABASE_URL set + reachable -> Postgres (migrated). Down/migration-fails ->
  WARN + in-memory. Unset -> in-memory.
- REDIS_URL set + reachable -> Redis. Down -> WARN + in-memory. Unset -> in-memory.
- Configured-but-down NEVER crashes boot (plan Principle 4: office keeps working).

## 8. /api/health (optional enhancement, infra/integrator)

If you expose datastore health, call `container.userResult.database?.health()`
and `container.presenceStoreResult.redis?.health()` (both return bool, never
throw). Null = in-memory backend (report "memory", healthy).

## 9. docker-compose

`docker compose up` -> postgres + redis only (app under profile `app`, needs the
Dockerfile from the infra builder: `docker compose --profile app up --build`).
`server/db/init.sql` is mounted into the postgres init dir AND run by the app on
boot — both idempotent.

## 10. No-surveillance compliance

PresenceStore persists ONLY {state, source, atMs}. No keystroke/mouse/screenshot/
productivity data; no browsable per-user history API (no history methods exist).
Redis latest-hash has a 24h TTL; the debug `office:presence-log` is a capped ring
(1000 entries) and is not exposed via any API. `init.sql` has no activity tables.

## 11. Tests

`npm test` (vitest) runs the in-memory contract suites with NO pg/ioredis
installed and NO DB/Redis running. The live-DB / live-Redis suites are
self-skipping unless `TEST_DATABASE_URL` / `TEST_REDIS_URL` are set; when set
they reuse the exact same shared assertions (`runUserRepositoryContract`,
`runPresenceStoreContract`).
