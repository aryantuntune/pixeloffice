// ---------------------------------------------------------------------------
// Attendance service — framework-free per-user attendance state machine that
// delegates to the HrAdapter.
//
// State machine (re-check-in allowed):
//
//     NOT_CHECKED_IN ──checkIn──> CHECKED_IN ──checkOut──> CHECKED_OUT
//            ^                         |                        |
//            |                      checkIn (idempotent)     checkIn (re-check-in)
//            |                         |                        |
//            └─────────────────────────┴────────────────────────┘ -> CHECKED_IN
//
// HUMAN-AGENCY / NON-SURVEILLANCE (plan.md "GreytHR Integration Rules"):
//   "All attendance actions must be explicit."  FORBIDDEN: auto-check-in,
//   auto-check-out, auto-logout. Therefore EVERY transition in this service is
//   triggered ONLY by checkIn()/checkOut(), which are called ONLY from the HR
//   REST routes in direct response to a user clicking a button. This service
//   contains NO timers, NO activity tracking, and NO session lifecycle hooks —
//   nothing can advance the machine on the user's behalf.
//
// GRACEFUL DEGRADATION (plan Principle 4): adapter calls are wrapped so a
// failure NEVER throws out of the service. On failure we return {ok:false} with
// a reason and DO NOT mutate the user's local state — the office is unaffected.
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";
import type { AttendanceResult, HrAdapter } from "./hr-adapter";

export type AttendanceStatus = "NOT_CHECKED_IN" | "CHECKED_IN" | "CHECKED_OUT";

export interface AttendanceState {
  userId: string;
  status: AttendanceStatus;
  /** Epoch ms of the last successful attendance action, or null. */
  lastActionAtMs: number | null;
  /**
   * Epoch ms of the last successful CHECK-IN, sourced from the ADAPTER result's
   * `recordedAtMs`. On the real GreytHR path this is greytHR's accepted swipe
   * time (the authoritative "when you checked in"); on the dev/mock path it is
   * the mock's echoed server clock. null until the user has ever checked in.
   *
   * Sourced from the adapter result rather than greythr.adapter.ts's swipe
   * history because that history query is tenant-specific and not reliably
   * available; the timestamp GreytHR returns when it ACCEPTS our swipe is the
   * reliable source. (See the "do not touch greythr.adapter.ts" note.)
   */
  lastCheckInMs: number | null;
  /** Epoch ms of the last successful CHECK-OUT (adapter `recordedAtMs`), or null. */
  lastCheckOutMs: number | null;
}

/** Payload emitted on the "attendance" event after a successful transition. */
export interface AttendanceChange {
  userId: string;
  status: AttendanceStatus;
}

/**
 * Emits:
 *   "attendance" (change: AttendanceChange) — after a SUCCESSFUL check-in/out.
 *
 * Failures are NOT emitted (no state changed) — they are returned to the caller.
 */
export class AttendanceService extends EventEmitter {
  private readonly states = new Map<string, AttendanceState>();
  /** Cache: office user email -> resolved GreytHR employee id (or null miss). */
  private readonly employeeIdByEmail = new Map<string, string | null>();

  constructor(private readonly hr: HrAdapter) {
    super();
  }

  /** Current attendance state for a user (NOT_CHECKED_IN if never acted). */
  getState(userId: string): AttendanceState {
    return (
      this.states.get(userId) ?? {
        userId,
        status: "NOT_CHECKED_IN",
        lastActionAtMs: null,
        lastCheckInMs: null,
        lastCheckOutMs: null,
      }
    );
  }

  /**
   * EXPLICIT user-initiated check-in. The ONLY caller is the /api/hr/check-in
   * route, invoked by a button click. Allowed from any state (re-check-in from
   * CHECKED_OUT; idempotent if already CHECKED_IN — still records the action).
   */
  async checkIn(userId: string, atMs: number, email?: string): Promise<AttendanceResult> {
    const employeeId = await this.resolveEmployeeId(userId, email, atMs);
    if (typeof employeeId !== "string") return employeeId; // resolution failed
    const result = await this.safe(() => this.hr.checkIn(employeeId, atMs), atMs, "CHECKED_IN");
    if (result.ok) this.commit(userId, "CHECKED_IN", result.recordedAtMs);
    return result;
  }

  /**
   * EXPLICIT user-initiated check-out. The ONLY caller is the /api/hr/check-out
   * route, invoked by a button click.
   */
  async checkOut(userId: string, atMs: number, email?: string): Promise<AttendanceResult> {
    // Guard: checking out when not checked in is a no-op state-wise, but we
    // still honor the explicit action by delegating; the adapter decides.
    const employeeId = await this.resolveEmployeeId(userId, email, atMs);
    if (typeof employeeId !== "string") return employeeId; // resolution failed
    const result = await this.safe(() => this.hr.checkOut(employeeId, atMs), atMs, "CHECKED_OUT");
    if (result.ok) this.commit(userId, "CHECKED_OUT", result.recordedAtMs);
    return result;
  }

  /** Drop a user's local attendance state (e.g. on disconnect). NOT an action. */
  forget(userId: string): void {
    this.states.delete(userId);
  }

  // --- private --------------------------------------------------------------

  /**
   * Resolve the GreytHR EMPLOYEE id to swipe against. The office userId
   * (`dev:<slug>:<rand>` or an IdP subject) is NOT a GreytHR employee code, so
   * when an `email` is supplied we look the employee up and swipe against the
   * returned id (cached per email). Returns the employee id on success, or a
   * graceful {ok:false} AttendanceResult when the lookup yields no employee.
   *
   * When no email is supplied (mock/dev convenience and unit tests), the userId
   * is passed through unchanged — the mock adapter ignores the id anyway.
   */
  private async resolveEmployeeId(
    userId: string,
    email: string | undefined,
    atMs: number,
  ): Promise<string | AttendanceResult> {
    if (!email) return userId;

    const key = email.toLowerCase();
    let employeeId = this.employeeIdByEmail.get(key);
    if (employeeId === undefined) {
      try {
        const employee = await this.hr.lookupEmployee(email);
        employeeId = employee && employee.id ? employee.id : null;
      } catch {
        employeeId = null; // lookup failed; treat as a miss this call (don't cache)
        return {
          ok: false,
          recordedAtMs: atMs,
          status: "CHECKED_IN",
          reason: "HR employee lookup unavailable",
        };
      }
      this.employeeIdByEmail.set(key, employeeId);
    }
    if (!employeeId) {
      return {
        ok: false,
        recordedAtMs: atMs,
        status: "CHECKED_IN",
        reason: "No GreytHR employee found for this user",
      };
    }
    return employeeId;
  }

  /**
   * Mutate local state + emit. Only reached on a successful adapter call.
   *
   * `atMs` is the adapter result's `recordedAtMs` (greytHR's accepted swipe time
   * on the real path; the mock's echoed clock on the dev path). We record it
   * into the direction-specific field (lastCheckInMs / lastCheckOutMs) AND the
   * generic lastActionAtMs, carrying the opposite direction's timestamp forward
   * so "checked in at" survives a later check-out and vice versa.
   */
  private commit(userId: string, status: AttendanceStatus, atMs: number): void {
    const prev = this.getState(userId);
    this.states.set(userId, {
      userId,
      status,
      lastActionAtMs: atMs,
      lastCheckInMs: status === "CHECKED_IN" ? atMs : prev.lastCheckInMs,
      lastCheckOutMs: status === "CHECKED_OUT" ? atMs : prev.lastCheckOutMs,
    });
    const change: AttendanceChange = { userId, status };
    this.emit("attendance", change);
  }

  /**
   * Run an adapter call so it can NEVER throw out of the service. Any thrown
   * error (network/timeout/http/parse) or an explicit {ok:false} becomes a
   * graceful {ok:false, reason}. No local state is changed on failure.
   */
  private async safe(
    call: () => Promise<AttendanceResult>,
    atMs: number,
    intended: "CHECKED_IN" | "CHECKED_OUT",
  ): Promise<AttendanceResult> {
    try {
      const result = await call();
      if (!result || !result.ok) {
        return {
          ok: false,
          recordedAtMs: atMs,
          status: intended,
          reason: result?.reason ?? "HR rejected the attendance action",
        };
      }
      return result;
    } catch (err) {
      return {
        ok: false,
        recordedAtMs: atMs,
        status: intended,
        reason: err instanceof Error ? err.message : "HR integration unavailable",
      };
    }
  }
}
