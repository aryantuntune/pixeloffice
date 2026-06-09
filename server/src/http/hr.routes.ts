// ---------------------------------------------------------------------------
// HR (GreytHR) REST API. Mounted at /api/hr by the integrator.
//
// HUMAN-AGENCY (plan.md GreytHR rules): every attendance endpoint here is the
// server-side landing point for an EXPLICIT user button click. There is no
// endpoint, timer, or hook that checks a user in/out automatically.
//
// SECURITY — identity is derived server-side, NEVER from a client-asserted id:
//   * When auth is REQUIRED (AUTH_REQUIRED=true) the acting user is taken from
//     the verified JWT (Authorization: Bearer <jwt>) — specifically the token
//     subject (res.locals.session.sub) and its email/name claims. A body- or
//     query-supplied `sessionId` is IGNORED for identity; if present and it does
//     not resolve to the SAME user as the token, the request is rejected (403).
//     This closes the IDOR where a leaked/guessed Colyseus sessionId (which is
//     broadcast to all clients in the wire protocol) let one user check ANOTHER
//     user in/out of real GreytHR attendance.
//   * On the zero-config dev path (AUTH_REQUIRED unset) there is no JWT, so the
//     acting user is still resolved from a live Colyseus sessionId — but this
//     path is the same "open dev console" posture as admin.routes.ts and the
//     real-GreytHR write side is gated behind AUTH_REQUIRED in production.
//
// DEPENDENCY INJECTION: the router is built from explicit dependencies (the
// attendance service, the HR adapter, a session->user resolver, and the auth
// gate) rather than importing the container directly. See notes/NOTES-hr.md.
// ---------------------------------------------------------------------------

import { Router, type Request, type Response } from "express";
import type { AttendanceService, AttendanceStatus } from "../integrations/hr/attendance.service";
import type { AttendanceMarkOptions, HrAdapter } from "../integrations/hr/hr-adapter";
import type { JwtService } from "../auth/jwt.service";
import { requireAuth, sessionOf } from "../auth/middleware";

/** The minimal user identity the HR routes need from a live session. */
export interface SessionUser {
  userId: string;
  name: string;
  /** Best-effort email for HR lookup (dev convention if no real OAuth email). */
  email: string;
}

export interface HrRouterDeps {
  attendance: AttendanceService;
  hr: HrAdapter;
  /**
   * Resolve a live sessionId to the user behind it, or null if unknown/offline.
   * The integrator implements this against the OfficeRoom's player list. Used
   * ONLY on the dev path (auth not required) and, when auth IS required, ONLY to
   * cross-check that any supplied sessionId belongs to the authenticated user.
   */
  resolveSession(sessionId: string): SessionUser | null;
  /**
   * Auth gate. When `required` is true the JWT service authenticates every
   * attendance route and the acting user is derived from the verified token.
   * When false (zero-config dev) the routes resolve identity from a live
   * sessionId, matching the open dev-console posture of admin.routes.ts.
   */
  auth?: {
    jwt: JwtService;
    required: boolean;
  };
  /**
   * When true (the REAL GreytHR adapter is active), pass the acting user's email
   * to the attendance service so it resolves the GreytHR employee CODE to swipe
   * against (the office userId is NOT an employee code). With the mock adapter
   * this is false: the mock ignores the id, and synthetic dev emails would not
   * resolve to a seeded employee, so we keep the userId pass-through.
   */
  resolveEmployeeByEmail?: boolean;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
  /**
   * The greytHR ESS portal URL to surface in the attendance widget (an "Open
   * greytHR" deep link). Present ONLY when the real GreytHR integration is
   * configured; absent (undefined) on the mock/dev path so the client hides the
   * link. Built by the integrator from GREYTHR_PORTAL_URL.
   */
  portalUrl?: string;
}

export function createHrRouter(deps: HrRouterDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => Date.now());
  const authRequired = deps.auth?.required === true;

  // When auth is required, every attendance route must carry a valid JWT. The
  // requireAuth middleware attaches the verified session to res.locals.session;
  // the handlers below derive identity from it, never from the request body.
  if (authRequired && deps.auth) {
    const guard = requireAuth(deps.auth.jwt);
    router.post("/check-in", guard);
    router.post("/check-out", guard);
    router.get("/status", guard);
  }

  // POST /api/hr/check-in -------------------------------------------------
  router.post("/check-in", async (req: Request, res: Response) => {
    const user = resolveActingUser(req, res, deps, authRequired);
    if (!user) return;
    const email = deps.resolveEmployeeByEmail ? user.email : undefined;
    const result = await deps.attendance.checkIn(user.userId, now(), email, readMarkOptions(req));
    res.status(result.ok ? 200 : 502).json({
      ok: result.ok,
      status: result.status,
      recordedAtMs: result.recordedAtMs,
      ...(result.reason ? { reason: result.reason } : {}),
    });
  });

  // POST /api/hr/check-out ------------------------------------------------
  router.post("/check-out", async (req: Request, res: Response) => {
    const user = resolveActingUser(req, res, deps, authRequired);
    if (!user) return;
    const email = deps.resolveEmployeeByEmail ? user.email : undefined;
    const result = await deps.attendance.checkOut(user.userId, now(), email, readMarkOptions(req));
    res.status(result.ok ? 200 : 502).json({
      ok: result.ok,
      status: result.status,
      recordedAtMs: result.recordedAtMs,
      ...(result.reason ? { reason: result.reason } : {}),
    });
  });

  // GET /api/hr/status — live status, reconciled with greytHR (404 => widget hides).
  router.get("/status", async (req: Request, res: Response) => {
    const user = resolveActingUser(req, res, deps, authRequired);
    if (!user) return;
    const email = deps.resolveEmployeeByEmail ? user.email : undefined;
    const view = await deps.attendance.describeStatus(user.userId, email);
    const status: AttendanceStatus = view.status;
    // greytHR connection signal: computed AFTER describeStatus, because that read
    // is what detects an expired session (a 401 there drops the dead session).
    // Only meaningful for greytHR identities (sub === "greythr:<no>"); omitted
    // for OAuth/dev users so the client never shows a useless reconnect prompt.
    const greytHrCapable = user.userId.startsWith("greythr:");
    const connected =
      greytHrCapable && deps.hr.isConnected ? deps.hr.isConnected(user.userId) : undefined;
    res.json({
      userId: user.userId,
      status,
      lastActionAtMs: view.lastActionAtMs,
      // When false, the greytHR session expired/was wiped and the widget shows a
      // one-click "Reconnect" prompt (no logout). Absent for non-greytHR users.
      ...(typeof connected === "boolean" ? { greythrConnected: connected } : {}),
      // WHEN the user checked in / out, sourced from the attendance service's
      // adapter-recorded timestamps (greytHR's accepted swipe time on the real
      // path; mock clock on dev). Absent when unknown so the widget hides the
      // corresponding line. The widget renders e.g. "Checked in at 9:42 AM".
      ...(view.lastCheckInMs != null ? { lastCheckInMs: view.lastCheckInMs } : {}),
      ...(view.lastCheckOutMs != null ? { lastCheckOutMs: view.lastCheckOutMs } : {}),
      // greytHR work location, shift, and the check-in location-picker data.
      ...(view.remote?.workLocation ? { workLocation: view.remote.workLocation } : {}),
      ...(view.remote?.shiftName ? { shiftName: view.remote.shiftName } : {}),
      ...(view.remote?.allowLocationSelection ? { allowLocationSelection: true } : {}),
      ...(view.remote && view.remote.locations.length > 0
        ? { locations: view.remote.locations }
        : {}),
      ...(view.remote?.workLocationId != null ? { workLocationId: view.remote.workLocationId } : {}),
      // Only present when the real GreytHR integration is configured; the widget
      // renders an "Open greytHR" deep link iff this is present.
      ...(deps.portalUrl ? { portalUrl: deps.portalUrl } : {}),
    });
  });

  // GET /api/hr/employee?email= -------------------------------------------
  router.get("/employee", async (req: Request, res: Response) => {
    const email = typeof req.query.email === "string" ? req.query.email.trim() : "";
    if (!email) {
      res.status(400).json({ error: "email is required" });
      return;
    }
    try {
      const employee = await deps.hr.lookupEmployee(email);
      if (!employee) {
        res.status(404).json({ error: "Employee not found" });
        return;
      }
      res.json({ employee });
    } catch (err) {
      // Integration optional: never 500 hard — degrade gracefully.
      res.status(503).json({
        error: "HR lookup unavailable",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}

/**
 * Resolve the user who is performing this attendance action.
 *
 * Auth REQUIRED: identity comes from the verified JWT (already attached by
 * requireAuth). Any sessionId supplied in the body/query is treated as a hint
 * only — it is NOT used to pick the user, and if it resolves to a DIFFERENT
 * user the request is rejected (403). This makes the IDOR impossible.
 *
 * Auth NOT required (dev): identity comes from a live Colyseus sessionId, as in
 * the original open dev-console posture. Responds 400/404 and returns null on
 * failure.
 */
function resolveActingUser(
  req: Request,
  res: Response,
  deps: HrRouterDeps,
  authRequired: boolean,
): SessionUser | null {
  if (authRequired) {
    const session = sessionOf(res);
    if (!session) {
      // requireAuth should have produced a 401 already; defensive guard.
      res.status(401).json({ error: "Authentication required" });
      return null;
    }
    const tokenUser: SessionUser = {
      userId: session.sub,
      name: session.name,
      email: session.email,
    };
    // If the client also supplied a sessionId, it MUST belong to the same user
    // as the token — reject impersonation attempts outright.
    const claimed = suppliedSessionId(req);
    if (claimed) {
      const resolved = deps.resolveSession(claimed);
      if (resolved && resolved.userId !== tokenUser.userId) {
        res.status(403).json({ error: "Session does not belong to the authenticated user" });
        return null;
      }
    }
    return tokenUser;
  }

  // Dev path: resolve from the live session id.
  const sessionId = suppliedSessionId(req);
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return null;
  }
  const user = deps.resolveSession(sessionId);
  if (!user) {
    res.status(404).json({ error: "Unknown session" });
    return null;
  }
  return user;
}

/** Read the chosen work-location options (attLocation/location/remarks) from a body. */
function readMarkOptions(req: Request): AttendanceMarkOptions {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const opts: AttendanceMarkOptions = {};
  if (typeof body.attLocation === "number" && Number.isFinite(body.attLocation)) {
    opts.attLocation = body.attLocation;
  }
  if (typeof body.location === "string" && body.location.trim() !== "") {
    opts.location = body.location.trim();
  }
  if (typeof body.remarks === "string" && body.remarks !== "") opts.remarks = body.remarks;
  return opts;
}

/** Read a sessionId from the JSON body (writes) or the query string (status). */
function suppliedSessionId(req: Request): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.sessionId === "string" && body.sessionId.length > 0) {
    return body.sessionId;
  }
  if (typeof req.query.sessionId === "string" && req.query.sessionId.length > 0) {
    return req.query.sessionId;
  }
  return "";
}
