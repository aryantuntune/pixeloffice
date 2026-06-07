# PixelOffice

A multiplayer virtual office (Pokémon Emerald vibe) focused on presence, meetings, and social interaction — never surveillance. See `plan.md` for the full constitution and `CONTRACT.md` for module boundaries.

## Engineering Rules

Never place business logic inside React components.

Never place business logic inside Phaser scenes.

Always use service layers.

Always define interfaces before implementations.

Always use dependency injection.

Always write tests for state transitions.

Never call third-party APIs directly from UI components.

Keep integrations isolated behind adapters.

Business logic must remain framework-independent.

Avoid premature optimization.

Prefer maintainability over cleverness.

## Product Rules

- Presence, not surveillance: no keystroke/mouse/screenshot tracking, no productivity scoring.
- Human agency: meetings/events never teleport an avatar automatically — the user must click Join.
- Integrations are optional: the office must keep working if any integration (calendar, HR) fails.
- No custom username/password auth. Dev login is an OAuth stand-in behind the `AuthProvider` interface.

## Repo Layout

- `shared/` — framework-free domain types, wire protocol, office map data (source of truth for both sides)
- `server/` — Node + Colyseus + Express: presence engine, social events, calendar adapter, office room, admin REST API
- `client/` — Vite + TypeScript + Phaser 3: rendering layer (`src/game/`) + DOM HUD (`src/ui/`)

## Commands

- `npm install` (root, installs all workspaces)
- `npm run dev` — server on :2567, client on :5173
- `npm test` — presence engine state-transition tests (vitest)
- `npm run smoke` — end-to-end protocol smoke test against a booted server
