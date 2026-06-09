// HrAdapter that records explicit check-in/out against the self-hosted greytHR
// ESS API (POST /api/attendance/sign-in|out), authenticated with the per-user
// session captured at login. Failures are returned, never thrown.

import type { GreytHrSessionStore } from "../../auth/greythr/greythr-session.store";
import type {
  AttendanceLocation,
  AttendanceMarkOptions,
  AttendanceResult,
  DepartmentMapping,
  EmployeeRecord,
  HrAdapter,
  RemoteAttendanceSnapshot,
} from "./hr-adapter";

/** A selectable greytHR work location (id -> human description). */
interface GreytHrLocation {
  id: number;
  code?: string | null;
  description?: string | null;
}

/**
 * Normalized status payload from the greytHR ESS API
 * (GET /api/attendance/status). Times are IST display strings ("09:52 AM").
 */
interface GreytHrStatusData {
  signedIn?: boolean;
  nextAction?: "sign-in" | "sign-out";
  firstInTime?: string | null;
  lastOutTime?: string | null;
  workLocationId?: number | null;
  allowLocationSelection?: boolean;
  shift?: { name?: string | null; startTime?: string | null; endTime?: string | null } | null;
  locations?: GreytHrLocation[] | null;
}

/**
 * Swipe response from the greytHR ESS API (POST /api/attendance/sign-in|out).
 * The authoritative post-action status is nested under `status`.
 */
interface GreytHrActionData {
  action?: "sign-in" | "sign-out";
  performed?: boolean;
  alreadyDone?: boolean;
  message?: string;
  swipe?: { firstInTime?: string | null; lastOutTime?: string | null; attWorkLocation?: number | null } | null;
  status?: GreytHrStatusData | null;
  /** Legacy flat field (older backend); used as a fallback for recordedAtMs. */
  recordedAtMs?: number;
}

interface GreytHrEnvelope<T> {
  success: boolean;
  data: T | null;
  error: { code?: string; message?: string } | null;
}

/** Map greytHR's boolean signedIn + last-out time onto the office status enum. */
function snapshotStatus(
  signedIn: boolean | undefined,
  lastOutTime: string | null | undefined,
): RemoteAttendanceSnapshot["status"] {
  if (signedIn) return "CHECKED_IN";
  if (lastOutTime) return "CHECKED_OUT";
  return "NOT_CHECKED_IN";
}

/** Resolve a work-location id to its description via the status `locations` list. */
function resolveWorkLocation(data: GreytHrStatusData): string | null {
  const id = data.workLocationId;
  if (typeof id !== "number") return null;
  const match = (data.locations ?? []).find((l) => l.id === id);
  return match?.description ?? null;
}

/** Clean, id+description-only view of greytHR's selectable work locations. */
function toLocations(data: GreytHrStatusData): AttendanceLocation[] {
  return (data.locations ?? [])
    .filter((l): l is GreytHrLocation & { id: number } => typeof l.id === "number")
    .map((l) => ({ id: l.id, description: (l.description ?? "").trim() || `Location ${l.id}` }));
}

/**
 * Parse a greytHR attendance time into epoch ms, or null when unparseable.
 * greytHR sends a naive ISO datetime in UTC (e.g. "2026-06-08T04:15:28.352487");
 * microseconds are trimmed to ms and a missing zone is treated as UTC.
 */
function parseHrTimeToMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "") return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    let iso = s.replace(/(\.\d{3})\d+/, "$1");
    if (!/([zZ]|[+-]\d{2}:?\d{2})$/.test(iso)) iso += "Z";
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface GreytHrEssAttendanceAdapterConfig {
  baseUrl: string;
  sessions: GreytHrSessionStore;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 8000;

export class GreytHrEssAttendanceAdapter implements HrAdapter {
  private readonly baseUrl: string;
  private readonly sessions: GreytHrSessionStore;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: GreytHrEssAttendanceAdapterConfig) {
    if (!config.baseUrl) {
      throw new Error("GreytHrEssAttendanceAdapter requires a baseUrl");
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.sessions = config.sessions;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  /** Not used on the ESS path: greytHR identifies the employee from the session. */
  async lookupEmployee(_email: string): Promise<EmployeeRecord | null> {
    return null;
  }

  /** Department sync is handled by the login/account flow, not attendance. */
  async syncDepartments(): Promise<DepartmentMapping[]> {
    return [];
  }

  /**
   * True when a greytHR session is held for this user. The session store is the
   * single source of truth: login writes it; a 401 on any swipe/status read
   * deletes it (the greytHR ESS API has no refresh endpoint). So "absent" means
   * the session expired, was logged out, or was wiped by a server restart — in
   * every case the user must reconnect with their password.
   */
  isConnected(userId: string): boolean {
    return this.sessions.get(userId) != null;
  }

  /** Record an explicit check-in for the user (with the chosen work location). */
  async checkIn(userId: string, atMs: number, options?: AttendanceMarkOptions): Promise<AttendanceResult> {
    return this.swipe(userId, atMs, "sign-in", "CHECKED_IN", options);
  }

  /** Record an explicit check-out for the user. */
  async checkOut(userId: string, atMs: number, options?: AttendanceMarkOptions): Promise<AttendanceResult> {
    return this.swipe(userId, atMs, "sign-out", "CHECKED_OUT", options);
  }

  /**
   * Fetch the user's current attendance from greytHR (GET /api/attendance/status).
   * Read-only. Returns null on any failure; a 401 drops the dead session.
   */
  async getStatus(userId: string): Promise<RemoteAttendanceSnapshot | null> {
    const sessionId = this.sessions.get(userId);
    if (!sessionId) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/api/attendance/status`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${sessionId}`,
        },
        signal: controller.signal,
      });
    } catch {
      return null; // network/timeout -> degrade to local state
    } finally {
      clearTimeout(timer);
    }

    let envelope: GreytHrEnvelope<GreytHrStatusData> | null = null;
    try {
      envelope = (await res.json()) as GreytHrEnvelope<GreytHrStatusData>;
    } catch {
      envelope = null;
    }

    if (!res.ok || !envelope || !envelope.success || !envelope.data) {
      const code = envelope?.error?.code;
      if (res.status === 401 || code === "UNAUTHORIZED" || code === "SESSION_EXPIRED") {
        this.sessions.delete(userId); // drop the dead session; user re-signs in
      }
      return null;
    }

    const d = envelope.data;
    return {
      status: snapshotStatus(d.signedIn, d.lastOutTime),
      firstInMs: parseHrTimeToMs(d.firstInTime),
      lastOutMs: parseHrTimeToMs(d.lastOutTime),
      workLocation: resolveWorkLocation(d),
      workLocationId: typeof d.workLocationId === "number" ? d.workLocationId : null,
      allowLocationSelection: d.allowLocationSelection === true,
      locations: toLocations(d),
      shiftName: d.shift?.name ?? null,
    };
  }

  /** POST the swipe with the user's session; degrade to {ok:false} on any failure. */
  private async swipe(
    userId: string,
    atMs: number,
    action: "sign-in" | "sign-out",
    intended: "CHECKED_IN" | "CHECKED_OUT",
    options?: AttendanceMarkOptions,
  ): Promise<AttendanceResult> {
    const sessionId = this.sessions.get(userId);
    if (!sessionId) {
      return {
        ok: false,
        recordedAtMs: atMs,
        status: intended,
        reason: "Sign in with greytHR to record attendance.",
      };
    }

    // Forward the chosen work location/remarks; send a body only when present.
    const body: Record<string, unknown> = {};
    if (typeof options?.attLocation === "number") body.attLocation = options.attLocation;
    if (typeof options?.location === "string" && options.location.trim() !== "") {
      body.location = options.location.trim();
    }
    if (typeof options?.remarks === "string" && options.remarks !== "") body.remarks = options.remarks;
    const hasBody = Object.keys(body).length > 0;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/api/attendance/${action}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${sessionId}`,
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === "AbortError"
          ? `greytHR attendance timed out after ${this.timeoutMs}ms`
          : `greytHR attendance network error: ${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, recordedAtMs: atMs, status: intended, reason };
    } finally {
      clearTimeout(timer);
    }

    let envelope: GreytHrEnvelope<GreytHrActionData> | null = null;
    try {
      envelope = (await res.json()) as GreytHrEnvelope<GreytHrActionData>;
    } catch {
      envelope = null;
    }

    if (!res.ok || !envelope || !envelope.success || !envelope.data) {
      const code = envelope?.error?.code;
      let reason = envelope?.error?.message ?? `greytHR attendance HTTP ${res.status}`;
      if (res.status === 401 || code === "UNAUTHORIZED" || code === "SESSION_EXPIRED") {
        this.sessions.delete(userId);
        reason = "greytHR session expired. Sign in again to record attendance.";
      }
      return { ok: false, recordedAtMs: atMs, status: intended, reason };
    }

    // greytHR is idempotent; `intended` is the resulting state. It returns no
    // epoch, so use the caller's clock (the older flat recordedAtMs as fallback).
    const data = envelope.data;
    return {
      ok: true,
      recordedAtMs: typeof data.recordedAtMs === "number" ? data.recordedAtMs : atMs,
      status: intended,
    };
  }
}
