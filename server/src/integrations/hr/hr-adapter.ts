// ---------------------------------------------------------------------------
// GreytHR integration boundary (Adapter Pattern, plan Layer 3).
//
// Per plan.md ("GreytHR Integration Rules"):
//   ALLOWED:    employee lookup, department sync, attendance ACTIONS.
//   FORBIDDEN:  auto-check-in, auto-check-out, auto-logout users.
//   "All attendance actions must be explicit."
//
// This adapter therefore exposes ONLY explicit, caller-driven operations. It
// never observes activity, never schedules background check-ins/outs, and never
// touches user sessions. The attendance state machine (attendance.service.ts)
// invokes checkIn/checkOut only in response to an explicit user click that
// arrives over the REST API (server/src/http/hr.routes.ts).
//
// Integrations are optional (plan Principle 4): the service that depends on this
// interface wraps every call so a failing/absent GreytHR never breaks the
// office. With no GREYTHR_* env vars set, the in-memory MockGreytHrAdapter is
// used and the office behaves exactly as before.
// ---------------------------------------------------------------------------

import type { Department } from "@pixeloffice/shared";

/** A single employee record as returned by GreytHR (or the mock). */
export interface EmployeeRecord {
  /** GreytHR employee id (opaque). */
  id: string;
  email: string;
  name: string;
  /**
   * Department as reported by HR. Typed as string (not Department) because the
   * external system may use names that do not map onto the office's
   * DEPARTMENTS; department sync is responsible for reconciling them.
   */
  department: string;
}

/**
 * Result of an explicit attendance action. `ok:false` carries a `reason` and is
 * returned (never thrown) when the integration is unavailable or rejects the
 * action — the office is unaffected.
 */
export interface AttendanceResult {
  ok: boolean;
  /** Epoch ms the action was recorded (server clock; supplied by caller). */
  recordedAtMs: number;
  /** The attendance status after the action. */
  status: "CHECKED_IN" | "CHECKED_OUT";
  /** Present when ok === false: human-readable failure cause. */
  reason?: string;
}

/**
 * Maps a GreytHR/free-form department label onto one of the office's known
 * DEPARTMENTS, or null when there is no confident match. Used by department
 * sync; exported so both the adapter and tests share one definition.
 */
export interface DepartmentMapping {
  /** The department string as reported by GreytHR. */
  hrDepartment: string;
  /** The office department it maps to, or null if unmapped. */
  officeDepartment: Department | null;
}

/**
 * The GreytHR boundary. Real (greythr.adapter.ts) and mock
 * (mock-greythr.adapter.ts) implementations honor this exact contract; only the
 * container wiring chooses between them based on env config.
 */
export interface HrAdapter {
  /** Look up an employee by email. Returns null when not found. */
  lookupEmployee(email: string): Promise<EmployeeRecord | null>;

  /** Fetch the department mapping table (department sync). */
  syncDepartments(): Promise<DepartmentMapping[]>;

  /**
   * Record an EXPLICIT check-in for an employee at `atMs`.
   * MUST only be called as a direct result of a user clicking "Check in".
   */
  checkIn(employeeId: string, atMs: number): Promise<AttendanceResult>;

  /**
   * Record an EXPLICIT check-out for an employee at `atMs`.
   * MUST only be called as a direct result of a user clicking "Check out".
   */
  checkOut(employeeId: string, atMs: number): Promise<AttendanceResult>;
}

/** Thrown internally by the real adapter; never escapes the attendance service. */
export class HrAdapterError extends Error {
  constructor(
    message: string,
    readonly kind: "network" | "timeout" | "http" | "parse" | "config",
    readonly status?: number,
  ) {
    super(message);
    this.name = "HrAdapterError";
  }
}
