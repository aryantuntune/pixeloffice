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
      }
    );
  }

  /**
   * EXPLICIT user-initiated check-in. The ONLY caller is the /api/hr/check-in
   * route, invoked by a button click. Allowed from any state (re-check-in from
   * CHECKED_OUT; idempotent if already CHECKED_IN — still records the action).
   */
  async checkIn(userId: string, atMs: number): Promise<AttendanceResult> {
    const result = await this.safe(() => this.hr.checkIn(userId, atMs), atMs, "CHECKED_IN");
    if (result.ok) this.commit(userId, "CHECKED_IN", result.recordedAtMs);
    return result;
  }

  /**
   * EXPLICIT user-initiated check-out. The ONLY caller is the /api/hr/check-out
   * route, invoked by a button click.
   */
  async checkOut(userId: string, atMs: number): Promise<AttendanceResult> {
    // Guard: checking out when not checked in is a no-op state-wise, but we
    // still honor the explicit action by delegating; the adapter decides.
    const result = await this.safe(() => this.hr.checkOut(userId, atMs), atMs, "CHECKED_OUT");
    if (result.ok) this.commit(userId, "CHECKED_OUT", result.recordedAtMs);
    return result;
  }

  /** Drop a user's local attendance state (e.g. on disconnect). NOT an action. */
  forget(userId: string): void {
    this.states.delete(userId);
  }

  // --- private --------------------------------------------------------------

  /** Mutate local state + emit. Only reached on a successful adapter call. */
  private commit(userId: string, status: AttendanceStatus, atMs: number): void {
    this.states.set(userId, { userId, status, lastActionAtMs: atMs });
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
