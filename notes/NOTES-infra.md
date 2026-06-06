# NOTES — Infra / Hardening Builder

Files I added (all additive; zero-config `npm install && npm run dev` is unaffected
because every new behavior is opt-in via env or only wired by the integrator):

- `Dockerfile` (root, multi-stage)
- `.dockerignore`
- `.github/workflows/ci.yml`
- `server/src/lifecycle/shutdown.ts` (+ `shutdown.test.ts`)
- `server/src/http/rate-limit.ts` (+ `rate-limit.test.ts`)
- `server/src/http/static-client.ts`
- `client/src/net/connection.ts` (rewritten, BACKWARD COMPATIBLE — same exports + methods)
- `client/src/ui/connection-banner.ts` (new)

No new runtime dependencies are required for any of the above (rate limiter and
shutdown are dependency-free; static-client uses the already-present `express`).

---

## 1. server/src/index.ts wiring (INTEGRATOR — index.ts is yours)

Add imports:

```ts
import { createRateLimiter } from "./http/rate-limit";
import { mountStaticClient, shouldServeClient } from "./http/static-client";
import { installShutdown } from "./lifecycle/shutdown";
import { container } from "./container";
```

Mount the rate limiter on `/api` BEFORE the admin router (health is auto-skipped):

```ts
app.use(cors());
app.use(express.json());
app.use("/api", createRateLimiter());          // 60 req/min/IP; GET /api/health is a no-op
app.use("/api", createAdminRouter());
```

Mount the static client LAST (after `/api`), only when SERVE_CLIENT is on. Do this
AFTER the admin router so API routes always win, and ideally just before/after the
http server is created (it operates on `app`):

```ts
if (shouldServeClient()) {
  mountStaticClient(app); // serves client/dist with SPA index.html fallback
}
```

(If `SERVE_CLIENT=true` but no build exists, it logs a warning and serves API only —
the office still boots.)

Install graceful shutdown AFTER `httpServer.listen(...)`:

```ts
installShutdown({
  gameServer,
  httpServer,
  getRoom: () => container.registry.room,   // broadcasts the "Office restarting…" toast
  // closables: [pgPool, redisClient],       // optional — only if persistence agent wired pools
});
```

`installShutdown` listens for SIGINT/SIGTERM, broadcasts a TOAST, calls
`gameServer.gracefullyShutdown(false)`, closes the http server, ends any closables,
and hard-exits after 8s if anything hangs. The Colyseus `Server` already has
`gracefullyShutdown` — no extra import needed.

NOTE on Express ordering: `express.static` + the SPA fallback are registered on `app`
via `mountStaticClient`. Because Express matches in registration order, mounting it
after `createAdminRouter` is required so `/api/*` is never swallowed by the fallback.

---

## 2. client/src/main.ts reconnect recipe (INTEGRATOR — main.ts is yours)

The `Connection` class is backward compatible. Key additions:

- `new Connection()` still works; optional `new Connection({ baseDelayMs, maxDelayMs, ... })`.
- `conn.connect(opts)` unchanged; optional 2nd arg `connect(opts, authToken)` re-sends
  the token on every reconnect (use once OAuth/JWT lands).
- `conn.on(...)` handlers are now RETAINED and auto re-attached to the fresh room after
  a reconnect — DO NOT re-register them on reconnect.
- New: `conn.onState((state) => ...)` where state ∈ `connecting | online | reconnecting | offline`.
- New: `conn.connectionState` getter, `conn.close()` (stops reconnect).
- `send()` now silently no-ops while disconnected (no throw mid-reconnect).

### Mount the connection banner

```ts
import { mountConnectionBanner } from "./ui/connection-banner";

const banner = mountConnectionBanner(hudRoot); // or any always-mounted root
// after creating conn:
conn.onState(banner.setState);
```

CSS classes the banner uses (add to styles.css — client-ui-builder owns styles.css):
`.conn-banner`, `.conn-banner--hidden`, `.conn-banner--reconnecting`,
`.conn-banner--online`, `.conn-banner--offline`, and children `.conn-banner__dot`,
`.conn-banner__label`. Suggested: fixed top-center strip; amber pulse for reconnecting,
green for "Back online" (auto-hides after ~2.5s), red for offline.

### IDEMPOTENT re-bootstrapping on a fresh WELCOME (IMPORTANT)

After a successful re-join the server sends a NEW `WELCOME` with a NEW sessionId. The
current `main.ts` guards `boot()` behind a `booted` flag and only registers most S2C
handlers inside `boot()`. With auto-reconnect, handlers are re-attached automatically by
`Connection`, BUT the WELCOME handler must now re-seed state instead of being ignored.

Recommended change to `start()` / `boot()`:

1. Register the WELCOME handler WITHOUT the one-shot `booted` guard. On EVERY welcome:
   - If not yet booted: do the full `boot(...)` (create game + HUD) as today.
   - If already booted (this is a reconnect welcome): RE-SEED idempotently —
     ```ts
     // reset roster + scene to the server's authoritative truth
     for (const id of store.allPlayerIds()) {        // or iterate store.get().players
       if (id !== oldSelfId) game.removePlayer(id);
     }
     store.reset?.();                                 // or clear players/events in the store
     // re-seed from the fresh welcome
     store.setSelfId(welcome.self.sessionId);         // sessionId changed!
     store.upsertPlayer(welcome.self);
     for (const p of welcome.players) { store.upsertPlayer(p); game.addPlayer(p); }
     for (const ev of welcome.events) store.upsertEvent(ev);
     if (welcome.meeting) store.setMeeting(welcome.meeting); else store.clearMeeting?.();
     ```
   The game handle already supports `removePlayer(sessionId)` (per the OfficeGameHandle
   contract), so clearing stale remote avatars is just a loop of `game.removePlayer(id)`
   for every non-self id before re-adding from the new welcome. The local avatar is owned
   by the game; on reconnect the simplest robust approach is `game.teleportPlayer(newSelfId, welcome.self.x, welcome.self.y)` is NOT valid (different sessionId) — instead, since
   the game created the local avatar at boot keyed to the original self, treat the local
   avatar as persistent and only resync remote players. If you need the local avatar to
   re-key to the new sessionId, the cleanest path is to fully tear down and rebuild the
   game (`game.destroy()` then `createOfficeGame(...)` again) on reconnect — acceptable
   because reconnects are rare. Pick ONE:
     - Lightweight: keep the existing game instance, only resync remote players + store,
       and update `selfId` used by the message bridge (the `selfId === selfId` filters in
       the PLAYER_MOVED handler must use the CURRENT sessionId — capture it from a mutable
       `let selfId = conn.sessionId` you update on each welcome).
     - Robust: `game.destroy()` + recreate on reconnect welcome.

2. The `onLeave` handler currently calls `login.show()`. With auto-reconnect that is
   wrong for transient drops. Change to: do nothing on transient drops (let the banner
   show "Reconnecting…"); only show the login screen if `conn.connectionState === "offline"`
   (gave up / consented close). E.g.:
   ```ts
   conn.onLeave(() => { /* banner via onState handles UX; no login.show() here */ });
   conn.onState((s) => { banner.setState(s); if (s === "offline") login.show(); });
   ```

3. Capture `selfId` mutably and refresh it on each WELCOME so the
   `if (sessionId === selfId) return;` echo-suppression in PLAYER_MOVED stays correct
   after the sessionId changes.

Minimal correct version if you want the simplest reliable behavior: on a reconnect
welcome, `game.destroy()` then re-run `boot()` fully with the new welcome (and reset the
`booted`/store state first). Rare-path simplicity over micro-optimization.

---

## 3. README CI badge line

Add near the top of README.md (replace OWNER/REPO):

```md
[![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)
```

---

## 4. Docker build / run commands (for README "Ops" / Production Path section)

```bash
# Build the single-container image (server + built client)
docker build -t pixeloffice .

# Run it (serves client + API + ws on one port; static serving is on by default
# inside the image via SERVE_CLIENT=true)
docker run --rm -p 2567:2567 pixeloffice
# then open http://localhost:2567

# API-only (no static client) — override the env:
docker run --rm -p 2567:2567 -e SERVE_CLIENT=false pixeloffice

# Healthcheck endpoint used by the image + CI:
curl -fsS http://localhost:2567/api/health   # -> {"ok":true}
```

The Dockerfile sets `SERVE_CLIENT=true`, `PORT=2567`, `NODE_ENV=production`, runs as
the unprivileged `node` user, exposes 2567, and has a HEALTHCHECK hitting
`/api/health`. The server runs via `npm run start -w server` (tsx), matching the dev
start path — no separate tsc build step, and `@pixeloffice/shared` is consumed as TS
source as it is in dev.

---

## 5. Rate limiter tuning (optional env, not required)

Defaults: 60 requests / minute / IP, GET /api/health always allowed. To make it
configurable, the integrator can pass options:

```ts
app.use("/api", createRateLimiter({
  capacity: Number(process.env.API_RATE_LIMIT ?? 60),
  windowMs: Number(process.env.API_RATE_WINDOW_MS ?? 60_000),
}));
```

If behind a reverse proxy, also set `app.set("trust proxy", 1)` so `req.ip` is the real
client (the limiter already honors a single `X-Forwarded-For` hop as a fallback).

---

## 6. CI summary

`.github/workflows/ci.yml` (on push to any branch + PRs, under 60 lines, only
actions/checkout@v4 + actions/setup-node@v4):
`npm ci` → `npm test` → `npm run build -w client` → boot server in background
(`npm run start -w server &`) → readiness loop polling `/api/health` (30×1s) →
`npm run smoke`.

> CAVEAT for the integrator: other agents added `server/src/auth/**` and
> `server/src/persistence/**` that currently fail `tsc --noEmit` (missing `pg` types,
> jwt sign typing) and reference a `pg` dependency. My files typecheck clean and my
> tests pass. CI runs via tsx (no project-wide `tsc` gate) and `vitest run`, so those
> typing issues won't fail CI unless a step adds `tsc`. If you add a typecheck step,
> resolve those first or scope it. The server start path uses tsx, which executes
> regardless of tsc type errors.
