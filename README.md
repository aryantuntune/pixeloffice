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
[greytHR Sign-In](docs/greythr-login-integration.md) · [Google Workspace Integration](docs/google-workspace-integration.md) ·
[Lounge Games](docs/lounge-games.md) · [Module Contract](CONTRACT.md) · [Product Constitution](plan.md)

---

## Quickstart

```bash
npm install          # installs all workspaces (shared, server, client)
npm run dev          # server on :2567, client on :5173
```

Then open **http://localhost:5173**. Pick a name, department, and avatar, and click
**Enter Office**. (With **greytHR sign-in** enabled you instead enter your **Employee No +
password** — your name and department come from greytHR; see
[greytHR ESS Setup](#greythr-ess-setup-login--attendance-optional).)

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
  meeting/calendar event), `MANUAL` (you picked it), `EVENT` (you joined a coffee break), `AUTO`
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
  meeting room. When Google Calendar is connected, it also pulls the video Meet link,
  letting you open Google Meet in a new tab via the **Join Meeting** button. Room size is
  chosen by invitee count (≤4 → Room A, ≤8 → Room B, else Room C).
- **Google Calendar integration.** Connect your Google Calendar directly from the HUD.
  Real meetings automatically drive your status to `IN_MEETING` (source `CALENDAR`) and
  surface a "Join" link. Supports an optional title-privacy mode.
- **Admin console.** The ⚙ Admin button opens a modal (plain REST calls) with tabs to
  create events, schedule meetings, send broadcasts, and view the live roster of
  connected users with their presence and current area.
- **greytHR sign-in & attendance (optional).** When enabled, greytHR is the office login: you sign
  in with your **Employee No + password** (subdomain is prefilled and hidden). Your real
  **name + department** are pulled from greytHR via the self-hosted greytHR ESS client. The
  HUD renders a self-view attendance widget showing your check-in state, shift details, and
  worked hours, with Check-in / Check-out actions backed by real swipes. See
  [docs/greythr-login-integration.md](docs/greythr-login-integration.md).
- **Profile editing.** Double-click **your own avatar** to open a profile modal and change
  your display name, **department** (a dropdown to fix a greytHR mismatch), and avatar
  color. Changes broadcast to everyone live, persist to your user record, and survive
  reconnects. (Never teleports your avatar — human-agency rule.)
- **Ambient NPCs.** Up to 16 server-driven NPCs wander the office, sit at vacant desks,
  take coffee breaks, and chat, keeping the virtual office lively even when empty.
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
| `NPC_COUNT` | `8` | Number of ambient office NPCs to spawn (0 to disable, max 16). |
| `NPC_SEED` | `42` | PRNG seed for deterministic NPC movement. |
| `JWT_SECRET` | ephemeral | App JWT signing secret. Unset → random per-process secret (tokens reset on restart) + boot warning. Set in production. |
| `JWT_EXPIRES_IN` | `12h` | Token lifetime (jsonwebtoken format). |
| `AUTH_REQUIRED` | `false` | When `true`, a valid JWT is required to join the room **and** an admin JWT is required for admin REST writes. (Forced to `true` when greytHR login is enabled). |
| `ADMIN_EMAILS` | _(empty)_ | Comma-separated emails granted the `admin` role (RBAC). |
| `CLIENT_APP_URL` | `http://localhost:5173` | Where the browser is redirected after an OAuth callback. |
| `DEFAULT_DEPARTMENT` | `Engineering` | Department for OAuth users who don't pick one. |
| `ALLOWED_EMAIL_DOMAINS` | _(empty)_ | Comma-separated email domains allowed to sign in via OAuth (e.g. `kalvium.com`). Empty = no restriction. |
| `OAUTH_REDIRECT_BASE` | _(unset)_ | Public base URL of this server; OAuth redirect URIs derive from it. Required to enable OAuth. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | _(unset)_ | Enable Google OAuth and Google Calendar integration. |
| `GOOGLE_CAL_TITLES` | `true` | When `false`, hides meeting titles (privacy/busy-free mode). |
| `GOOGLE_CAL_POLL_MS` | `45000` | Poll interval for Google Calendar sync. |
| `GOOGLE_AUTH_BASE` / `GOOGLE_TOKEN_BASE` / `GOOGLE_API_BASE` | _(defaults to Google APIs)_ | Custom endpoints to stub Google Calendar for offline tests. |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | _(unset)_ | Enable Microsoft OAuth (both + redirect base required). |
| `MS_TENANT` | `common` | Azure AD tenant id, or `common` / `organizations` / `consumers`. |
| `GREYTHR_LOGIN_ENABLED` | `false` | When `true`, swaps the guest dev login card for greytHR sign-in. |
| `GREYTHR_CLIENT_URL` | `http://localhost:3000` | Base URL of the self-hosted greytHR ESS API service. |
| `GREYTHR_SUBDOMAIN` | _(empty)_ | Company subdomain prefilled in the greytHR login form. |
| `GREYTHR_LOGIN_TIMEOUT_MS` | `8000` | Timeout for the greytHR login proxy request. |
| `GREYTHR_PORTAL_URL` | kalvium ESS home (when configured) | ESS deep link shown as "Open greytHR ↗" in the widget; absent → link hidden. |
| `DATABASE_URL` | _(unset)_ | Postgres user storage. Down → warn + in-memory fallback. |
| `AUTO_MIGRATE` | `true` (when DB set) | Run `server/db/init.sql` on boot (idempotent). |
| `DATABASE_SSL` | `require` | Postgres TLS mode: `require`, `no-verify`, or `disable`. |
| `REDIS_URL` | _(unset)_ | Redis presence storage. Down → warn + in-memory fallback. |
| `SERVE_CLIENT` | `false` | Serve `client/dist` from Express on the API port (single-container deploy; the Docker image sets `true`). |
| `API_RATE_LIMIT` / `API_RATE_WINDOW_MS` | `60` / `60000` | Token-bucket rate limit on `/api` per client IP (`GET /api/health` never throttled). |
| `TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy to trust `X-Forwarded-For` client IPs. |
| `CORS_ORIGINS` | `CLIENT_APP_URL` | Comma-separated allowed browser origins for cross-origin API access. |

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
6. (Optional) Set `ALLOWED_EMAIL_DOMAINS` to comma-separated domains (e.g., `company.com`) to restrict access.

Flow: client → `GET /api/auth/:provider/login` (302 to the IdP) → IdP →
`GET /api/auth/:provider/callback` (code → identity → upsert user → mint our JWT) → 302 to
`${CLIENT_APP_URL}/#token=...` → the client stores the token and joins the room with it.
With **no** providers configured the login/callback routes 404 and the dev card is shown —
the office runs exactly as the MVP.

### Google Calendar Setup (Presence + Meet, optional)

When Google Calendar credentials are set, the office overlays a real `GoogleCalendarAdapter` to drive `IN_MEETING` presence and surface Google Meet video links.

1. In the GCP Console, register the client redirect URIs:
   - For sign-in: `${OAUTH_REDIRECT_BASE}/api/auth/google/callback`
   - For calendar: `${OAUTH_REDIRECT_BASE}/api/auth/google/calendar/callback`
2. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.
3. Users will see a **"Connect Google Calendar"** widget on the HUD. Clicking it initiates an incremental offline OAuth grant to request the `calendar.events.readonly` scope.
4. Refresh tokens are stored locally on the server (in memory for dev, or database in production). A background loop polls the primary calendar via incremental sync (`syncToken`).
5. (Optional) Set `GOOGLE_CAL_TITLES=false` to hide meeting names and display a generic "Busy" status on the map for privacy. See [docs/google-workspace-integration.md](docs/google-workspace-integration.md).

### greytHR ESS Setup (Login & Attendance, optional)

Makes **greytHR the sole office login** and drives the **Attendance check-in/out widget** using real HR data. Under this architecture, **PixelOffice never talks directly to greytHR cloud**. All traffic flows through the single self-hosted **greytHR ESS client proxy service** at `GREYTHR_CLIENT_URL`.

1. Run the self-hosted greytHR ESS client proxy service (typically on port `3000`).
2. Set the following environment variables in `.env`:
   ```bash
   GREYTHR_LOGIN_ENABLED=true
   GREYTHR_CLIENT_URL=http://localhost:3000
   GREYTHR_SUBDOMAIN=kalvium
   GREYTHR_PORTAL_URL=https://kalvium.greythr.com/v3/portal/ess/home # hyperlink for "Open greytHR"
   ```
3. The guest dev login card will be replaced with a **"Sign in with greytHR"** card prompting for **Employee No / Login ID** and **Password** (the subdomain is prefilled and hidden).
4. **Auth flow:** The browser sends credentials server-to-server once to the ESS proxy (`POST /api/auth/login`), which performs the Ory-Hydra OAuth2/OIDC login. PixelOffice never persists or logs the password. On success, PixelOffice maps the user's department, registers/upserts the employee, and issues a signed JWT.
5. **Attendance widget:** The HUD renders a self-view attendance widget showing your check-in state, today's shift details, first-in time, and ongoing worked hours. Explicit clicks on **Check in** / **Check out** dispatch real swipe actions through the ESS proxy.
6. **Privacy & Security:** Attendance details are strictly self-view only. The ESS client proxy caches sessions for `subdomain:loginId` (~45 days). Please refer to [docs/greythr-login-integration.md](docs/greythr-login-integration.md) for full architecture and safety details.

> `.env` is loaded automatically at boot (no `dotenv` dependency — the server uses Node's
> built-in env-file loader and never overrides real environment variables).

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

This repository implements the core virtual office features with pluggable integration adapters:

- **Auth.** Both dev guest logins, Google/Microsoft OAuth, and greytHR ESS authentication are fully supported behind the `AuthProvider` interface (`server/src/auth/`).
- **Persistence.** In-memory persistence is used by default. Production deployments can enable **PostgreSQL** (for user and event records) and **Redis** (for session and presence storage) by setting the respective environment variables.
- **Calendar.** Meeting detection is driven by a mock adapter by default, or by a live **Google Calendar** integration using offline OAuth grants when configured.
- **HR & Attendance.** Driven by a mock adapter by default, or by a live **greytHR ESS** client proxy integration when configured.
- **Ops & CI.** Fully configured with Docker, Docker Compose, and a GitHub Actions workflow running unit tests, client builds, and protocol smoke tests.

### Production Path Remaining Tasks
- **Microsoft 365 Calendar** integration (V2 planning).
- **Backend framework.** The manual DI container and Express setup can be ported to **NestJS** by moving services into Nest modules; Colyseus rooms and the presence engine will carry over unchanged.
- **HTTPS deployment.** Ensuring HTTPS/WSS is enforced for production environments.

The non-negotiables hold in this office and must continue to: presence not surveillance,
human agency (Join is always an explicit click), optional integrations, and business
logic that never leaks into Phaser scenes or UI components.
