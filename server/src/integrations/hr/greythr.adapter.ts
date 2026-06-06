// ---------------------------------------------------------------------------
// Real GreytHR REST adapter.
//
// Selected by the container ONLY when both GREYTHR_BASE_URL and
// GREYTHR_API_TOKEN are present (see notes/NOTES-hr.md). With fake/dead config
// the office still works: every method is wrapped by attendance.service.ts so a
// network failure / timeout / bad response degrades to {ok:false} and never
// throws into the room (plan Principle 4: integrations are optional).
//
// FORBIDDEN behaviors (plan.md GreytHR rules) are structurally impossible here:
// there is no timer, no activity listener, and no session reference. checkIn /
// checkOut are pure request/response and are only invoked by an explicit user
// click routed through the attendance service.
//
// API shape note: GreytHR's exact endpoints/payloads vary by tenant/version.
// The request paths and field mappings below are isolated in this single file
// behind the HrAdapter interface, so adjusting them for a specific tenant never
// touches business logic. The mapping functions are defensive about field
// names so common variants ("employeeId"/"id", "departmentName"/"department")
// are handled.
// ---------------------------------------------------------------------------

import type { Department } from "@pixeloffice/shared";
import { DEPARTMENTS } from "@pixeloffice/shared";
import {
  HrAdapterError,
  type AttendanceResult,
  type DepartmentMapping,
  type EmployeeRecord,
  type HrAdapter,
} from "./hr-adapter";

export interface GreytHrConfig {
  baseUrl: string;
  apiToken: string;
  /** Per-request timeout. Defaults to 5000ms (plan requirement: 5s timeout). */
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5000;

export class GreytHrAdapter implements HrAdapter {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: GreytHrConfig) {
    if (!config.baseUrl || !config.apiToken) {
      throw new HrAdapterError(
        "GreytHrAdapter requires baseUrl and apiToken",
        "config",
      );
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiToken = config.apiToken;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  async lookupEmployee(email: string): Promise<EmployeeRecord | null> {
    const trimmed = (email ?? "").trim();
    if (!trimmed) return null;
    const data = await this.request<unknown>(
      "GET",
      `/v1/employees?email=${encodeURIComponent(trimmed)}`,
    );
    const record = extractFirstEmployee(data);
    return record ? mapEmployee(record) : null;
  }

  async syncDepartments(): Promise<DepartmentMapping[]> {
    const data = await this.request<unknown>("GET", "/v1/departments");
    const rows = extractDepartments(data);
    return rows.map((label) => ({
      hrDepartment: label,
      officeDepartment: mapDepartment(label),
    }));
  }

  async checkIn(employeeId: string, atMs: number): Promise<AttendanceResult> {
    await this.request<unknown>("POST", `/v1/attendance/check-in`, {
      employeeId,
      timestamp: new Date(atMs).toISOString(),
    });
    return { ok: true, recordedAtMs: atMs, status: "CHECKED_IN" };
  }

  async checkOut(employeeId: string, atMs: number): Promise<AttendanceResult> {
    await this.request<unknown>("POST", `/v1/attendance/check-out`, {
      employeeId,
      timestamp: new Date(atMs).toISOString(),
    });
    return { ok: true, recordedAtMs: atMs, status: "CHECKED_OUT" };
  }

  // --- private --------------------------------------------------------------

  /**
   * Single seam for every GreytHR HTTP call. Applies auth header, JSON body, a
   * 5s AbortController timeout, and converts failures into typed HrAdapterError
   * (the attendance service catches these and degrades gracefully).
   */
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new HrAdapterError(`GreytHR request timed out after ${this.timeoutMs}ms`, "timeout");
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new HrAdapterError(`GreytHR request timed out after ${this.timeoutMs}ms`, "timeout");
      }
      throw new HrAdapterError(
        `GreytHR network error: ${err instanceof Error ? err.message : String(err)}`,
        "network",
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new HrAdapterError(`GreytHR HTTP ${res.status}`, "http", res.status);
    }

    // Some endpoints (attendance) may return empty bodies on success.
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HrAdapterError("GreytHR returned non-JSON body", "parse");
    }
  }
}

// --- field mapping helpers (defensive about GreytHR field-name variants) -----

type Json = Record<string, unknown>;

function asJson(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** GreytHR list responses may be `[...]`, `{data:[...]}`, or `{employees:[...]}`. */
function extractFirstEmployee(data: unknown): Json | null {
  if (Array.isArray(data)) return asJson(data[0]) ?? null;
  const obj = asJson(data);
  if (!obj) return null;
  for (const key of ["data", "employees", "results", "items"]) {
    const arr = obj[key];
    if (Array.isArray(arr)) return asJson(arr[0]) ?? null;
  }
  // A single-object response is also acceptable.
  return obj.email || obj.id || obj.employeeId ? obj : null;
}

function mapEmployee(row: Json): EmployeeRecord {
  return {
    id: str(row.id) ?? str(row.employeeId) ?? str(row.empId) ?? "",
    email: str(row.email) ?? str(row.emailId) ?? "",
    name:
      str(row.name) ??
      str(row.fullName) ??
      [str(row.firstName), str(row.lastName)].filter(Boolean).join(" ").trim() ??
      "",
    department: str(row.department) ?? str(row.departmentName) ?? str(row.dept) ?? "",
  };
}

function extractDepartments(data: unknown): string[] {
  const rows: unknown[] = Array.isArray(data)
    ? data
    : ((asJson(data)?.data ?? asJson(data)?.departments ?? []) as unknown[]);
  const out: string[] = [];
  for (const row of rows) {
    const obj = asJson(row);
    const label = obj
      ? str(obj.name) ?? str(obj.departmentName) ?? str(obj.department)
      : str(row);
    if (label) out.push(label);
  }
  return out;
}

/** Case-insensitive match of a GreytHR label onto an office Department. */
function mapDepartment(label: string): Department | null {
  const want = label.trim().toLowerCase();
  for (const d of DEPARTMENTS) {
    if (d.toLowerCase() === want) return d;
  }
  // A few common aliases GreytHR tenants use.
  const aliases: Record<string, Department> = {
    "software engineering": "Engineering",
    engineering: "Engineering",
    "product management": "Product",
    ux: "Design",
    "human resources": "HR",
  };
  return aliases[want] ?? null;
}
