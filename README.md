# PixelOffice

[![CI](https://github.com/aryantuntune/pixeloffice/actions/workflows/ci.yml/badge.svg)](https://github.com/aryantuntune/pixeloffice/actions/workflows/ci.yml)

PixelOffice is a multiplayer virtual office inspired by Pokémon Emerald that helps
distributed teams feel present, connected, and aware of each other's availability
without becoming a surveillance tool. You open the office in your browser, spawn at
your department desk, walk a pixel-art building across multiple floors, and instantly
see who is online, who is available, who is in a meeting, and who is taking a coffee
break. The true product is **presence + meetings + social interaction + team
awareness** — the map is just the visualization layer. There is no keystroke logging,
mouse tracking, screenshot capture, or productivity scoring, ever.

![The office](docs/screenshots/office.png)

<p align="center">
  <img src="docs/screenshots/coffee-break.png" width="49%" alt="A coffee break in the Coffee Area" />
  <img src="docs/screenshots/meeting.png" width="49%" alt="A meeting starting — pulsing Join button, never auto-teleport" />
</p>

<p align="center">
  <img src="docs/screenshots/login.png" width="60%" alt="Login screen" />
</p>

> **Building on PixelOffice?** Engineers and AI agents should start with
> [AGENTS.md](AGENTS.md) — the constitution, architecture, module map, wire protocol,
> and contributor conventions all live there.

---

## Quickstart

```bash
npm install          # installs all workspaces (shared, server, client)
npm run dev          # server on :2567, client on :5173
```

Then open **http://localhost:5173**. Pick a name, department, and avatar, and click
**Enter Office**. (With **greytHR sign-in** enabled you instead enter your **Employee
No + password** — your name and department come from greytHR.)

To see multiplayer presence, **open http://localhost:5173 in two or more browser
windows** (or share your LAN IP with a teammate). Each window is a separate avatar;
move one with the arrow keys / WASD and watch it move in real time in the others.

> **Low file-watcher limit?** If `npm run dev` fails with `ENOSPC: System limit for
> number of file watchers reached`, either raise the limit
> (`sudo sysctl fs.inotify.max_user_watches=524288`) or run without watchers:
> `npm run start -w server` (server) and a built client preview
> (`npm run build -w client && npm run preview -w client`).

---

## Feature Tour

Everything below is **built and working today** in the zero-config dev experience.

### The building & moving around

- **Multi-floor building.** Three floors connected by **elevators**: a **Ground**
  lobby/reception, **Floor 1** with four corner cabins + a desk cluster + a coffee
  nook, and **Floor 2**, the rich main office (Reception, Engineering / Product /
  Design / HR departments with desks, Meeting Rooms A/B/C, Coffee Area, Lounge). New
  players spawn on Floor 2 at a free desk in their department.
- **Elevators (human agency).** Walk your own avatar onto an elevator tile to ride
  between floors — nothing teleports you automatically. Each floor is floor-scoped:
  you only see and hear players on your current floor.
- **Pokémon-style movement.** Arrow keys / WASD step one tile at a time; tap a
  direction to turn in place. The top bar always shows the area you're standing in.
- **Minimap & locate.** A live minimap of the current floor; click a teammate to
  **locate** them.

### Presence & status

- **Presence states & sources.** Every avatar carries one of six states —
  `AVAILABLE`, `IN_MEETING`, `FOCUS`, `BREAK`, `AWAY`, `OFFLINE` — each with a
  transparent *source* so the team knows where it came from: `CALENDAR` (an active
  meeting), `MANUAL` (you picked it), `EVENT` (you joined a coffee break), `AUTO`
  (idle timeout), or `SYSTEM` (default). Presence is resolved by a pure engine on the
  server and pushed to clients; the UI only displays it.
- **Status selector.** The top-bar pill opens a dropdown: Available / Focus / Break /
  Away. Picking **Available** clears any manual override and lets automatic rules take
  over again.
- **Auto-away.** No activity for `AWAY_TIMEOUT_MS` (default 90s) flips you to `AWAY`
  (source `AUTO`); any action brings you back.

### Social & communication

- **Chat & emotes.** Send a short message that pops as a speech bubble over your
  avatar; trigger quick **emotes** from the emote bar.
- **Click-to-view profiles.** Click any avatar to see their profile card; **double-click
  your own avatar** to edit your display name, department, and avatar color — changes
  broadcast live and persist (never moves your avatar).
- **Coffee breaks & social events.** An admin starts a **Coffee Break**, **Tea Break**,
  **Team Gathering**, or **Town Hall**. Everyone gets a toast and a "Happening now"
  entry with a **Join** button; joining walks you to the venue and sets `BREAK`.
- **Ambient NPCs.** Up to 16 server-driven NPCs wander, sit at vacant desks, take
  coffee breaks, and occasionally chat — ambience, never deception (they never join
  meetings or touch HR).

### Meetings

- **Meetings + the Join button (human-agency rule).** When a scheduled meeting starts,
  invited users get a toast and a persistent **Join Meeting** button. Your avatar is
  **never** teleported automatically — only clicking Join seats you in the assigned
  room (≤4 → Room A, ≤8 → Room B, else Room C). With Google Calendar connected, **Open
  Meet** opens the Google Meet video link in a new tab.
- **Google Calendar integration.** Connect your calendar from the HUD; real meetings
  drive your status to `IN_MEETING` (source `CALENDAR`) and surface a Join link.
  Optional title-privacy mode shows "Busy" instead of event names.

### Lounge mini-games

- **8-Ball Pool**, **Ping-Pong**, **Tic-Tac-Toe**, **Connect Four** — walk up to a
  station in the Lounge and press **E** to play. All server-authoritative. Pool offers
  **vs AI** ("Pool Bot") or **group** (two humans, plus spectators). Games are pure
  fun: opt-in, explicit, never move your avatar, never affect presence or HR.

### Identity, attendance & ops

- **greytHR sign-in & attendance (optional).** When enabled, greytHR is the office
  login: sign in with **Employee No + password**; your real **name + department** come
  from greytHR via the self-hosted ESS client proxy. A self-view attendance widget
  shows your check-in state, shift, and worked hours, with explicit **Check-in /
  Check-out** actions. PixelOffice never stores your password.
- **OAuth sign-in (optional).** Google / Microsoft OAuth replace the dev login behind
  the same `AuthProvider` interface; JWT sessions with RBAC.
- **Opt-in office floor detection.** In Settings, a user can enable "sync my floor to
  where I'm sitting." The server maps their client IP (subnet-based) to **Office /
  Remote** and, when Office, to a floor — then moves them there via the normal
  consented floor-change machinery. OFF by default; stores only the current tag +
  floor, never IPs or a location history.
- **In-browser Map Studio.** A floor designer to edit the building (areas, desks,
  furniture, elevators), validate it, save, and activate it for new joins.
- **Admin console.** The ⚙ Admin button opens a modal (plain REST) to create events,
  schedule meetings, send broadcasts, and view the live roster.
- **Auto-reconnect.** If the server restarts, the client shows a "Reconnecting…"
  banner and re-joins automatically with your identity — no refresh needed.

---

## Configuration

**Every environment variable is optional.** With none set, `npm install && npm run
dev` runs the full experience — dev login, in-memory storage, mock calendar, mock
greytHR, open admin console, ephemeral JWT, ambient NPCs. A configured-but-unreachable
integration (Postgres/Redis/greytHR/calendar) logs a warning and falls back so the
office keeps working. Copy `.env.example` to `.env` and uncomment only what you need.

### Core server & NPCs

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `2567` | Server port (REST + Colyseus ws). |
| `AWAY_TIMEOUT_MS` | `90000` | Idle ms before a session auto-flips to `AWAY`; any C2S message clears it. |
| `LOG_LEVEL` | `info` | Log verbosity: `debug` / `info` / `warn` / `error` (operational events only). |
| `NPC_COUNT` | `8` | Ambient NPCs to spawn (`0` to disable, max 16). |
| `NPC_SEED` | `42` | PRNG seed for deterministic NPC behavior. |

### Auth, OAuth & RBAC

| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | ephemeral | App JWT signing secret. Unset → random per-process secret + boot warning. Set in production. |
| `JWT_EXPIRES_IN` | `12h` | Token lifetime (jsonwebtoken format). |
| `AUTH_REQUIRED` | `false` | When `true`, a valid JWT is required to join and an admin JWT for admin writes. |
| `ADMIN_EMAILS` | _(empty)_ | Comma-separated emails granted the `admin` role. |
| `CLIENT_APP_URL` | `http://localhost:5173` | Where the browser is redirected after an OAuth callback. |
| `DEFAULT_DEPARTMENT` | `Engineering` | Department for OAuth users who don't pick one. |
| `ALLOWED_EMAIL_DOMAINS` | _(empty)_ | Comma-separated domains allowed to sign in via OAuth. Empty = no restriction. |
| `OAUTH_REDIRECT_BASE` | _(unset)_ | Public base URL of this server; OAuth redirect URIs derive from it. Required to enable OAuth. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | _(unset)_ | Enable Google OAuth (and Google Calendar). |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | _(unset)_ | Enable Microsoft OAuth (both + redirect base required). |
| `MS_TENANT` | `common` | Azure AD tenant id, or `common` / `organizations` / `consumers`. |

OAuth replaces the dev card with "Sign in with Google/Microsoft". Set
`OAUTH_REDIRECT_BASE` and register the redirect URIs
`${OAUTH_REDIRECT_BASE}/api/auth/google/callback` and
`${OAUTH_REDIRECT_BASE}/api/auth/microsoft/callback`. With no providers configured the
auth routes 404 and the dev card is shown.

### Google Calendar (presence + Meet)

| Variable | Default | Purpose |
|---|---|---|
| `GOOGLE_CAL_TITLES` | `true` | When `false`, hides meeting titles (busy/free privacy mode). |
| `GOOGLE_CAL_POLL_MS` | `45000` | Per-user poll interval for incremental calendar sync. |
| `GOOGLE_AUTH_BASE` / `GOOGLE_TOKEN_BASE` / `GOOGLE_API_BASE` | Google APIs | Endpoint overrides to point at a local stub for offline tests. |

Reuses the Google OAuth client. Users click **Connect Google Calendar** in the HUD to
grant `calendar.events.readonly` (incremental offline grant); refresh tokens are stored
server-side. Register the extra redirect URI
`${OAUTH_REDIRECT_BASE}/api/auth/google/calendar/callback`. See
[docs/google-workspace-integration.md](docs/google-workspace-integration.md).

### greytHR ESS (login + attendance)

PixelOffice **never talks to greytHR cloud directly** — all greytHR traffic (sign-in,
attendance, profile) flows through one self-hosted **greytHR ESS client proxy** at
`GREYTHR_CLIENT_URL`. PixelOffice forwards the password once, server-to-server, and
keeps only the JWT it mints.

| Variable | Default | Purpose |
|---|---|---|
| `GREYTHR_LOGIN_ENABLED` | `false` | When `true`, swaps the dev login card for greytHR sign-in (forces `AUTH_REQUIRED`). |
| `GREYTHR_CLIENT_URL` | `http://localhost:3000` | Base URL of the self-hosted greytHR ESS API service. |
| `GREYTHR_SUBDOMAIN` | _(empty)_ | Company subdomain prefilled + forwarded (e.g. `kalvium`). |
| `GREYTHR_LOGIN_TIMEOUT_MS` | `8000` | Timeout for the greytHR login proxy request. |
| `GREYTHR_PORTAL_URL` | ESS home (when set) | User-facing "Open greytHR ↗" deep link in the attendance widget. |

### Persistence (Postgres + Redis)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | _(unset)_ | Postgres user storage. Down → warn + in-memory fallback. |
| `AUTO_MIGRATE` | `true` (when DB set) | Run `server/db/init.sql` on boot (idempotent). |
| `DATABASE_SSL` | `require` | Postgres TLS mode: `require`, `no-verify`, or `disable`. |
| `REDIS_URL` | _(unset)_ | Redis presence storage (latest state/source/timestamp only). Down → warn + in-memory. |

```bash
docker compose up                # starts ONLY postgres + redis
DATABASE_URL=postgres://pixeloffice:pixeloffice@localhost:5432/pixeloffice \
REDIS_URL=redis://localhost:6379 \
npm run dev                       # the office now persists users + latest presence
```

### Opt-in floor detection

| Variable | Default | Purpose |
|---|---|---|
| `OFFICE_SUBNETS` | _(unset)_ | Comma-separated `CIDR=floorId` pairs (e.g. `10.1.0.0/16=floor-1`); maps a subnet to a floor. IPv4 only. |
| `OFFICE_CIDRS` | _(unset)_ | Extra office ranges with no specific floor (classify Office, but don't move a floor). |

With neither set the feature is inert: the toggle resolves Remote and nobody moves.

### Serving, CORS & rate limit

| Variable | Default | Purpose |
|---|---|---|
| `SERVE_CLIENT` | `false` | Serve `client/dist` from Express on the API port (single-container deploy; the Docker image sets `true`). |
| `API_RATE_LIMIT` / `API_RATE_WINDOW_MS` | `60` / `60000` | Token-bucket rate limit on `/api` per client IP (`GET /api/health` never throttled). |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy to trust `X-Forwarded-For` client IPs. |
| `CORS_ORIGINS` | `CLIENT_APP_URL` | Comma-separated allowed browser origins for `/api`. Never wildcard in production. |

> `.env` is loaded automatically at boot (no `dotenv` dependency — the server uses
> Node's built-in env-file loader and never overrides real environment variables).

---

## Tests, smoke & CI

```bash
npm test             # vitest: presence engine + auth/RBAC/OAuth + greytHR mapping +
                     # attendance state machine + NPC determinism + repositories +
                     # rate limiting + shutdown (server workspace)

npm run dev          # in one terminal (or: npm run start -w server)
npm run smoke        # in another — joins the room and exercises the wire protocol
```

The smoke test joins two clients and asserts the happy path: `WELCOME` with a walkable
spawn → move echo → second-player propagation → set-status → presence change → create
event via REST → join event → teleport + `BREAK` → schedule meeting → `MEETING_STARTED`.

### Docker

```bash
docker build --platform linux/amd64 -t djdiptayan/pixeloffice:latest .
docker push djdiptayan/pixeloffice:latest
docker compose pull
docker compose up -d
```

The image builds the client, serves it from Express (`SERVE_CLIENT=true`), runs as the
unprivileged `node` user, exposes `2567`, and has a `HEALTHCHECK` on `/api/health`.

### Google Cloud VM deploy

Production runs as one Docker container from Docker Hub:
`djdiptayan/pixeloffice:latest`. The container serves the frontend, REST API, and
WebSocket server from port `2567`. On the VM, bind that port to localhost only and let
Caddy expose the public HTTPS domain.

Example VM files:

```text
~/pixeloffice.env
~/start-pixeloffice.sh
```

`~/start-pixeloffice.sh`:

```bash
#!/bin/bash

set -e

IMAGE="djdiptayan/pixeloffice:latest"
CONTAINER_NAME="pixeloffice"

echo "Pulling latest image..."
docker pull $IMAGE

echo "Stopping existing container (if any)..."
docker stop $CONTAINER_NAME 2>/dev/null || true
docker rm $CONTAINER_NAME 2>/dev/null || true

echo "Starting new container..."
docker run -d \
  --name $CONTAINER_NAME \
  --restart unless-stopped \
  --env-file pixeloffice.env \
  -p 127.0.0.1:2567:2567 \
  $IMAGE

echo "Container restarted successfully."
```

The VM startup metadata runs this script after reboot, so the app should come back
without a manual SSH session. Startup logs are written to:

```bash
sudo tail -n 100 /var/log/pixeloffice-startup.log
```

Useful VM commands:

```bash
./start-pixeloffice.sh
docker logs -f pixeloffice
docker ps
curl http://127.0.0.1:2567/api/health
```

### Caddy and Cloudflare

Public traffic enters through Cloudflare and Caddy:

```text
https://pixeloffice.app -> Caddy :443 -> 127.0.0.1:2567 -> PixelOffice container
```

Edit Caddy on the VM:

```bash
cd /etc/caddy
sudo nano Caddyfile
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Current Caddyfile:

```caddyfile
pixeloffice.app {
	tls internal
	reverse_proxy 127.0.0.1:2567
}

www.pixeloffice.app {
	tls internal
	redir https://pixeloffice.app{uri} permanent
}
```

Cloudflare DNS should point `pixeloffice.app` to the VM external IP. With `tls internal`
on the origin, Cloudflare SSL/TLS mode should be **Full**. Keep VM firewall exposure to
SSH plus `80`/`443`; do not expose raw `2567` publicly.

### CI

`.github/workflows/ci.yml` runs on every push and PR: `npm ci` → `npm test` →
`npm run build -w client` → boot the server → poll `/api/health` → `npm run smoke`.

---

## What's next & deeper reference

- [docs/ROADMAP-integrations.md](docs/ROADMAP-integrations.md) — forward-looking
  integration roadmap (proximity voice, M365 calendar, Slack mirror, audit log, …).
- [docs/google-workspace-integration.md](docs/google-workspace-integration.md) —
  Google Workspace setup (consent screen, scopes, admin steps, gotchas).

---

## Privacy / non-negotiables

These rules are the product, not a setting — they always hold:

- **Presence, not surveillance.** No keystroke logging, mouse tracking, screenshots,
  productivity scores, or activity ranking. The only signals are the ones you can see
  yourself: your status, your location in the office, and what you explicitly share.
  Even opt-in floor detection stores only the current Office/Remote tag + floor —
  never IPs, never a who-was-where-when history.
- **Human agency.** Meetings and events never teleport your avatar; **Join** is always
  an explicit click. Attendance check-in/out is always your action, never automatic.
- **Integrations are optional.** The office keeps working if calendar, greytHR,
  Postgres, or Redis is down — every integration degrades gracefully.
