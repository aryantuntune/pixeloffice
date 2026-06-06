# NOTES-gatekeeper — final acceptance gate (measure, don't fix)

Owner: GATEKEEPER. No source edits were made (no one-line typos needed). This
file is a status summary + the exact run commands. The orchestrator reads the
StructuredOutput; this file is the human-readable record.

## Result: ALL GATES PASS

| # | Gate | Result |
|---|---|---|
| 1 | `npm test` | PASS — 124 passed, 2 skipped, 15 files |
| 2 | Zero-config boot + `/api/health` + `npm run smoke` | PASS — health `{"ok":true}`, all 9 smoke steps PASS, exit 0 |
| 3 | Dead-integrations boot (bogus DATABASE_URL/REDIS_URL/GREYTHR_*) | PASS — warns + falls back to in-memory; health OK; smoke PASS |
| 4 | AUTH_REQUIRED=true JWT_SECRET=gate ADMIN_EMAILS=admin@example.com | PASS — `/api/users` bare 401, admin token 200, member token 403 |
| 5 | HR mock check-in/out round trip | PASS — NOT_CHECKED_IN → CHECKED_IN → CHECKED_OUT; employee lookup 200 |
| 6 | `npm run build -w client` | PASS — vite build OK (1 benign chunk-size warning) |
| 7 | Parse docker-compose.yml + ci.yml | PASS — both valid YAML; `docker compose config` validates |
| 8 | Kill everything | DONE — 0 leftover procs, port 2567 down |

## Detail notes

- Zero-config smoke prints benign `colyseus.js: onMessage() not registered for
  type '...'` lines (the smoke client registers handlers lazily per step) — these
  are noise, not failures. Final line is `ALL SMOKE STEPS PASSED`, exit 0.
- Dead integrations log exactly the graceful-degradation warnings (plan
  Principle 4): `DATABASE_URL is set but Postgres is unreachable — falling back to
  in-memory`; same for Redis. Boot continues; smoke passes.
- AUTH gate: tokens minted with the real `JwtService` (secret `gate`, HS256,
  issuer `pixeloffice`). admin role → 200, member role → 403, no token → 401.
  RBAC keyed off `ADMIN_EMAILS`/token role as designed.
- HR dev path resolves identity from a live Colyseus sessionId (joined as
  "Ada Lovelace"); check-in/out/status all 200 with correct state transitions;
  `/api/hr/employee?email=ada.lovelace@pixeloffice.dev` returns the mock record.
- Fixer wiring (HR auth gate, rate-limit trustProxy) is present in
  `server/src/index.ts` (createHrRouter + createRateLimiter calls confirmed).
- docker-compose: `up` starts only postgres+redis; full stack is
  `docker compose --profile app up --build` (app service inherits SERVE_CLIENT=true
  from the Dockerfile ENV). compose `config` validates against the local docker.
- CI workflow: checkout@v4 + setup-node@v4 (node 22) → npm ci → npm test →
  build client → boot server bg → poll /api/health → npm run smoke. Valid.

## Known issues / observations (non-blocking)

- Client production bundle is 1.6 MB (gzip 376 KB) — single chunk, mostly Phaser.
  Vite emits a chunk-size warning only; build succeeds. Optional future polish:
  manualChunks/code-split Phaser. Not a gate failure.
- 2 skipped tests are the Postgres/Redis contract tests that self-skip without a
  live datastore (`user-repository.contract.test.ts`, `presence-store.contract.test.ts`).
  Expected in zero-config CI.
- Could not exercise the REAL Postgres/Redis/GreytHR adapters end-to-end (no live
  datastores/credentials in this env) — only the configured-but-dead fallback path,
  which is the plan's hard requirement and which passes.

## Exact run commands

### Zero-config dev (sacred path)
```bash
npm install
npm run dev            # server :2567, client :5173 — open http://localhost:5173
```

### Tests + smoke (server must be up for smoke)
```bash
npm test
npm run start -w server   # in one shell
npm run smoke             # in another
```

### Production client build
```bash
npm run build -w client
```

### Auth-gated run
```bash
AUTH_REQUIRED=true JWT_SECRET=gate ADMIN_EMAILS=admin@example.com npm run start -w server
# /api/users requires an admin-role JWT (Authorization: Bearer <token>)
```

### Full stack via Docker Compose
```bash
# datastores only (point the app at them via env):
docker compose up
DATABASE_URL=postgres://pixeloffice:pixeloffice@localhost:5432/pixeloffice \
REDIS_URL=redis://localhost:6379 npm run dev

# app + datastores in containers (server serves built client on :2567):
docker compose --profile app up --build
# open http://localhost:2567

# single container only:
docker build -t pixeloffice .
docker run --rm -p 2567:2567 pixeloffice
```
