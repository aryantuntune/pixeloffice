// ---------------------------------------------------------------------------
// In-memory GreytHR mock. Used by DEFAULT (no GREYTHR_* env vars set), so the
// zero-config path keeps working with no external system.
//
// It seeds a few fake employees keyed by email so that dev users (whose email
// follows the dev convention, see emailForName below) get department-sync hits
// and a successful employee lookup. Attendance actions simply echo back a
// success result with the supplied timestamp — there is no real HR system to
// call, but the explicit-action contract is preserved (this is only ever
// invoked by an explicit user click via the attendance service).
// ---------------------------------------------------------------------------

import { DEPARTMENTS, type Department } from "@pixeloffice/shared";
import type {
  AttendanceResult,
  DepartmentMapping,
  EmployeeRecord,
  HrAdapter,
} from "./hr-adapter";

/** Default department mapping table: GreytHR labels -> office departments. */
const DEFAULT_DEPARTMENT_MAP: DepartmentMapping[] = [
  { hrDepartment: "Engineering", officeDepartment: "Engineering" },
  { hrDepartment: "Software Engineering", officeDepartment: "Engineering" },
  { hrDepartment: "Product Management", officeDepartment: "Product" },
  { hrDepartment: "Product", officeDepartment: "Product" },
  { hrDepartment: "Design", officeDepartment: "Design" },
  { hrDepartment: "UX", officeDepartment: "Design" },
  { hrDepartment: "Human Resources", officeDepartment: "HR" },
  { hrDepartment: "HR", officeDepartment: "HR" },
  { hrDepartment: "Finance", officeDepartment: null }, // intentionally unmapped
];

let mockSeq = 0;

export class MockGreytHrAdapter implements HrAdapter {
  /** Keyed by lowercased email for case-insensitive lookup. */
  private readonly employees = new Map<string, EmployeeRecord>();
  private readonly departmentMap: DepartmentMapping[];

  constructor(opts?: { seed?: EmployeeRecord[]; departmentMap?: DepartmentMapping[] }) {
    this.departmentMap = opts?.departmentMap ?? DEFAULT_DEPARTMENT_MAP;
    const seed = opts?.seed ?? defaultSeed();
    for (const emp of seed) this.employees.set(emp.email.toLowerCase(), emp);
  }

  async lookupEmployee(email: string): Promise<EmployeeRecord | null> {
    const key = (email ?? "").trim().toLowerCase();
    if (!key) return null;
    return this.employees.get(key) ?? null;
  }

  async syncDepartments(): Promise<DepartmentMapping[]> {
    return this.departmentMap.map((m) => ({ ...m }));
  }

  async checkIn(employeeId: string, atMs: number): Promise<AttendanceResult> {
    return { ok: true, recordedAtMs: atMs, status: "CHECKED_IN" };
  }

  async checkOut(employeeId: string, atMs: number): Promise<AttendanceResult> {
    return { ok: true, recordedAtMs: atMs, status: "CHECKED_OUT" };
  }

  /** Test/seed helper: add or replace an employee. */
  upsertEmployee(emp: EmployeeRecord): void {
    this.employees.set(emp.email.toLowerCase(), emp);
  }
}

/** A handful of fake employees, one per office department. */
function defaultSeed(): EmployeeRecord[] {
  const samples: Array<{ name: string; department: Department }> = [
    { name: "Ada Lovelace", department: "Engineering" },
    { name: "Grace Hopper", department: "Engineering" },
    { name: "Don Norman", department: "Design" },
    { name: "Marty Cagan", department: "Product" },
    { name: "Patty McCord", department: "HR" },
  ];
  return samples.map((s) => ({
    id: `emp_${++mockSeq}`,
    email: emailForName(s.name),
    name: s.name,
    department: s.department,
  }));
}

/**
 * Dev email convention: "Ada Lovelace" -> "ada.lovelace@pixeloffice.dev".
 * The HR routes use this same convention to derive a lookup email from a live
 * player's display name so the mock yields hits without real OAuth emails.
 * Exported for the routes + tests so the convention lives in one place.
 */
export function emailForName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
  return `${slug || "user"}@pixeloffice.dev`;
}

/** Re-export so the container/tests can build a default-seeded mock cleanly. */
export { DEPARTMENTS };
