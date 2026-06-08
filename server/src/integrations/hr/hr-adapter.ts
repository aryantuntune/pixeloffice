// GreytHR integration boundary (HrAdapter). Exposes only explicit, caller-driven
// attendance actions (no auto check-in/out). All greytHR traffic goes through the
// self-hosted ESS API; PixelOffice never calls greytHR cloud directly.

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

/** A selectable attendance work location (e.g. Office, Work from Home). */
export interface AttendanceLocation {
  /** greytHR work-location id (sent back as `attLocation` on sign-in). */
  id: number;
  /** Human description shown in the picker (e.g. "Office"). */
  description: string;
}

/** Caller-chosen options for an explicit sign-in / sign-out. */
export interface AttendanceMarkOptions {
  /** Explicit greytHR work-location id (takes precedence over `location`). */
  attLocation?: number;
  /** Work location by description, e.g. "Office" (resolved by the HR system). */
  location?: string;
  /** Optional free-text remarks. */
  remarks?: string;
}

/** The employee's current attendance as the live HR portal reports it. */
export interface RemoteAttendanceSnapshot {
  status: "NOT_CHECKED_IN" | "CHECKED_IN" | "CHECKED_OUT";
  /** Epoch ms of today's first sign-in, or null when not signed in. */
  firstInMs: number | null;
  /** Epoch ms of today's last sign-out, or null when not signed out. */
  lastOutMs: number | null;
  /** Work-location description currently in effect (e.g. "Office"). */
  workLocation: string | null;
  workLocationId: number | null;
  /** Whether the portal lets the employee choose a work location on sign-in. */
  allowLocationSelection: boolean;
  locations: AttendanceLocation[];
  shiftName: string | null;
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
   * `options` carries the user-chosen work location (and optional remarks).
   */
  checkIn(employeeId: string, atMs: number, options?: AttendanceMarkOptions): Promise<AttendanceResult>;

  /**
   * Record an EXPLICIT check-out for an employee at `atMs`.
   * MUST only be called as a direct result of a user clicking "Check out".
   */
  checkOut(employeeId: string, atMs: number, options?: AttendanceMarkOptions): Promise<AttendanceResult>;

  /**
   * Read the employee's current attendance from the live HR system, or null when
   * it cannot be determined. Read-only (no swipe). Optional: adapters without a
   * real-time status source (e.g. the mock) may omit it.
   */
  getStatus?(employeeId: string): Promise<RemoteAttendanceSnapshot | null>;
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
