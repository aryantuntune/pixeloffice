# NOTES-auth — wiring instructions for the INTEGRATOR

Auth builder deliverables. Zero-config dev path is preserved: with NO env vars,
no OAuth providers are enabled, JWT uses an ephemeral secret, AUTH_REQUIRED is
false, and the office behaves exactly as the MVP (dev login form, open admin
REST, no token needed to join). Everything below is opt-in via env.

## 1. Dependencies to add (server/package.json `dependencies`)

```json
"jsonwebtoken": "^9.0.2"
```

and in `devDependencies`:

```json
"@types/jsonwebtoken": "^9.0.6"
```

(Both already resolve transitively in the current tree, so tests pass today, but
declare them explicitly so the server workspace owns them.)

No new client dependencies (login.ts uses fetch + the existing shared package).

## 2. New files I created (all inside my scope, no edits to your files)

- `server/src/auth/jwt.service.ts` — `JwtService` (sign/verify/tryVerify),
  `jwtServiceFromEnv`, types `SessionClaims`, `VerifiedSession`, `Role`.
- `server/src/auth/rbac.ts` — `parseAdminEmails`, `roleForEmail`, `roleForEmailFromEnv`.
- `server/src/auth/oauth-provider.ts` — `OAuthProvider` interface, `OAuthIdentity`,
  `redirectUriFor`, `FetchLike`.
- `server/src/auth/oauth-state.ts` — `createState`, `verifyState` (signed, 10-min TTL).
- `server/src/auth/google-oauth.provider.ts` — `GoogleOAuthProvider`.
- `server/src/auth/microsoft-oauth.provider.ts` — `MicrosoftOAuthProvider`.
- `server/src/auth/auth-config.ts` — `buildAuthConfig(env)` -> `AuthConfig`
  (jwt, providers map, adminEmails, defaultDepartment, clientAppUrl, authRequired,
  stateSecret). THIS is the single env-reading entry point — call it once.
- `server/src/auth/jwt-auth.provider.ts` — `JwtAuthProvider` implements the
  existing `AuthProvider` interface (token verify + dev fallback).
- `server/src/auth/middleware.ts` — `requireAuth`, `requireRole`, `createAdminGuard`,
  `bearerToken`, `sessionOf`.
- `server/src/http/auth.routes.ts` — `createAuthRouter({ config, users })`.
- Tests: `server/src/auth/*.test.ts` (43 tests, all green; no network — fetch is injected).
- Client: `client/src/ui/login.ts` (rewritten; sole owner this round). New export
  `readStoredToken()` and type `JoinSubmission = JoinOptions & { token?: string }`.

## 3. container.ts changes (you own this file)

Replace the dev-only auth provider with the JWT-aware one, and expose the auth
config so routes can read it. Add:

```ts
import { buildAuthConfig } from "./auth/auth-config";
import { JwtAuthProvider } from "./auth/jwt-auth.provider";
// existing: import { DevAuthProvider, type AuthProvider } from "./auth/auth-provider";

const authConfig = buildAuthConfig(process.env);

const devAuth = new DevAuthProvider();
const auth: AuthProvider = new JwtAuthProvider({
  jwt: authConfig.jwt,
  fallback: devAuth,
  authRequired: authConfig.authRequired,
  defaultDepartment: authConfig.defaultDepartment,
});
```

Then add `authConfig` to the exported `container` object:

```ts
export const container = {
  mockCalendar, calendar, events, presence, users, auth,
  authConfig,            // <-- add this
  registry,
};
```

The room's `onJoin` already calls `container.auth.authenticate(options)` — no
room edit needed. The `JwtAuthProvider`:
- with `{ token }` in JoinOptions → verifies JWT, userId = `sub`, name from token
  (or override), department from JoinOptions or DEFAULT_DEPARTMENT, avatar from
  JoinOptions or first avatar;
- with no token and AUTH_REQUIRED unset → delegates to DevAuthProvider (unchanged dev path);
- with no token and AUTH_REQUIRED=true → rejects the join (Colyseus onJoin throw → client onError).

NOTE: `JoinOptions` (shared/src/protocol.ts) does not declare `token`. The
provider reads it defensively from `options`, so NO shared change is required.
If you prefer it typed, the additive (backward-compatible) extension is:
`export interface JoinOptions { name; department; avatarId; token?: string }`.
The client already passes `token` through; the dev path omits it.

## 4. index.ts changes (you own this file) — mount auth routes

```ts
import { createAuthRouter } from "./http/auth.routes";
import { container } from "./container";
// ...after app.use("/api", createAdminRouter()) OR before — order doesn't matter:
app.use("/api/auth", createAuthRouter({
  config: container.authConfig,
  users: container.users,
}));
```

Endpoints exposed: `GET /api/auth/config`, `GET /api/auth/me`,
`GET /api/auth/:provider/login`, `GET /api/auth/:provider/callback`
(provider ∈ google | microsoft). With no providers configured, the login/callback
routes return 404 and `/config` returns `{ providers: [], authRequired: false, ... }`.

## 5. admin.routes.ts protection (you own this file) — OPTIONAL gate

To enforce admin-only writes when AUTH_REQUIRED=true (open in dev), wrap the
protected routes with the ready-made guard. In `createAdminRouter`:

```ts
import { createAdminGuard } from "../auth/middleware";
// inside createAdminRouter(), after `const router = Router();`
const guard = createAdminGuard(container.authConfig.jwt, container.authConfig.authRequired);
```

Then protect exactly these (per task spec) — leave GET /health and GET /users
open or guard /users too, your call (spec lists /users as protected):

```ts
router.get("/users", guard, (req, res) => { ... });
router.post("/events", guard, (req, res) => { ... });
router.post("/meetings", guard, (req, res) => { ... });
router.post("/broadcast", guard, (req, res) => { ... });
```

`guard` is a NO-OP when AUTH_REQUIRED is unset (dev console stays open), and
becomes `requireRole('admin')` (401 then 403) when AUTH_REQUIRED=true. The
client admin modal must then send `Authorization: Bearer <token>` — the token is
in `sessionStorage["pixeloffice.token"]` (helper `readStoredToken()` exported
from login.ts) when an OAuth session exists.

## 6. main.ts changes (you own this file) — pass token through on join

`createLogin`'s `onSubmit` now hands back `JoinSubmission = JoinOptions & { token?: string }`.
The current `start(opts)` already forwards `opts` to `conn.connect(opts)`; since
`token` is just an extra field on the object, colyseus carries it to the server in
JoinOptions and `JwtAuthProvider` reads it. So the MINIMAL change is: nothing —
it already works because the object spreads through.

Recommended explicitness (so the dev path and OAuth path are obvious):
- `client/src/net/connection.ts` `connect(opts: JoinOptions)` — accept the extra
  field; either widen the param type to `JoinOptions & { token?: string }` or
  leave as-is (the extra field passes through `joinOrCreate(ROOM_NAME, opts)` fine).
- On a successful OAuth join the login card auto-submits (after reading
  `/api/auth/me`); on disconnect, `login.show()` is called as today. If you want
  "remember my OAuth session", `readStoredToken()` is available to re-attach.

The login screen logic (provider buttons, #token fragment capture, /me prefill,
AUTH_REQUIRED hiding the dev form) is fully self-contained in login.ts.

## 7. .env.example additions (you own this file)

```bash
# ---- Auth (all optional; unset = dev mode: dev login, open admin, ephemeral JWT) ----
# Our application JWT signing secret. Unset => ephemeral per-process secret + a
# boot warning (tokens reset on restart). Set a long random value in production.
JWT_SECRET=
# Token lifetime (jsonwebtoken format). Default "12h".
JWT_EXPIRES_IN=12h

# Require a valid admin JWT for admin REST writes AND require a token to join the
# room. Leave false/unset for the zero-config dev experience.
AUTH_REQUIRED=false

# Comma-separated emails granted the 'admin' role (RBAC). Everyone else is 'member'.
ADMIN_EMAILS=admin@example.com

# Where the browser is sent after a successful OAuth callback (the client app).
CLIENT_APP_URL=http://localhost:5173

# Department assigned to OAuth users who don't pick one at the login screen.
DEFAULT_DEPARTMENT=Engineering

# Public base URL of THIS server; OAuth redirect URIs are
# ${OAUTH_REDIRECT_BASE}/api/auth/<provider>/callback . Required to enable OAuth.
OAUTH_REDIRECT_BASE=http://localhost:2567

# ---- Google OAuth (enable by setting all three: id, secret, redirect base) ----
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# ---- Microsoft OAuth (Azure AD) ----
MS_CLIENT_ID=
MS_CLIENT_SECRET=
# Tenant id, or one of common | organizations | consumers. Default "common".
MS_TENANT=common
```

Provider gating rule: a provider is enabled ONLY when its CLIENT_ID + CLIENT_SECRET
AND OAUTH_REDIRECT_BASE are all non-empty. So fake/dead config that misses any of
these leaves the provider off and the office keeps working.

IdP console redirect URIs to register:
- Google:    `${OAUTH_REDIRECT_BASE}/api/auth/google/callback`
- Microsoft: `${OAUTH_REDIRECT_BASE}/api/auth/microsoft/callback`

## 8. CONTRACT.md / README notes (you own these)

- Wire protocol: JoinOptions gains an OPTIONAL `token` field (backward compatible).
  S2C/C2S message names are unchanged.
- Auth flow (production): client → `GET /api/auth/:provider/login` (302 to IdP) →
  IdP → `GET /api/auth/:provider/callback` (code→identity→upsert user→our JWT) →
  302 to `CLIENT_APP_URL/#token=...` → client stores token, calls `/api/auth/me`,
  joins room with `{ token }`. RBAC from ADMIN_EMAILS. HTTPS in production
  (set OAUTH_REDIRECT_BASE/CLIENT_APP_URL to https URLs).

## 9. Test status

`cd server && npx vitest run src/auth/` → 43 passing, no network (fetch injected,
crypto/JWT local). `npx tsc --noEmit` clean within auth scope. Client `tsc`
clean. The ephemeral-secret warning printed during auth-config tests is the
intended dev-mode behavior being exercised.
