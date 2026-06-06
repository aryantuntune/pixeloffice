# PixelOffice

[![CI](https://github.com/aryantuntune/pixeloffice/actions/workflows/ci.yml/badge.svg)](https://github.com/aryantuntune/pixeloffice/actions/workflows/ci.yml)

PixelOffice is a multiplayer virtual office inspired by Pokémon Emerald that helps
distributed teams feel present, connected, and aware of each other's availability
without becoming a surveillance tool. You open the office in your browser, spawn at
your department desk, walk around a pixel-art floor, and instantly see who is online,
who is available, who is in a meeting, and who is taking a coffee break. The true
product is **presence + meetings + social interaction + team awareness** — the map is
just the visualization layer. There is no keystroke logging, mouse tracking, screenshot
capture, or productivity scoring, ever.

![The office](docs/screenshots/office.png)

<p align="center">
  <img src="docs/screenshots/coffee-break.png" width="49%" alt="A coffee break in the Coffee Area" />
  <img src="docs/screenshots/meeting.png" width="49%" alt="A meeting starting — pulsing Join button, never auto-teleport" />
</p>

<p align="center">
  <img src="docs/screenshots/login.png" width="60%" alt="Login screen" />
</p>

**Docs:** [Player Guide](docs/GAMEPLAY.md) · [Architecture](docs/ARCHITECTURE.md) ·
[greytHR Sign-In](docs/greythr-login-integration.md) · [Lounge Games](docs/lounge-games.md) ·
[Module Contract](CONTRACT.md) · [Product Constitution](plan.md)

---

## Quickstart

```bash
npm install          # installs all workspaces (shared, server, client)
npm run dev          # server on :2567, client on :5173
```

Then open **http://localhost:5173**. Pick a name, department, and avatar, and click
**Enter Office**. (With **greytHR sign-in** enabled you instead enter your **Employee No +
password** — your name and department come from greytHR; see
[greytHR Sign-In](#greythr-sign-in-login--identity-optional).)

To see multiplayer presence, **open http://localhost:5173 in two or more browser
windows** (or share your LAN IP with a teammate). Each window is a separate avatar;
move one with the arrow keys / WASD and watch it move in real time in the others.

> Low file-watcher limit? If `npm run dev` fails with `ENOSPC: System limit for number
> of file watchers reached`, either raise the limit
> (`sudo sysctl fs.inotify.max_user_watches=524288`) or run without watchers:
> `npm run start -w server` (server) and `CHOKIDAR_USEPOLLING=true npm run dev -w client`
> (client). For a no-watch client you can also `npm run build -w client && npm run preview -w client`.

---

## Feature Tour

- **Presence states & sources.** Every avatar carries one of six states —
  `AVAILABLE`, `IN_MEETING`, `FOCUS`, `BREAK`, `AWAY`, `OFFLINE` — each with a
  transparent *source* so the team knows where it came from: `CALENDAR` (an active
  meeting), `MANUAL` (you picked it), `EVENT` (you joined a coffee break), `AUTO`
  (idle timeout), or `SYSTEM` (default). Presence is resolved by a pure engine on
  the server and pushed to clients; the UI only displays it.
- **Status selector.** The top-bar pill opens a dropdown: Available / Focus / Break /
  Away. Picking one sends a manual override; picking **Available** clears the override
  and lets automatic rules take over again.
- **Auto-away.** If your session sees no activity for the configured timeout
  (`AWAY_TIMEOUT_MS`, default 90s) you flip to `AWAY` (source `AUTO`). Any action —
  moving, chatting, changing status — counts as activity and brings you back.
- **Chat.** The bottom-left input sends a short message that pops as a speech bubble
  over your avatar for everyone nearby and as a toast.
- **Coffee breaks & social events (via Admin).** An admin creates a Coffee Break, Tea
  Break, Team Gathering, or Town Hall. Everyone gets a toast and an entry in the
  "Happening now" panel with a **Join** button. Joining walks your avatar to the event
  area (Coffee Area / Lounge / Reception) and sets you to `BREAK`.
- **Meetings + the Join button (human-agency rule).** When a scheduled meeting starts,
  invited users get a toast and a persistent **Join Meeting** button. Your avatar is
  **never** teleported automatically — only clicking Join seats you in the assigned
  meeting room. Room size is chosen by invitee count (≤4 → Room A, ≤8 → Room B,
  else Room C).
- **Admin console.** The ⚙ Admin button opens a modal (plain REST calls) with tabs to
  create events, schedule meetings, send broadcasts, and view the live roster of
  connected users with their presence and current area.
- **greytHR sign-in (optional).** When enabled, greytHR is the office login: you enter
  only your **Employee No + password** (the company subdomain is autofilled) and your real
  **name + department** are pulled from greytHR. greytHR acts as an external IdP — the
  server forwards the credential to the self-hosted greytHR ESS client and mints the
  office JWT; PixelOffice never stores the password. See
  [docs/greythr-login-integration.md](docs/greythr-login-integration.md).
- **Profile editing.** Double-click **your own avatar** to open a profile modal and change
  your display name, **department** (a dropdown to fix a greytHR mismatch), and avatar
  color. Changes broadcast to everyone live, persist to your user record, and survive
  reconnects. (Never teleports your avatar — human-agency rule.)
- **Lounge games.** Three two-player mini-games in the Lounge — **Ping-Pong**,
  **Tic-Tac-Toe**, **Connect Four**. Walk up to a station and press **E** to play.
  Server-authoritative; opt-in and explicit; never affects presence or HR. See
  [docs/lounge-games.md](docs/lounge-games.md).

---

## Architecture Overview

PixelOffice follows the layered constitution in `plan.md`. Business logic lives only in
framework-free services; Phaser and the DOM HUD are pure rendering/presentation layers.

| Layer (plan.md) | Responsibility | Where it lives |
|---|---|---|
| **World layer** | Rendering, avatars, grid movement, animations | `client/src/game/` (Phaser 3) |
| **Presence layer** | Availability/meeting/social state, presence calculation | `server/src/presence/` (pure engine + service) |
| **Integration layer** | Calendar (adapter pattern, independently removable) | `server/src/integrations/calendar/` |
| **Persistence layer** | User/session storage (in-memory for the MVP) | `server/src/repositories/` |
| **Transport / protocol** | Wire messages, office map, domain types (source of truth) | `shared/src/` |
| **Realtime room** | The only Colyseus-aware module: protocol handling, ticks | `server/src/rooms/office.room.ts` |
| **Admin REST** | `/api/health`, `/users`, `/events`, `/broadcast`, `/meetings` | `server/src/http/admin.routes.ts` |
| **Client shell / HUD** | Login, roster, status, events, chat, toasts, admin | `client/src/ui/`, `client/src/main.ts` |
| **Net wrapper** | Thin colyseus.js transport (no business logic) | `client/src/net/connection.ts` |

Key boundaries that are enforced:

- `shared/` is the single source of truth for the wire protocol (`protocol.ts`), the
  office map and collision (`map.ts`), and domain types (`types.ts`). Both sides import
  from `@pixeloffice/shared`; nothing is duplicated.
- The Phaser game contains **no** presence/meeting/network logic — it renders what the
  UI bridge (`client/src/main.ts`) tells it through the `OfficeGameHandle` contract.
- The server room is the only place that reads the clock; all services receive `now`
  injected from its tick, and dependencies are wired by hand in `server/src/container.ts`.
- Coordinates on the wire are **tile** coordinates (integers); the client converts to
  pixels for rendering.
- Presence is resolved server-side by a **pure** function (`presence-engine.ts`) with the
  priority order: meeting > manual focus > active event > manual break > manual away >
  auto-away > available.

---

## Tests & Smoke

```bash
npm test             # vitest: presence-engine state-transition tests (server)
```

```bash
# End-to-end protocol smoke test (needs a running server):
npm run dev          # in one terminal (or: npm run start -w server)
npm run smoke        # in another — joins the room and exercises the wire protocol
```

The smoke test joins two clients and asserts the full happy path: `WELCOME` with a
walkable spawn → move echo → second player join/move propagation → set-status →
presence change → create event via REST → `EVENT_CREATED` received → join event →
teleport to a Coffee Area anchor + `BREAK`/`EVENT` presence → schedule meeting via REST
→ `MEETING_STARTED`. It prints PASS/FAIL per step and exits non-zero on any failure.

To build the client for production:

```bash
npm run build -w client
```

---

## Configuration

**Every environment variable is optional.** With none set, `npm install && npm run dev`
runs the full experience — dev login, in-memory storage, mock calendar, mock GreytHR,
open admin console, ephemeral JWT. Each variable below is opt-in; a configured-but-dead
integration (Postgres/Redis/GreytHR) logs a warning and falls back so the office keeps
working (plan Principle 4: integrations are optional). Copy `.env.example` to `.env`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `2567` | Server port (REST + Colyseus ws). |
| `AWAY_TIMEOUT_MS` | `90000` | Idle ms before a session auto-flips to `AWAY` (source `AUTO`); any C2S message clears it. |
| `LOG_LEVEL` | `info` | Server log verbosity: `debug` / `info` / `warn` / `error`. |
| `JWT_SECRET` | ephemeral | App JWT signing secret. Unset → random per-process secret (tokens reset on restart) + boot warning. Set in production. |
| `JWT_EXPIRES_IN` | `12h` | Token lifetime (jsonwebtoken format). |
| `AUTH_REQUIRED` | `false` | When `true`, a valid JWT is required to join the room **and** an admin JWT is required for admin REST writes. |
| `ADMIN_EMAILS` | _(empty)_ | Comma-separated emails granted the `admin` role (RBAC). |
| `CLIENT_APP_URL` | `http://localhost:5173` | Where the browser is redirected after an OAuth callback. |
| `DEFAULT_DEPARTMENT` | `Engineering` | Department for OAuth users who don't pick one. |
| `OAUTH_REDIRECT_BASE` | _(unset)_ | Public base URL of this server; OAuth redirect URIs derive from it. Required to enable OAuth. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | _(unset)_ | Enable Google OAuth (both + redirect base required). |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | _(unset)_ | Enable Microsoft OAuth (both + redirect base required). |
| `MS_TENANT` | `common` | Azure AD tenant id, or `common` / `organizations` / `consumers`. |
| `GREYTHR_BASE_URL` | _(unset)_ | Company-domain base, e.g. `https://kalvium.greythr.com`. Required to enable the real adapter. |
| `GREYTHR_API_USER` / `GREYTHR_API_KEY` | _(unset)_ | API user + key (preferred); the adapter acquires & auto-refreshes an OAuth2 token. |
| `GREYTHR_API_TOKEN` | _(unset)_ | Legacy pre-acquired bearer token (used if no user/key); no auto-refresh. |
| `GREYTHR_PORTAL_URL` | kalvium ESS home (when configured) | ESS deep link shown as "Open greytHR" in the widget; absent → link hidden. |
| `GREYTHR_TIMEOUT_MS` | `5000` | Per-request GreytHR timeout. |
| `DATABASE_URL` | _(unset)_ | Postgres user storage. Down → warn + in-memory fallback. |
| `AUTO_MIGRATE` | `true` (when DB set) | Run `server/db/init.sql` on boot (idempotent). |
| `REDIS_URL` | _(unset)_ | Redis presence storage. Down → warn + in-memory fallback. |
| `SERVE_CLIENT` | `false` | Serve `client/dist` from Express on the API port (single-container deploy; the Docker image sets `true`). |
| `API_RATE_LIMIT` / `API_RATE_WINDOW_MS` | `60` / `60000` | Token-bucket rate limit on `/api` per client IP (`GET /api/health` never throttled). |

### OAuth setup (Google / Microsoft)

OAuth replaces the dev login card with "Sign in with Google/Microsoft" buttons. The plan
forbids username/password auth; OAuth providers implement the same `AuthProvider` interface.

1. Set `OAUTH_REDIRECT_BASE` to this server's public URL (e.g. `https://office.company.com`).
2. In the provider console, register the redirect URI:
   - Google: `${OAUTH_REDIRECT_BASE}/api/auth/google/callback`
   - Microsoft: `${OAUTH_REDIRECT_BASE}/api/auth/microsoft/callback`
3. Set the client id/secret env vars (`GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`, and/or
   `MS_CLIENT_ID` + `MS_CLIENT_SECRET`).
4. Set `ADMIN_EMAILS` to the emails that should get the admin console, and
   `CLIENT_APP_URL` to where the client app is served.
5. (Optional) Set `AUTH_REQUIRED=true` to require a token to enter the office and lock the
   admin REST API behind the admin role. Set `JWT_SECRET` so tokens survive restarts.

Flow: client → `GET /api/auth/:provider/login` (302 to the IdP) → IdP →
`GET /api/auth/:provider/callback` (code → identity → upsert user → mint our JWT) → 302 to
`${CLIENT_APP_URL}/#token=...` → the client stores the token and joins the room with it.
With **no** providers configured the login/callback routes 404 and the dev card is shown —
the office runs exactly as the MVP.

### greytHR Sign-In (login + identity, optional)

Makes **greytHR the office login** (distinct from the attendance integration below, which
uses greytHR's official admin API). greytHR is treated as an external identity provider:
the user signs in with their greytHR **Employee No + password**, and PixelOffice pulls
their real **name + department** from the self-hosted greytHR ESS client (the headless
service that performs the real Ory-Hydra OAuth2/OIDC + RSA-OAEP login). OFF by default —
the zero-config dev login card is shown unless enabled.

```bash
GREYTHR_LOGIN_ENABLED=true              # enables "Sign in with greytHR"
GREYTHR_CLIENT_URL=http://localhost:3000 # base URL of the greytHR ESS client service
GREYTHR_SUBDOMAIN=kalvium               # autofilled in the form + forwarded
# GREYTHR_LOGIN_TIMEOUT_MS=8000         # per-request timeout (login is slow)
```

Flow: client `POST /api/auth/greythr/login` `{ loginId, password }` → server forwards the
credential **once, server-to-server** to `{GREYTHR_CLIENT_URL}/api/auth/login` → maps the
greytHR department onto an office department → upserts the user (`greythr:<employeeNo>`) →
mints **our** JWT → returns `{ token, profile }`; the client joins the room with the token
via the existing `JwtAuthProvider` path. **PixelOffice never stores the password** (only
the minted JWT). After joining, double-click your avatar to fix a department mismatch.

- **Login is seamless:** only Employee No + password (subdomain autofilled); no display-name
  field, no department picker, and no guest “Enter Office” button.
- **Security note:** the greytHR ESS client reuses a cached session for `subdomain:loginId`
  before re-validating the password, so a cached employee can be “logged in” with any
  password. This is an auth-bypass risk for multi-user login — the fix belongs in the
  greytHR repo. Details in [docs/greythr-login-integration.md](docs/greythr-login-integration.md).

> `.env` is loaded automatically at boot (no `dotenv` dependency — the server uses Node's
> built-in env-file loader and never overrides real environment variables).

### GreytHR (attendance, optional) — kalvium.greythr.com walkthrough

The HUD shows an Attendance widget with explicit **Check in** / **Check out** buttons (it
self-hides when HR is absent). Per the plan's GreytHR rules, **attendance is always an
explicit user click** — there is no auto-check-in/out/logout and no activity tracking. With
**no** GreytHR credentials the in-memory **mock adapter keeps working** and the office runs
exactly as the MVP; a dead/misconfigured GreytHR config degrades gracefully (the office is
unaffected).

The adapter targets greytHR's official API platform
([api-docs.greythr.com](https://api-docs.greythr.com/),
[readthedocs](https://greythr-api-docs.readthedocs.io/en/latest/authentication.html)):
it `POST`s `{base}/uas/v1/oauth2/client-token` to obtain an OAuth2 access token (cached and
refreshed before expiry, with a one-shot refresh-and-retry on a `401`), then calls the
employee-lookup and attendance-swipe endpoints with the `Access-Token` and `x-greythr-domain`
headers.

**1. An admin creates an API user + key in greytHR.** In the live instance
(`https://kalvium.greythr.com`), a greytHR **admin** opens **Settings (gear icon) → My
Account → API Details**, adds an API user, and generates its key/credentials (the key is
shown only once — copy it immediately). This produces the **API user** (client id) and **API
key** (client secret) used below, scoped to the `kalvium.greythr.com` domain.

**2. Set the env lines** (in `.env`):

```bash
GREYTHR_BASE_URL=https://kalvium.greythr.com
GREYTHR_API_USER=Apiuser           # the API user created above
GREYTHR_API_KEY=your-api-key       # the API key (client secret) — shown once
# Optional: ESS deep link for the widget (defaults to this when configured):
GREYTHR_PORTAL_URL=https://kalvium.greythr.com/v3/portal/ess/home
# Optional legacy alternative to USER+KEY (no auto-refresh):
# GREYTHR_API_TOKEN=your-pre-acquired-bearer-token
```

The `x-greythr-domain` header defaults to the host of `GREYTHR_BASE_URL`
(`kalvium.greythr.com`). When configured, the widget shows an **"Open greytHR ↗"** link to the
ESS portal home; when not configured the link is hidden and the mock adapter is used.

> Note: exact greytHR request-body and swipe-envelope field names can vary by tenant/version.
> Those tenant-specific shapes are isolated as clearly tagged constants/builders in
> `server/src/integrations/hr/greythr.adapter.ts` (marked `VERIFY-WITH-DOCS`) so adjusting
> them never touches business logic.

### Postgres + Redis (optional persistence, via Docker Compose)

```bash
docker compose up               # starts ONLY postgres + redis (datastores)
DATABASE_URL=postgres://pixeloffice:pixeloffice@localhost:5432/pixeloffice \
REDIS_URL=redis://localhost:6379 \
npm run dev                      # the office now persists users + latest presence
```

Postgres stores users; Redis stores the **latest** presence per user (state + source +
timestamp only — no surveillance data, no browsable history). With these unset the office
uses in-memory storage; set-but-unreachable falls back to in-memory with a warning.

### Docker image (single container: server + built client)

```bash
docker build -t pixeloffice .
docker run --rm -p 2567:2567 pixeloffice     # open http://localhost:2567
docker run --rm -p 2567:2567 -e SERVE_CLIENT=false pixeloffice   # API only
```

The image builds the client, serves it from Express (`SERVE_CLIENT=true`), runs as the
unprivileged `node` user, exposes `2567`, and has a `HEALTHCHECK` on `/api/health`. To run
the full stack (app + datastores): `docker compose --profile app up --build`.

### Continuous Integration

`.github/workflows/ci.yml` runs on every push and PR: `npm ci` → `npm test` →
`npm run build -w client` → boot the server in the background → poll `/api/health` until
ready → `npm run smoke`. It uses only `actions/checkout` and `actions/setup-node`.

---

## MVP Scope & Production Path

This is an honest MVP. The architecture was deliberately shaped so each stub swaps for a
real implementation behind an existing interface — no rewrites:

- **Auth.** Dev login is an OAuth stand-in behind the `AuthProvider` interface
  (`server/src/auth/`). The plan forbids custom username/password auth. Production drops
  in **Google / Microsoft OAuth** implementations of the same interface; the login card
  becomes the OAuth button.
- **Persistence.** Users/sessions live in `InMemoryUserRepository` behind the
  `UserRepository` interface. Production swaps in **PostgreSQL** (users, events) and
  **Redis** (presence, sessions) implementations — the room and services don't change.
- **Calendar.** A `MockCalendarAdapter` implements the `CalendarAdapter` interface
  (`getCurrentMeeting`, `getUpcomingMeetings`). Production adds a **Google Calendar
  adapter** (then Microsoft 365); the office keeps working if the integration fails
  (integrations are optional by design).
- **Backend framework.** Express + a hand-rolled DI container can be **ported to NestJS**
  (the plan's target) by moving the same services into Nest modules/providers; the
  Colyseus room and pure engine are framework-independent and carry over unchanged.
- **Security.** Add **JWT** sessions and **role-based access control** in front of the
  admin REST API (currently an unauthenticated dev console), and serve over **HTTPS**.
- **Ops.** Add **Docker / Docker Compose** (server, client, Postgres, Redis) and a
  **GitHub Actions** CI pipeline running `npm test`, the smoke test against a booted
  server, and `npm run build -w client`.
- **Integrations not yet built.** A **GreytHR adapter** (employee lookup, department
  sync, *explicit* attendance actions only — never auto check-in/out) follows the same
  adapter pattern.

The non-negotiables hold in this MVP and must continue to: presence not surveillance,
human agency (Join is always an explicit click), optional integrations, and business
logic that never leaks into Phaser scenes or UI components.
