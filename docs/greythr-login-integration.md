# greytHR as the Primary Login & Identity Source for PixelOffice

Status: **SHIPPED** (greytHR is the default sign-in when enabled). Date: 2026-06-07.
The sections below the implementation summary are the original design rationale, kept for
context. §0 records what was actually built and verified against the live greytHR ESS API
(`http://localhost:3000`).

> TL;DR — Replace the dev login card with a **"Sign in with greytHR"** flow backed by the
> self-hosted greytHR client (`/Users/djdiptayan/Documents/Developer/greytHR`). greytHR
> already knows the employee's name, department, designation, reporting manager, employee
> ID, and attendance — so a single login auto-populates the avatar's identity *and* powers
> the check-in/out and presence features with real data. Two constitutional rules
> (`no username/password auth`, `presence not surveillance`) constrain *how* we do this; the
> recommended design honors both.

---

## 0. Implementation status (as built)

greytHR sign-in is implemented and is the **sole** login when enabled. It is opt-in via env;
with the flag unset the zero-config dev login card is shown, unchanged.

### Flow (as shipped)
1. The login screen calls `GET /api/auth/config`. When it reports `greythr.enabled`, the
   card shows **only**: an avatar picker, **Employee No / Login ID**, **Password**, and a
   **Sign in with greytHR** button. The company **subdomain is autofilled** from
   `GREYTHR_SUBDOMAIN` — it is never shown. There is **no** display-name field, **no**
   department picker, and **no** guest “Enter Office” button.
2. The browser `POST`s `{ loginId, password }` (subdomain injected server-side) to
   **`POST /api/auth/greythr/login`** on the PixelOffice server.
3. The server forwards the credential **once, server-to-server** to the greytHR ESS client
   (`POST {GREYTHR_CLIENT_URL}/api/auth/login`), which performs the real Ory-Hydra
   OAuth2/OIDC + RSA-OAEP login. PixelOffice **never stores the password**; it keeps only
   the returned profile.
4. The server maps the greytHR `department` onto an office `Department` (alias table +
   fallback), upserts the user (`id = greythr:<employeeNo>`), and mints **our** JWT
   (`sub`, `email`, `name`, `role`, and an authoritative-default `department` claim).
5. The response is `{ token, profile }`. The client stores the token and joins the room
   with it via the existing `JwtAuthProvider` token path — **no new room/auth code**.
6. After joining, **double-clicking your own avatar** opens a profile modal (name,
   department dropdown, avatar) so a department mismatch is fixed in-app; the change is
   broadcast, persisted to the user record, and re-sent on reconnect.

### Env (PixelOffice side, distinct from the official-admin-API `GREYTHR_*` vars)
| Variable | Default | Purpose |
|---|---|---|
| `GREYTHR_LOGIN_ENABLED` | _(unset)_ | `true` enables “Sign in with greytHR”. |
| `GREYTHR_CLIENT_URL` | `http://localhost:3000` | Base URL of the self-hosted greytHR ESS client. |
| `GREYTHR_SUBDOMAIN` | _(empty)_ | Company subdomain, autofilled + forwarded (e.g. `kalvium`). |
| `GREYTHR_LOGIN_TIMEOUT_MS` | `8000` | Per-request timeout (login is slow). |

### Files
- `server/src/integrations/greythr/greythr-ess.client.ts` — adapter that isolates the ESS
  API (`login`, `getAccount`) behind the `GreytHrEssClient` interface; typed errors.
- `server/src/auth/greythr/department-map.ts` — pure greytHR→office department mapping.
- `server/src/auth/greythr/greythr-auth.service.ts` — framework-free orchestration
  (authenticate → map → upsert → mint JWT). Also exposes `loginWithSession(sessionId)`
  for the password-free hand-off path.
- `server/src/auth/greythr/greythr-auth.config.ts` — env gate.
- `server/src/http/auth.routes.ts` — `POST /greythr/login` + `/config` advertisement.
- `server/src/{container,index}.ts` — DI wiring (gated on env).
- `server/src/load-env.ts` — loads the repo-root `.env` (no dotenv dependency).
- `server/src/auth/jwt.service.ts` + `jwt-auth.provider.ts` — optional, signed
  `department` claim (client-chosen department still wins so manual fixes stick).
- Client: `client/src/ui/login.ts` (seamless form), `client/src/ui/profile.ts` (profile
  modal), `client/src/game/scene.ts` (double-click), `client/src/main.ts` (wiring).
- Tests: `department-map.test.ts`, `greythr-auth.service.test.ts`.

### Decisions vs. the original proposal
- **Password handling:** the **server-side proxy** option (§4.1) was chosen for one-form UX
  — PixelOffice forwards the password once to the ESS client and keeps only the JWT. The
  password-free **sessionId hand-off** is also implemented (`loginWithSession`) and can be
  switched to with no architecture change.
- **Department authority:** the JWT carries the greytHR department as the **initial**
  value, but the client’s (persisted, profile-modal-editable) department wins — so a manual
  “fix my mismatched department” sticks. Department is cosmetic (spawn zone + label), never
  a permission.

### ⚠ Known security finding (greytHR ESS side, not PixelOffice)
The greytHR ESS client (`SessionService.createSession`) **reuses a cached session for
`subdomain:loginId` before re-validating the password**. Once an employee has logged in
(cached ~45 days), a login with that `loginId` and **any** password succeeds. Because
employee numbers are guessable/sequential, this is an **auth-bypass risk for multi-user
login**. Fix belongs in the greytHR repo (re-validate credentials even when a session is
cached); until then prefer the sessionId hand-off, or run single-user only.

---

## 1. Why greytHR-as-login is the right call

The dev login asks the user to type a name, pick a department, and choose an avatar. None
of it is verified, none of it is real, and none of it connects to the rest of the company.
greytHR already holds the authoritative version of all of that, per employee:

- **Identity** — real name, employee no, email, mobile.
- **Org position** — designation, department, location, reporting manager, "is a manager".
- **Account** — company, plan, timezone, currency, roles/permissions.
- **Attendance** — signed-in/out right now, today's hours, shift, work location, history.

So one greytHR login means: the avatar spawns with your **real** name and department, the
attendance widget shows your **real** check-in state, and (once shift-marking lands) the
Check-In/Check-Out buttons drive your **real** greytHR attendance. It collapses three
separate things — auth, profile, attendance — into one source of truth.

This is also a clean fit for PixelOffice's architecture, which was *built* for pluggable
identity and HR behind interfaces (`AuthProvider`, `HrAdapter`). We are filling existing
seams, not bending the design.

---

## 2. What the greytHR client actually exposes (verified against the repo)

The greytHR client is a self-hosted Express/TypeScript service (default
`http://localhost:3000`) that logs in exactly as the browser does (Ory-Hydra OAuth2/OIDC +
RSA-OAEP password encryption), caches the session (AES-256-GCM, Redis, ~45-day TTL), and
returns a uniform envelope: `{ success, data, error }`.

### 2.1 Auth
| Method / Route | Returns |
|---|---|
| `POST /api/auth/login` `{ subdomain, loginId, password }` | `sessionId` (Bearer), `employeeId`, and full `account` profile |
| `POST /api/auth/logout` | tears down the greytHR session |

> Login identifier is the **Employee No / Login ID** (e.g. `KCC00896`), **not** an email.
> Password is sent plaintext to the greytHR client, which RSA-OAEP-encrypts it before
> forwarding; it is **never persisted** (held in memory only for the live client).

### 2.2 Account (`/api/account/*`, all require the Bearer `sessionId`)
| Route | Returns |
|---|---|
| `GET /me` | consolidated `AccountProfile` (the one we care about — see below) |
| `GET /employment` | reporting manager, department, location, company, tenure |
| `GET /personal-details` | basics, profile, education, addresses (flattened) |
| `GET /addresses` | contact / present / permanent / emergency addresses |
| `GET /login-status` | raw identity, roles, permissions, company, locale |
| `GET /profile` | raw employee-profile (designation/department/location categories) |
| `GET /personal` | raw personal payload |

**`AccountProfile` (from `GET /me` and the login response `account`):**
```
employeeId, employeeNo, loginId, name, email, mobile, dateOfBirth,
designation, department, location,
reportingManager, company, plan, timeZone, currency, onboardingStatus,
userId, isManager, roles[]
```

### 2.3 On-site data (`/api/data/*`, read-only, require the Bearer `sessionId`)
| Route | Returns |
|---|---|
| `GET /attendance/today` | `TodayAttendance` — see below |
| `GET /attendance/records?from=&to=` | per-day `{ date, firstIn, lastOut, productionMinutes, productionHours }` |
| `GET /attendance/swipes` | raw recent swipe log (`punchTime`, `inOutIndicator`, …) |
| `GET /attendance/period` | current attendance cycle (start/end dates) |
| `GET /attendance/day?date=` | per-day shift/session detail |
| `GET /attendance/calendar?month=&year=` | monthly P/A calendar |
| `GET /holidays` | holiday list |
| `GET /notifications` | notifications |
| `GET /payslip` | payslip dashlet status |
| `GET /dashboard` | home dashboard layout |

**`TodayAttendance` (the key object for presence + the attendance widget):**
```
date, shiftName, shiftStart, shiftEnd,
inOutIndicator (0 = signed-in, 1 = signed-out), signedIn (bool),
firstInTime, lastOutTime,              // IST clock strings, e.g. "09:52 AM"
workLocation,                          // "Office" | "Work from Home" | "Client Location" | "On-Duty"
hoursWorked (number), formattedDuration // e.g. "3h 18m (ongoing)"
```

### 2.4 Not yet available (important gaps)
- **Sign In / Sign Out (shift marking)** — the *write* action is **not implemented yet**
  (your note: landing Monday). Everything above is **read-only** today.
- **Tasks** — there is **no task endpoint** in the greytHR client. "See my tasks" cannot
  come from greytHR as it stands; it would need a separate source or a future endpoint.
  Flagged here so the scope is honest.

---

## 3. How this maps onto PixelOffice's existing seams

PixelOffice already has exactly the right boundaries. Nothing in the presence engine,
room, or HUD needs to learn that greytHR exists.

| PixelOffice seam | File | greytHR role |
|---|---|---|
| `AuthProvider.authenticate()` → `AuthenticatedUser` | `server/src/auth/auth-provider.ts` | **new** `GreytHrAuthProvider` resolves identity from a greytHR session |
| `HrAdapter` (lookup, dept sync, `checkIn`/`checkOut`) | `server/src/integrations/hr/hr-adapter.ts` | **new** `GreytHrEssAdapter` backs attendance with per-user ESS calls |
| `AttendanceService` state machine (explicit only) | `server/src/integrations/hr/attendance.service.ts` | unchanged — drives check-in/out; no auto actions |
| `CalendarAdapter` (presence → `IN_MEETING`) | `server/src/integrations/calendar/calendar-adapter.ts` | unchanged — Google/mock still own meetings |
| DI wiring (env-gated selection) | `server/src/container.ts` | choose greytHR auth/HR when configured, else dev/mock |

Note there are now **two** greytHR things, and they are different:

- The **existing** `GreytHrAdapter` uses greytHR's *official admin API* (api-user/api-key,
  `Access-Token` header). It needs an **admin-provisioned key** and is org-wide.
- Your repo is a **per-employee ESS client** (the employee's own credentials, no admin
  key). For login + a single user's own attendance, **your repo is the better fit** — it
  needs no admin key and returns far richer per-user data.

This proposal uses **your ESS client** for both auth and (per-user) attendance.

---

## 4. The two constitutional constraints (and how we satisfy them)

PixelOffice's constitution (`CLAUDE.md`, `plan.md`) has two rules this touches. Both can be
honored; calling them out explicitly so the choices are deliberate.

### 4.1 "No custom username/password auth"
> *"No custom username/password auth. Dev login is an OAuth stand-in behind the
> `AuthProvider` interface."*

greytHR login is, on its face, login-ID + password. The rule exists to stop **PixelOffice**
from collecting and handling raw passwords. Two ways to comply:

- **Recommended — sessionId hand-off (PixelOffice never sees a password).** The user
  authenticates against the greytHR client directly (it owns the password, RSA-OAEP, and
  the OAuth2/OIDC dance). PixelOffice receives only the **`sessionId`** (an opaque Bearer
  token) and calls `GET /api/account/me` with it to resolve identity. greytHR effectively
  becomes a **federated IdP** — which, under the hood, it literally is. This keeps
  PixelOffice password-free and is the most faithful reading of the rule.
- **Acceptable-with-eyes-open — password proxied once at login.** PixelOffice's login form
  collects credentials and forwards them server-to-server to the greytHR client's
  `POST /api/auth/login`, then keeps only the returned `sessionId`. Simpler UX (one form),
  but PixelOffice momentarily handles the password in transit. This is a conscious
  deviation from the rule; do it only if the one-form UX is judged worth it, and never log
  or persist the password.

**Recommendation: sessionId hand-off.** It satisfies the rule cleanly and mirrors the
existing OAuth pattern (identity comes from an external provider; we mint our own JWT after).

### 4.2 "Presence, not surveillance — no productivity scoring"
> *"Presence, not surveillance: no keystroke/mouse/screenshot tracking, no productivity
> scoring."*

You asked for "track how much I'm working" and "how many hours I've worked." There is a
bright line here:

- ✅ **In bounds:** showing **your own** attendance to **yourself** — today's check-in time,
  signed-in/out state, hours worked so far, shift, work location. This is your own greytHR
  data, the same thing the greytHR portal already shows you. Surfacing it in your own HUD is
  self-service, not surveillance.
- ✅ **In bounds:** a coarse presence signal derived from attendance, e.g. greytHR
  `signedIn === false` → the office shows you as `OFFLINE`/`AWAY` (same category as "not at
  desk"). This is presence, not a metric.
- ❌ **Out of bounds:** displaying *other people's* hours worked, ranking/scoring users by
  hours, manager dashboards of subordinate work-time, or any "productivity" number. That
  directly violates the constitution and must not be built.

**Recommendation: work-hours are self-view only.** Hours worked, history, and swipe logs
render in *your own* widget and are never broadcast to other players or aggregated into a
score. Presence states never encode "how hard someone is working."

---

## 5. Proposed login flow (sessionId hand-off)

```
┌────────┐   1. open office          ┌──────────────┐
│ Browser│ ────────────────────────▶ │ PixelOffice  │
│ (client)│                          │  client UI   │
└────────┘                           └──────────────┘
     │  2. "Sign in with greytHR" → enter loginId + password
     │     (posted to the greytHR client, NOT to PixelOffice)
     ▼
┌──────────────────────────┐  3. OAuth2/OIDC + RSA-OAEP login   ┌───────────┐
│ greytHR client :3000     │ ─────────────────────────────────▶│  greytHR  │
│ POST /api/auth/login     │ ◀───────────────────────────────── │  (ESS)    │
└──────────────────────────┘   sessionId + account profile      └───────────┘
     │  4. returns { sessionId, account }
     ▼
┌────────┐  5. join office with sessionId   ┌──────────────────────────┐
│ Browser│ ───────────────────────────────▶ │ PixelOffice server       │
└────────┘                                  │ GreytHrAuthProvider:     │
                                            │  GET /account/me (Bearer)│
                                            │  → map → AuthenticatedUser│
                                            │  → mint PixelOffice JWT   │
                                            └──────────────────────────┘
```

Steps 6+ are unchanged from today: the JWT is the office session token, the room spawns the
avatar from `AuthenticatedUser`, presence/attendance services run as they already do.

`GreytHrAuthProvider.authenticate(options)` receives `{ greytHrSessionId, avatarId }`,
calls `GET /api/account/me`, and returns:

| `AuthenticatedUser` field | Source from greytHR `account` |
|---|---|
| `userId` | `employeeNo` (stable, e.g. `KCC00896`) — used as the stable identity for calendar/HR seams |
| `name` | `name` |
| `department` | `department` → mapped onto office `DEPARTMENTS` (see §6) |
| `avatarId` | user's pick at the login screen (greytHR has no avatar) |

Extra greytHR fields (designation, reportingManager, isManager, location, company, roles)
are carried alongside for display (e.g. nameplate "Senior Engineer · reports to Jane").

---

## 6. Department mapping

greytHR department strings are free-form and may not equal the office `DEPARTMENTS` enum.
Reuse the existing `DepartmentMapping` concept (`hr-adapter.ts`):

- Exact/case-insensitive match → use it.
- Known aliases (e.g. "Engg" → "Engineering") → small lookup table.
- No confident match → fall back to `DEFAULT_DEPARTMENT` (`Engineering`) and log at debug.

Never block login on an unmapped department; degrade to the default.

---

## 7. Attendance & check-in/out

- **Today / read state (available now):** `GET /api/data/attendance/today` →
  `TodayAttendance`. The attendance widget shows `signedIn`, `firstInTime`,
  `formattedDuration`, `shiftName`, `workLocation`. Self-view only (§4.2).
- **Check-In / Check-Out actions (pending Monday):** once shift-marking exists in the
  greytHR client, wire it behind `GreytHrEssAdapter.checkIn()/checkOut()`. The existing
  `AttendanceService` already enforces the constitution: **explicit user clicks only**, no
  timers, no auto check-in/out, no session-lifecycle hooks. The state machine
  (`NOT_CHECKED_IN → CHECKED_IN → CHECKED_OUT`) is unchanged; only the adapter behind it
  becomes real.
- **Presence link:** optionally map greytHR `signedIn === false` → office `OFFLINE`/`AWAY`.
  Keep this advisory; the user's explicit in-office movement still governs live presence.

Until Monday, ship the **read-only** attendance widget and keep the Check-In/Check-Out
buttons backed by the mock (or hidden) so nothing claims to write when it can't.

---

## 8. Configuration & wiring (described, not implemented)

Mirror the existing env-gated pattern in `container.ts`. Proposed new env vars:

| Variable | Purpose |
|---|---|
| `GREYTHR_CLIENT_URL` | base URL of the greytHR client (e.g. `http://localhost:3000`) |
| `GREYTHR_SUBDOMAIN` | company subdomain (e.g. `kalvium`) for the login form default |
| `GREYTHR_LOGIN_ENABLED` | `true` to swap the dev login card for the greytHR login |

Selection logic (same spirit as Google/official-GreytHR gates):

- `GREYTHR_LOGIN_ENABLED=true` **and** `GREYTHR_CLIENT_URL` reachable →
  `GreytHrAuthProvider` (+ `GreytHrEssAdapter` for attendance).
- Otherwise → existing `DevAuthProvider` + mock HR (zero-config path **untouched**).

**Graceful degradation (Principle 4):** if the greytHR client is down or returns an error,
PixelOffice must fall back to dev login and a mock attendance widget rather than blocking
entry. Wrap every greytHR call in try/catch at the adapter boundary, exactly like the
existing adapters do.

---

## 9. Multi-user, sessions, and security notes

- **Multi-user:** use the greytHR client's **token mode** — each player logs in and gets
  their own `sessionId`. (The env single-user mode is only for your solo testing.)
- **Session lifetime:** the greytHR client caches sessions ~45 days (Redis, encrypted), so
  re-login is rare. PixelOffice still mints its own JWT (`JWT_EXPIRES_IN`, default 12h) as
  the office session; the greytHR `sessionId` is only needed at auth time and for live
  attendance reads.
- **Stable identity:** key calendar/HR seams on `employeeNo` (stable across reconnects),
  never on the Colyseus sessionId.
- **Secrets:** PixelOffice should store the greytHR `sessionId` server-side per office
  session (not in the browser long-term), and never log it. With the recommended
  hand-off, PixelOffice never touches the password at all.
- **Localhost today, server later:** the greytHR client currently runs on localhost; your
  README says it deploys to a server with no code changes. PixelOffice calls it
  server-to-server, so moving it later is just a `GREYTHR_CLIENT_URL` change.

---

## 10. Open questions / decisions for you

1. **Password handling:** sessionId hand-off (recommended, rule-compliant) vs. one-form
   password proxy (simpler UX, conscious rule deviation)? — see §4.1.
2. **greytHR as the *sole* login, or an additional option?** Sole login means no dev card in
   that deployment; keeping dev login as a fallback is friendlier for local dev/testing.
   Recommendation: greytHR primary, dev login retained behind the env gate for dev.
3. **Presence from attendance:** should greytHR `signedIn=false` force `OFFLINE`, or stay
   purely informational in the widget? — see §7.
4. **Tasks:** out of scope for greytHR (no endpoint). Defer, or source elsewhere later?
5. **Avatar:** keep the avatar picker at the greytHR login screen (greytHR has no avatar),
   or derive a default avatar from department?

---

## 11. Phased implementation checklist (when approved)

1. **[S]** `GreytHrAuthProvider implements AuthProvider` — calls `GET /account/me` with a
   passed `sessionId`, maps `account` → `AuthenticatedUser`, reuses `DepartmentMapping`.
2. **[S]** Client login UI: "Sign in with greytHR" → greytHR client `POST /auth/login` →
   carry `sessionId` into the office join (hand-off model).
3. **[S]** `container.ts` env gate + graceful fallback to dev login.
4. **[M]** `GreytHrEssAdapter implements HrAdapter` — read-only attendance now
   (`/attendance/today`, `/records`), behind try/catch.
5. **[M]** Attendance widget shows real `TodayAttendance` (self-view only).
6. **[M]** When shift-marking lands (Monday): implement `checkIn/checkOut` in the adapter;
   `AttendanceService` already handles the rest (explicit-only).
7. **[S]** Tests: provider mapping, department fallback, graceful degradation when the
   greytHR client is unreachable, attendance state transitions (per the engineering rules).

`[S]` small, `[M]` medium. Each step is independently shippable behind the env gate; the
zero-config dev experience stays intact throughout.

---

## 12. Summary

greytHR-as-login is architecturally natural for PixelOffice — it slots into the existing
`AuthProvider` and `HrAdapter` seams and turns a fake identity into a real, synced one. The
only real constraints are constitutional, and both are satisfiable: take a **sessionId, not
a password** (honors "no username/password auth"), and keep **work-hours self-view only,
never a score** (honors "presence, not surveillance"). With those two guardrails, one
greytHR login gives every avatar a real name, department, manager, and live attendance —
exactly the richer context you're after.
