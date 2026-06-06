# NOTES-hr — GreytHR / Attendance wiring (for the INTEGRATOR)

Owner: HR BUILDER (plan task #11). All files below are complete + unit-tested.
Nothing here changes the zero-config path: with NO env vars set, the MockGreytHr
adapter is used and the office behaves exactly as before. Everything real is
opt-in via env.

## Files added (my scope — do not need edits)

- `server/src/integrations/hr/hr-adapter.ts` — `HrAdapter` interface + types
  (`EmployeeRecord`, `AttendanceResult`, `DepartmentMapping`, `HrAdapterError`).
- `server/src/integrations/hr/mock-greythr.adapter.ts` — default in-memory impl
  (seeds fake employees; exports `emailForName(name)` dev-email convention).
- `server/src/integrations/hr/greythr.adapter.ts` — real REST impl (fetch + 5s
  AbortController timeout + typed errors). Inject-able `fetchFn` for tests.
- `server/src/integrations/hr/attendance.service.ts` — framework-free state
  machine (`AttendanceService`), `EventEmitter` "attendance" {userId, status}.
- `server/src/integrations/hr/attendance.service.test.ts` — full state coverage.
- `server/src/integrations/hr/greythr.adapter.test.ts` — adapter mapping/errors.
- `server/src/http/hr.routes.ts` — `createHrRouter(deps)` factory (DI; no
  container import).
- `client/src/ui/attendance.ts` — `mountAttendance(container, opts)` HUD widget.

`npx vitest run server/src/integrations/hr` → 23 passing.

## 1. Container DI (server/src/container.ts) — pick adapter by env

Add near the calendar wiring:

```ts
import type { HrAdapter } from "./integrations/hr/hr-adapter";
import { MockGreytHrAdapter } from "./integrations/hr/mock-greythr.adapter";
import { GreytHrAdapter } from "./integrations/hr/greythr.adapter";
import { AttendanceService } from "./integrations/hr/attendance.service";

// Real GreytHR ONLY when both env vars are present; else the mock (zero-config).
const hr: HrAdapter =
  process.env.GREYTHR_BASE_URL && process.env.GREYTHR_API_TOKEN
    ? new GreytHrAdapter({
        baseUrl: process.env.GREYTHR_BASE_URL,
        apiToken: process.env.GREYTHR_API_TOKEN,
        // optional: timeoutMs: Number(process.env.GREYTHR_TIMEOUT_MS) || 5000,
      })
    : new MockGreytHrAdapter();

const attendance = new AttendanceService(hr);
```

Add `hr` and `attendance` to the exported `container` object.

Optional: drop a user's attendance state on disconnect. In
`OfficeRoom.onLeave` you may call `container.attendance.forget(userId)` — but it
is NOT required and is NOT a forbidden auto-action (it only clears local state,
it does not check anyone out). Leaving it out is fine.

## 2. Mount the HR router (server/src/index.ts)

Build the router with DI and mount it under `/api/hr`. The session→user resolver
maps a live Colyseus sessionId to the user behind it (so the client can never
act for someone else). Use the room's player list:

```ts
import { createHrRouter, type SessionUser } from "./http/hr.routes";
import { emailForName } from "./integrations/hr/mock-greythr.adapter";

app.use(
  "/api/hr",
  createHrRouter({
    attendance: container.attendance,
    hr: container.hr,
    resolveSession(sessionId): SessionUser | null {
      const room = container.registry.room;
      if (!room) return null;
      const p = room.listPlayers().find((pl) => pl.sessionId === sessionId);
      if (!p) return null;
      // No real OAuth email yet -> derive dev email so the mock yields hits.
      // When OAuth lands, replace with the user's real email from the profile.
      return { userId: p.userId, name: p.name, email: emailForName(p.name) };
    },
  }),
);
```

`listPlayers()` already exists on `OfficeRoom` (used by admin.routes.ts). The
`PlayerSnapshot` has `userId` + `name` but no email; the dev-email convention
bridges that for the mock until OAuth provides a real email.

## 3. Mount the widget in the HUD (client/src/main.ts or client/src/ui/hud.ts)

Import and mount once after WELCOME, into any HUD container (e.g. the sidebar).
It self-hides if `/api/hr/status` 404s/errors, so it is safe to always mount:

```ts
import { mountAttendance } from "./ui/attendance";
import { serverHttpBase } from "./net/connection"; // existing helper

mountAttendance(sidebarEl, {
  fetchBase: serverHttpBase(), // e.g. "http://localhost:2567"
  getSessionId: () => conn.sessionId,
});
```

`serverHttpBase` is what admin.ts already uses; pass the same base. The widget
queries `${base}/api/hr/status?sessionId=...` on mount.

## 4. Styles to add to client/src/styles.css

The widget reuses existing `.hud-panel` / `.hud-panel-title`. Add these new
classes (colors are set inline by the widget for the status dot; the rest is
layout):

```css
.attendance-widget { display: flex; flex-direction: column; gap: 8px; }
.attendance-status { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.attendance-dot { width: 10px; height: 10px; border-radius: 50%; background: #9aa3ad; }
.attendance-actions { display: flex; gap: 8px; }
.attendance-btn {
  flex: 1; padding: 6px 8px; cursor: pointer; font: inherit;
  border: 1px solid #3a424d; border-radius: 4px; background: #20262e; color: #e6e9ee;
}
.attendance-btn:disabled { opacity: 0.45; cursor: default; }
.attendance-btn.is-current { border-color: #3ecf6e; }
.attendance-feedback { min-height: 14px; font-size: 12px; }
.attendance-feedback[data-kind="ok"] { color: #3ecf6e; }
.attendance-feedback[data-kind="error"] { color: #e5544b; }
```

(Inline styles also work — the widget already sets the dot color inline; these
classes are only for polish.)

## 5. Env vars (add to .env.example)

```bash
# GreytHR (OPTIONAL). Set BOTH to activate the real adapter; otherwise the
# in-memory mock is used and the office still works (integrations are optional).
GREYTHR_BASE_URL=          # e.g. https://api.greythr.com
GREYTHR_API_TOKEN=         # bearer token
# GREYTHR_TIMEOUT_MS=5000  # optional per-request timeout (default 5000)
```

No deps to add — the real adapter uses the built-in global `fetch` (Node 22).

## 6. REST endpoints exposed (under /api/hr)

- `POST /api/hr/check-in`  body `{ sessionId }` → `{ ok, status, recordedAtMs, reason? }`
- `POST /api/hr/check-out` body `{ sessionId }` → same shape
- `GET  /api/hr/status?sessionId=` → `{ userId, status, lastActionAtMs }` (404 if
  HR absent / session unknown — the widget hides on 404)
- `GET  /api/hr/employee?email=` → `{ employee }` (404 not found, 503 if lookup
  unavailable — never a hard 500)

`ok:false` actions return HTTP 502 with a `reason`; the office is unaffected.

## 7. Forbidden behaviors honored (plan.md "GreytHR Integration Rules")

ALLOWED implemented: employee lookup (`/employee`, `HrAdapter.lookupEmployee`),
department sync (`HrAdapter.syncDepartments` → `DepartmentMapping[]`), attendance
ACTIONS (`/check-in`, `/check-out`).

FORBIDDEN — structurally impossible in this code:
- NO auto-check-in: the only callers of `AttendanceService.checkIn` are the
  `/api/hr/check-in` route (explicit button POST). No timer/tick calls it.
- NO auto-check-out: same — only `/api/hr/check-out` (explicit button) calls
  `AttendanceService.checkOut`. There is no scheduler/idle hook in this module.
- NO auto-logout: the HR module never touches sessions, sockets, or the room
  lifecycle. `forget(userId)` only clears local attendance state and is optional.
- NO surveillance: no activity/keystroke/mouse tracking; the service holds only
  an explicit-action status + the timestamp of the last explicit action.

Graceful degradation: every adapter call is wrapped; failures return
`{ ok:false, reason }` and never throw out of the service or the routes, so a
dead/fake GreytHR config leaves the office fully functional.
