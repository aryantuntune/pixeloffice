# PixelOffice — Architecture

> How the office works under the hood. For the product constitution see [`plan.md`](../plan.md);
> for module boundaries and the wire contract see [`CONTRACT.md`](../CONTRACT.md).

## The one-paragraph version

PixelOffice is a monorepo with three npm workspaces. `shared/` holds framework-free domain
types, the wire protocol, and the office map — the single source of truth both sides compile
against. `server/` is Node + Colyseus + Express: a thin WebSocket room translates protocol
messages to/from framework-free services (presence, events, attendance, NPCs) that integrate
with the outside world only through adapter interfaces (calendar, GreytHR, OAuth, Postgres,
Redis). `client/` is Vite + Phaser 3 for rendering plus a vanilla-TypeScript DOM HUD; neither
contains business logic — they render server-pushed facts and forward explicit user actions.

```
                ┌────────────────────────── client/ ───────────────────────────┐
                │  src/game/  Phaser 3 scene (rendering only)                   │
  Browser ──────│  src/ui/    DOM HUD: login, roster, events, admin, attendance │
                │  src/net/   colyseus.js wrapper + auto-reconnect              │
                └──────────────▲────────────────────────▲──────────────────────┘
                       WebSocket (room "office")     REST /api/*
                ┌──────────────▼────────────────────────▼──────────────────────┐
                │  rooms/office.room.ts   the ONLY Colyseus-aware module        │
                │  http/                  admin / auth / hr routes, rate limit  │
   server/ ─────│  presence/ events/ npcs/ integrations/   framework-free      │
                │  auth/  repositories/  persistence/       services + adapters │
                └──────────────────────────▲───────────────────────────────────┘
                                           │ imports types/protocol/map
                ┌──────────────────────────┴───────────────────────────────────┐
                │  shared/   PresenceState, wire protocol (C2S/S2C), office map │
                └──────────────────────────────────────────────────────────────┘
```

## Layers (mapping plan.md → directories)

| plan.md layer | Where it lives |
|---|---|
| World Layer (rendering) | `client/src/game/` — Phaser scene, runtime-generated textures |
| Presence Layer | `server/src/presence/` — pure engine + service |
| Integration Layer | `server/src/integrations/` — calendar + GreytHR adapters; `server/src/auth/` — OAuth providers |
| Persistence Layer | `server/src/repositories/` + `server/src/persistence/` — Postgres/Redis behind interfaces, in-memory defaults |

## The wire protocol

No `@colyseus/schema` state sync. Everything is plain JSON messages declared once in
`shared/src/protocol.ts` (`C2S` client→server, `S2C` server→client) with typed payload
interfaces. Coordinates on the wire are **tile coordinates**, never pixels.

Key flows:

- **Join** → server authenticates (`AuthProvider`), assigns a free desk seat in your
  department, sends `WELCOME` (self, everyone else incl. NPCs, active events, current
  meeting), broadcasts `PLAYER_JOINED` to others.
- **Move** → client sends one `MOVE` per committed tile step; server validates
  (walkable + ≤1-tile delta) and rebroadcasts; an invalid move gets an authoritative
  `PLAYER_TELEPORTED` correction back.
- **Meetings** → admin REST seeds the calendar adapter; the presence tick detects the
  window and sends `MEETING_STARTED` *to participants only*. Nothing moves until the
  user clicks Join (`JOIN_MEETING`) — the human-agency rule.
- **Events** → `EVENT_CREATED` broadcast + toast; `JOIN_EVENT` teleports *the sender
  only* to an area anchor and presence becomes `BREAK` via the `EVENT` source.

Abuse guards: per-session token buckets on MOVE/CHAT/actions, payload validation on every
handler, REST rate limiting per IP (XFF only honored behind `TRUST_PROXY`).

## The presence engine

A single pure function (`presence/presence-engine.ts`) — no I/O, no clock reads; the room
is the only module that reads the system clock and passes `now` down. Priority order:

1. not connected → `OFFLINE`
2. active calendar meeting → `IN_MEETING` (CALENDAR) — beats everything
3. manual Focus → `FOCUS` (MANUAL)
4. joined an active social event → `BREAK` (EVENT)
5. manual Break → `BREAK` (MANUAL)
6. manual Away → `AWAY` (MANUAL)
7. inactive ≥ `AWAY_TIMEOUT_MS` (default 90 s) → `AWAY` (AUTO)
8. otherwise → `AVAILABLE`

Manual Available clears the override; any client message counts as activity. Every state
carries its **source** (`MANUAL`/`CALENDAR`/`EVENT`/`AUTO`/`SYSTEM`) so the UI can be
transparent about *why* someone shows a state. The engine has exhaustive state-transition
tests — by design, since trust in presence is the product.

## Services & dependency injection

`server/src/container.ts` constructs every service once and injects dependencies through
constructors (no DI framework — explicit and readable). Env vars select implementations:

| Seam | Default (zero-config) | Configured |
|---|---|---|
| `AuthProvider` | Dev login (name/department) | Google / Microsoft OAuth + JWT (`AUTH_REQUIRED`) |
| `CalendarAdapter` | In-memory mock (admin-seeded) | Google Calendar (interface ready) |
| `HrAdapter` | Mock GreytHR | Real greytHR REST (`GREYTHR_*`) |
| `UserRepository` | In-memory | PostgreSQL (`DATABASE_URL`) |
| `PresenceStore` | In-memory | Redis (`REDIS_URL`) |

**Failure policy (plan rule: integrations are optional):** a configured-but-unreachable
integration logs a warning and falls back / degrades gracefully. The office never goes
down because Postgres, Redis, GreytHR, or a calendar did.

## The office room

`rooms/office.room.ts` is deliberately the only Colyseus-aware module. It owns the live
`PlayerSnapshot` map, translates service events to broadcasts (and detaches its listeners
on dispose — services are singletons), drives the 3-second tick, seats meeting joiners via
a slot allocator, and applies NPC effects. Everything it does is mechanical translation;
decisions live in the services.

## NPCs

`server/src/npcs/npc.service.ts` — a deterministic, framework-free simulation (seeded PRNG,
injected clock) that returns *effects* (`move`/`presence`/`chat`) each tick; the room
translates them to ordinary protocol broadcasts, so clients render NPCs as regular players
(flagged `isNpc` for the roster). NPCs sit at the last desks per department (humans keep
the first seats), wander, take coffee breaks, and drift into social events. They never join
meetings, never touch HR, and never impersonate conversation — ambience, not deception.

## Client architecture

- `src/main.ts` — composition root: login → connect → `WELCOME` → boot game + HUD, then a
  message-type→handler bridge. Idempotent welcome bootstrapping makes reconnects clean
  (the connection layer auto-rejoins with exponential backoff; a banner shows state).
- `src/game/` — one Phaser scene. All textures (floors, walls, furniture, avatar sprite
  sheets with per-avatar hairstyles and 4-frame walk cycles) are generated at runtime on a
  canvas — the repo ships zero binary assets. Movement is Pokémon-style grid stepping;
  the scene exposes an imperative handle (`addPlayer`/`movePlayer`/`teleportPlayer`/…)
  and calls back `onLocalMove`. It renders presence states from a lookup table and holds
  **no presence logic**.
- `src/ui/` — vanilla-TS components rendering from a tiny subscribe store. The HUD never
  computes presence; it displays what the server pushed.

## Security model

- OAuth only (Google/Microsoft) — password auth is constitutionally forbidden. The dev
  login is an explicit stand-in behind the same `AuthProvider` interface.
- JWT (HS256 pinned) with role-based access; `AUTH_REQUIRED=true` gates admin REST
  (401/403) and room joins. Admin role via `ADMIN_EMAILS`.
- HR identity comes from the verified JWT (or the caller's own live session in dev) —
  never from a client-supplied id; NPC sessions are rejected outright.
- No surveillance: the server tracks session activity timestamps and explicit status,
  nothing else. Logs deliberately exclude chat content and movement.

## Testing

| Layer | What's covered |
|---|---|
| `npm test` (~210 tests) | presence transitions, JWT/RBAC/OAuth state, attendance state machine, GreytHR adapter (mocked fetch), NPC determinism, repositories, rate limiting, shutdown |
| `npm run smoke` | live protocol: join → welcome → move echo → presence → event → teleport → meeting |
| CI (GitHub Actions) | install → tests → client build → boot + smoke |
