# NOTES-fixer — security fixes wiring (for the INTEGRATOR)

Owner: FIXER. Three reviewer-confirmed findings fixed. Two of them need a small,
backward-compatible change in INTEGRATOR-owned files (server/src/index.ts). The
fixes are designed so that if you do NOT make these edits, the zero-config dev
path is still 100% unchanged — the edits only ACTIVATE the hardening when the
relevant env is set.

All edited files are inside server/** (my scope) except the two wiring snippets
below which touch server/src/index.ts (yours).

## Test status

`npm test` -> 124 passed | 2 skipped (was 111 | 2). New tests:
- server/src/http/hr.routes.test.ts (IDOR / auth-required + dev path)
- server/src/auth/jwt.service.test.ts (alg:none reject, HS512/HS384 reject, HS256 header)
- server/src/http/rate-limit.test.ts (XFF-spoofing not honored unless trustProxy)

`tsc --noEmit -p server/tsconfig.json` exit 0. `npm run build -w client` OK.
Zero-config boot + `npm run smoke` PASS. AUTH_REQUIRED live spot-check PASS
(no-token 401, admin 200, member 403, HS512-forged-admin 401).

---

## 1. HR routes IDOR (BLOCKER) — pass the auth gate into createHrRouter

`server/src/http/hr.routes.ts` now takes an OPTIONAL `auth: { jwt, required }`
dep. When `required` is true it authenticates check-in/check-out/status with
`requireAuth(jwt)` and derives the acting user from the VERIFIED JWT subject —
the body/query `sessionId` is ignored for identity, and if a supplied sessionId
resolves to a DIFFERENT user the request is rejected 403. When `required` is
false (or `auth` omitted) the behavior is identical to before (dev path resolves
identity from a live sessionId).

In `server/src/index.ts`, update the HR router construction to forward the auth
config (single added field; resolveSession unchanged):

```ts
app.use(
  "/api/hr",
  createHrRouter({
    attendance: container.attendance,
    hr: container.hr,
    auth: {
      jwt: container.authConfig.jwt,
      required: container.authConfig.authRequired,
    },
    resolveSession(sessionId): SessionUser | null {
      const room = container.registry.room;
      if (!room) return null;
      const p = room.listPlayers().find((pl) => pl.sessionId === sessionId);
      if (!p) return null;
      return { userId: p.userId, name: p.name, email: emailForName(p.name) };
    },
  }),
);
```

If you skip this edit: HR write routes stay on the open dev posture (matches
admin.routes.ts today). With the edit: under AUTH_REQUIRED=true a leaked/guessed
Colyseus sessionId can no longer check another user in/out — identity is the JWT.

Note: when OAuth provides a real email, the JWT path already uses the token's
own email/name (no dependency on the dev `emailForName` convention).

---

## 2. Rate limiter XFF spoofing (MAJOR) — set trustProxy only behind a real proxy

`server/src/http/rate-limit.ts`: `clientIp()` now takes a `trustProxy` flag and
the limiter accepts a `trustProxy` option (default FALSE). By default the limiter
keys off the real socket peer (`req.socket.remoteAddress`) and IGNORES the
client-supplied `X-Forwarded-For` — so an attacker can no longer mint a fresh
bucket per request by spoofing XFF. When you ARE behind a vetted reverse proxy,
opt in via env so XFF (via Express's parsed `req.ip`) is honored.

In `server/src/index.ts`, add Express trust-proxy config + pass `trustProxy`:

```ts
const trustProxy = process.env.TRUST_PROXY; // e.g. "1", "loopback", a CIDR, etc.
if (trustProxy) {
  // Accept Express's documented values: number of hops, "loopback", IP/CIDR list, or "true".
  app.set("trust proxy", trustProxy === "true" ? true : /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
}

app.use(
  "/api",
  createRateLimiter({
    capacity: Number(process.env.API_RATE_LIMIT ?? 60),
    windowMs: Number(process.env.API_RATE_WINDOW_MS ?? 60_000),
    trustProxy: Boolean(trustProxy),
  }),
);
```

If you skip the trustProxy edit: the limiter is now SAFER by default (ignores
XFF) but a legitimate proxy deployment would rate-limit all traffic under the
proxy's single IP. Setting TRUST_PROXY restores per-client limiting behind a
trusted proxy. The zero-config dev path is unaffected either way.

### .env.example addition

```bash
# Reverse-proxy trust (OPTIONAL). Only set when the server actually sits behind a
# vetted proxy/load balancer. Accepts an Express `trust proxy` value: number of
# hops (e.g. 1), "loopback", an IP/CIDR list, or "true". When set, the rate
# limiter honors X-Forwarded-For via Express's parsed req.ip; when unset, XFF is
# ignored and the limiter keys off the real socket address (anti-spoofing).
TRUST_PROXY=
```

---

## 3. JWT algorithm pinning (MAJOR) — no wiring needed

`server/src/auth/jwt.service.ts`: `sign()` now passes `algorithm: "HS256"` and
`verify()` passes `algorithms: ["HS256"]`. This rejects `alg:none` and any HMAC
variant other than HS256 (closing the HS512/HS384 acceptance and the latent
RS256->HS256 confusion footgun). No env/wiring changes; fully internal.

---

## Rejected finding

- OAuth state nonce single-use (MINOR): NOT applied. It is not "trivial +
  zero-risk" — `verifyState` is a pure, storage-free function consumed by
  auth.routes.ts; making it single-use requires introducing a stateful
  used-nonce store and threading it through the callback handler, which exceeds
  the "fix only if trivial + zero-risk" bar for minors. Existing protections
  (signed + 10-min TTL + timing-safe compare + single-use IdP code) already meet
  standard login-CSRF. Left for a dedicated change.
