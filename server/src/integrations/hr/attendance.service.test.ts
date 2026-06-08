import { beforeEach, describe, expect, it, vi } from "vitest";
import { AttendanceService, type AttendanceChange } from "./attendance.service";
import { MockGreytHrAdapter } from "./mock-greythr.adapter";
import type {
  AttendanceResult,
  DepartmentMapping,
  EmployeeRecord,
  HrAdapter,
  RemoteAttendanceSnapshot,
} from "./hr-adapter";

const T0 = 1_000_000;
const T1 = 1_000_100;
const T2 = 1_000_200;

/** Adapter that always succeeds, recording calls for assertions. */
class OkAdapter implements HrAdapter {
  checkInCalls: Array<{ id: string; at: number }> = [];
  checkOutCalls: Array<{ id: string; at: number }> = [];
  async lookupEmployee(): Promise<EmployeeRecord | null> {
    return null;
  }
  async syncDepartments(): Promise<DepartmentMapping[]> {
    return [];
  }
  async checkIn(employeeId: string, atMs: number): Promise<AttendanceResult> {
    this.checkInCalls.push({ id: employeeId, at: atMs });
    return { ok: true, recordedAtMs: atMs, status: "CHECKED_IN" };
  }
  async checkOut(employeeId: string, atMs: number): Promise<AttendanceResult> {
    this.checkOutCalls.push({ id: employeeId, at: atMs });
    return { ok: true, recordedAtMs: atMs, status: "CHECKED_OUT" };
  }
}

/** Adapter that throws on attendance — simulates network/timeout failure. */
class ThrowingAdapter implements HrAdapter {
  async lookupEmployee(): Promise<EmployeeRecord | null> {
    return null;
  }
  async syncDepartments(): Promise<DepartmentMapping[]> {
    return [];
  }
  async checkIn(): Promise<AttendanceResult> {
    throw new Error("GreytHR request timed out after 5000ms");
  }
  async checkOut(): Promise<AttendanceResult> {
    throw new Error("boom");
  }
}

/** Adapter that returns {ok:false} — simulates HR-side rejection. */
class RejectingAdapter implements HrAdapter {
  async lookupEmployee(): Promise<EmployeeRecord | null> {
    return null;
  }
  async syncDepartments(): Promise<DepartmentMapping[]> {
    return [];
  }
  async checkIn(_id: string, atMs: number): Promise<AttendanceResult> {
    return { ok: false, recordedAtMs: atMs, status: "CHECKED_IN", reason: "denied" };
  }
  async checkOut(_id: string, atMs: number): Promise<AttendanceResult> {
    return { ok: false, recordedAtMs: atMs, status: "CHECKED_OUT", reason: "denied" };
  }
}

describe("AttendanceService — initial state", () => {
  it("defaults to NOT_CHECKED_IN with no last action or times", () => {
    const svc = new AttendanceService(new OkAdapter());
    expect(svc.getState("u1")).toEqual({
      userId: "u1",
      status: "NOT_CHECKED_IN",
      lastActionAtMs: null,
      lastCheckInMs: null,
      lastCheckOutMs: null,
    });
  });
});

describe("AttendanceService — happy-path transitions", () => {
  let adapter: OkAdapter;
  let svc: AttendanceService;
  let changes: AttendanceChange[];

  beforeEach(() => {
    adapter = new OkAdapter();
    svc = new AttendanceService(adapter);
    changes = [];
    svc.on("attendance", (c: AttendanceChange) => changes.push(c));
  });

  it("NOT_CHECKED_IN -> CHECKED_IN on check-in", async () => {
    const r = await svc.checkIn("u1", T0);
    expect(r).toEqual({ ok: true, recordedAtMs: T0, status: "CHECKED_IN" });
    expect(svc.getState("u1")).toEqual({
      userId: "u1",
      status: "CHECKED_IN",
      lastActionAtMs: T0,
      lastCheckInMs: T0,
      lastCheckOutMs: null,
    });
    expect(changes).toEqual([{ userId: "u1", status: "CHECKED_IN" }]);
    expect(adapter.checkInCalls).toEqual([{ id: "u1", at: T0 }]);
  });

  it("CHECKED_IN -> CHECKED_OUT on check-out", async () => {
    await svc.checkIn("u1", T0);
    const r = await svc.checkOut("u1", T1);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("CHECKED_OUT");
    expect(svc.getState("u1").status).toBe("CHECKED_OUT");
    expect(svc.getState("u1").lastActionAtMs).toBe(T1);
    expect(changes.map((c) => c.status)).toEqual(["CHECKED_IN", "CHECKED_OUT"]);
  });

  it("CHECKED_OUT -> CHECKED_IN (re-check-in allowed)", async () => {
    await svc.checkIn("u1", T0);
    await svc.checkOut("u1", T1);
    const r = await svc.checkIn("u1", T2);
    expect(r.ok).toBe(true);
    expect(svc.getState("u1").status).toBe("CHECKED_IN");
    expect(svc.getState("u1").lastActionAtMs).toBe(T2);
    expect(changes.map((c) => c.status)).toEqual([
      "CHECKED_IN",
      "CHECKED_OUT",
      "CHECKED_IN",
    ]);
  });

  it("idempotent double check-in records the action each time", async () => {
    await svc.checkIn("u1", T0);
    const r = await svc.checkIn("u1", T1);
    expect(r.ok).toBe(true);
    expect(svc.getState("u1").status).toBe("CHECKED_IN");
    // Second action updates the timestamp (it is still an explicit action).
    expect(svc.getState("u1").lastActionAtMs).toBe(T1);
    expect(adapter.checkInCalls.length).toBe(2);
    expect(changes.length).toBe(2);
  });

  it("tracks users independently", async () => {
    await svc.checkIn("u1", T0);
    await svc.checkOut("u2", T1);
    expect(svc.getState("u1").status).toBe("CHECKED_IN");
    expect(svc.getState("u2").status).toBe("CHECKED_OUT");
  });
});

describe("AttendanceService — check-in/out times from adapter results", () => {
  it("records lastCheckInMs from the adapter's recordedAtMs", async () => {
    const svc = new AttendanceService(new OkAdapter());
    await svc.checkIn("u1", T0);
    const s = svc.getState("u1");
    expect(s.lastCheckInMs).toBe(T0);
    expect(s.lastCheckOutMs).toBeNull();
  });

  it("records lastCheckOutMs and PRESERVES lastCheckInMs across a check-out", async () => {
    const svc = new AttendanceService(new OkAdapter());
    await svc.checkIn("u1", T0);
    await svc.checkOut("u1", T1);
    const s = svc.getState("u1");
    expect(s.status).toBe("CHECKED_OUT");
    expect(s.lastCheckInMs).toBe(T0); // survives the check-out
    expect(s.lastCheckOutMs).toBe(T1);
  });

  it("a re-check-in updates lastCheckInMs while keeping the prior lastCheckOutMs", async () => {
    const svc = new AttendanceService(new OkAdapter());
    await svc.checkIn("u1", T0);
    await svc.checkOut("u1", T1);
    await svc.checkIn("u1", T2);
    const s = svc.getState("u1");
    expect(s.lastCheckInMs).toBe(T2);
    expect(s.lastCheckOutMs).toBe(T1); // carried forward
  });

  it("uses the ADAPTER's recordedAtMs, not the requested atMs (greytHR-accepted time)", async () => {
    // Adapter that accepts the swipe at a DIFFERENT (corrected) time.
    const accepted = T0 + 5_000;
    const adapter: HrAdapter = {
      async lookupEmployee() {
        return null;
      },
      async syncDepartments() {
        return [];
      },
      async checkIn() {
        return { ok: true, recordedAtMs: accepted, status: "CHECKED_IN" };
      },
      async checkOut() {
        return { ok: true, recordedAtMs: accepted, status: "CHECKED_OUT" };
      },
    };
    const svc = new AttendanceService(adapter);
    await svc.checkIn("u1", T0);
    expect(svc.getState("u1").lastCheckInMs).toBe(accepted);
    expect(svc.getState("u1").lastActionAtMs).toBe(accepted);
  });

  it("does not record any time when the action fails", async () => {
    const svc = new AttendanceService(new RejectingAdapter());
    await svc.checkIn("u1", T0);
    const s = svc.getState("u1");
    expect(s.lastCheckInMs).toBeNull();
    expect(s.lastCheckOutMs).toBeNull();
  });
});

describe("AttendanceService — adapter failure (graceful degradation)", () => {
  it("returns {ok:false} and does NOT change state when the adapter throws", async () => {
    const svc = new AttendanceService(new ThrowingAdapter());
    const changes: AttendanceChange[] = [];
    svc.on("attendance", (c) => changes.push(c));

    const r = await svc.checkIn("u1", T0);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/timed out/i);
    expect(r.status).toBe("CHECKED_IN");
    // State untouched: office unaffected.
    expect(svc.getState("u1").status).toBe("NOT_CHECKED_IN");
    expect(changes).toEqual([]);
  });

  it("does not throw — service never propagates adapter errors", async () => {
    const svc = new AttendanceService(new ThrowingAdapter());
    await expect(svc.checkIn("u1", T0)).resolves.toBeDefined();
    await expect(svc.checkOut("u1", T1)).resolves.toBeDefined();
  });

  it("returns {ok:false} with reason when the adapter rejects (ok:false)", async () => {
    const svc = new AttendanceService(new RejectingAdapter());
    const r = await svc.checkIn("u1", T0);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("denied");
    expect(svc.getState("u1").status).toBe("NOT_CHECKED_IN");
  });

  it("a failed check-out after a successful check-in keeps CHECKED_IN", async () => {
    // First succeed via Ok adapter, then swap behavior by spying.
    const adapter = new OkAdapter();
    const svc = new AttendanceService(adapter);
    await svc.checkIn("u1", T0);
    expect(svc.getState("u1").status).toBe("CHECKED_IN");

    vi.spyOn(adapter, "checkOut").mockRejectedValueOnce(new Error("network down"));
    const r = await svc.checkOut("u1", T1);
    expect(r.ok).toBe(false);
    // Prior state preserved.
    expect(svc.getState("u1").status).toBe("CHECKED_IN");
    expect(svc.getState("u1").lastActionAtMs).toBe(T0);
  });
});

describe("AttendanceService — GreytHR employee-code resolution", () => {
  /** Adapter that resolves a known email to an employee id and records swipes. */
  class LookupAdapter implements HrAdapter {
    swipes: string[] = [];
    async lookupEmployee(email: string): Promise<EmployeeRecord | null> {
      if (email.toLowerCase() === "ada@x.dev") {
        return { id: "EMP-42", email, name: "Ada", department: "Engineering" };
      }
      return null;
    }
    async syncDepartments(): Promise<DepartmentMapping[]> {
      return [];
    }
    async checkIn(employeeId: string, atMs: number): Promise<AttendanceResult> {
      this.swipes.push(employeeId);
      return { ok: true, recordedAtMs: atMs, status: "CHECKED_IN" };
    }
    async checkOut(employeeId: string, atMs: number): Promise<AttendanceResult> {
      this.swipes.push(employeeId);
      return { ok: true, recordedAtMs: atMs, status: "CHECKED_OUT" };
    }
  }

  it("swipes the resolved EMPLOYEE id (not the office userId) when an email is supplied", async () => {
    const adapter = new LookupAdapter();
    const svc = new AttendanceService(adapter);
    const r = await svc.checkIn("dev:ada:rand", T0, "ada@x.dev");
    expect(r.ok).toBe(true);
    expect(adapter.swipes).toEqual(["EMP-42"]); // employee code, NOT "dev:ada:rand"
    // Local state stays keyed by the office userId.
    expect(svc.getState("dev:ada:rand").status).toBe("CHECKED_IN");
  });

  it("caches the email->employee mapping (one lookup across calls)", async () => {
    const adapter = new LookupAdapter();
    let lookups = 0;
    const orig = adapter.lookupEmployee.bind(adapter);
    adapter.lookupEmployee = async (e: string) => {
      lookups++;
      return orig(e);
    };
    const svc = new AttendanceService(adapter);
    await svc.checkIn("u", T0, "ada@x.dev");
    await svc.checkOut("u", T1, "ada@x.dev");
    expect(lookups).toBe(1);
  });

  it("returns {ok:false} without swiping when no employee is found", async () => {
    const adapter = new LookupAdapter();
    const svc = new AttendanceService(adapter);
    const r = await svc.checkIn("u", T0, "unknown@x.dev");
    expect(r.ok).toBe(false);
    expect(adapter.swipes).toEqual([]);
    expect(svc.getState("u").status).toBe("NOT_CHECKED_IN");
  });

  it("passes the userId through unchanged when NO email is supplied (mock/dev path)", async () => {
    const adapter = new LookupAdapter();
    const svc = new AttendanceService(adapter);
    await svc.checkIn("emp_raw", T0);
    expect(adapter.swipes).toEqual(["emp_raw"]);
  });
});

describe("AttendanceService — describeStatus (live reconciliation)", () => {
  it("falls back to local state when the adapter exposes no getStatus", async () => {
    const svc = new AttendanceService(new OkAdapter());
    const view = await svc.describeStatus("u1");
    expect(view.status).toBe("NOT_CHECKED_IN");
    expect(view.remote).toBeNull();
  });

  it("reflects a live greytHR sign-in even though no local swipe ever happened", async () => {
    // Adapter with a real-time status source: the user is already signed in.
    const adapter: HrAdapter = {
      async lookupEmployee() {
        return null;
      },
      async syncDepartments() {
        return [];
      },
      async checkIn(_id, atMs) {
        return { ok: true, recordedAtMs: atMs, status: "CHECKED_IN" };
      },
      async checkOut(_id, atMs) {
        return { ok: true, recordedAtMs: atMs, status: "CHECKED_OUT" };
      },
      async getStatus(): Promise<RemoteAttendanceSnapshot> {
        return {
          status: "CHECKED_IN",
          firstInMs: T0,
          lastOutMs: null,
          workLocation: "Office",
          workLocationId: 81,
          allowLocationSelection: true,
          locations: [{ id: 81, description: "Office" }],
          shiftName: "9:00 AM -6:30 PM",
        };
      },
    };
    const svc = new AttendanceService(adapter);
    // Local state machine alone would say NOT_CHECKED_IN.
    expect(svc.getState("u1").status).toBe("NOT_CHECKED_IN");

    const view = await svc.describeStatus("u1");
    expect(view.status).toBe("CHECKED_IN");
    expect(view.remote?.workLocation).toBe("Office");
    // Live greytHR sign-in time flows into lastCheckInMs (greytHR's clock).
    expect(view.lastCheckInMs).toBe(T0);
    // Reconciled into local state for subsequent reads.
    expect(svc.getState("u1").status).toBe("CHECKED_IN");
  });

  it("does NOT emit an attendance event when reconciling (read-only, not an action)", async () => {
    const adapter: HrAdapter = {
      async lookupEmployee() {
        return null;
      },
      async syncDepartments() {
        return [];
      },
      async checkIn(_id, atMs) {
        return { ok: true, recordedAtMs: atMs, status: "CHECKED_IN" };
      },
      async checkOut(_id, atMs) {
        return { ok: true, recordedAtMs: atMs, status: "CHECKED_OUT" };
      },
      async getStatus(): Promise<RemoteAttendanceSnapshot> {
        return {
          status: "CHECKED_IN",
          firstInMs: T0,
          lastOutMs: null,
          workLocation: null,
          workLocationId: null,
          allowLocationSelection: false,
          locations: [],
          shiftName: null,
        };
      },
    };
    const svc = new AttendanceService(adapter);
    const changes: AttendanceChange[] = [];
    svc.on("attendance", (c) => changes.push(c));
    await svc.describeStatus("u1");
    expect(changes).toEqual([]); // human-agency: reflecting status is not a swipe
  });

  it("degrades to local state when getStatus returns null or throws", async () => {
    const base = {
      async lookupEmployee() {
        return null;
      },
      async syncDepartments() {
        return [] as DepartmentMapping[];
      },
      async checkIn(_id: string, atMs: number): Promise<AttendanceResult> {
        return { ok: true, recordedAtMs: atMs, status: "CHECKED_IN" };
      },
      async checkOut(_id: string, atMs: number): Promise<AttendanceResult> {
        return { ok: true, recordedAtMs: atMs, status: "CHECKED_OUT" };
      },
    };
    const nullAdapter: HrAdapter = { ...base, async getStatus() { return null; } };
    const throwAdapter: HrAdapter = {
      ...base,
      async getStatus(): Promise<RemoteAttendanceSnapshot | null> {
        throw new Error("greytHR unreachable");
      },
    };

    const svc1 = new AttendanceService(nullAdapter);
    await svc1.checkIn("u1", T0); // local CHECKED_IN
    const v1 = await svc1.describeStatus("u1");
    expect(v1.status).toBe("CHECKED_IN");
    expect(v1.remote).toBeNull();

    const svc2 = new AttendanceService(throwAdapter);
    const v2 = await svc2.describeStatus("u2");
    expect(v2.status).toBe("NOT_CHECKED_IN");
    expect(v2.remote).toBeNull();
  });
});

describe("AttendanceService — forget", () => {
  it("resets a user to NOT_CHECKED_IN without emitting", async () => {
    const svc = new AttendanceService(new OkAdapter());
    const changes: AttendanceChange[] = [];
    await svc.checkIn("u1", T0);
    svc.on("attendance", (c) => changes.push(c));
    svc.forget("u1");
    expect(svc.getState("u1").status).toBe("NOT_CHECKED_IN");
    expect(changes).toEqual([]);
  });
});

describe("MockGreytHrAdapter — lookup + department sync", () => {
  it("looks up a seeded employee case-insensitively", async () => {
    const mock = new MockGreytHrAdapter();
    const found = await mock.lookupEmployee("ADA.LOVELACE@pixeloffice.dev");
    expect(found).not.toBeNull();
    expect(found?.name).toBe("Ada Lovelace");
    expect(found?.department).toBe("Engineering");
  });

  it("returns null for unknown / empty email", async () => {
    const mock = new MockGreytHrAdapter();
    expect(await mock.lookupEmployee("nobody@example.com")).toBeNull();
    expect(await mock.lookupEmployee("")).toBeNull();
  });

  it("syncDepartments maps known labels and leaves unknowns null", async () => {
    const mock = new MockGreytHrAdapter();
    const map = await mock.syncDepartments();
    const eng = map.find((m) => m.hrDepartment === "Software Engineering");
    expect(eng?.officeDepartment).toBe("Engineering");
    const fin = map.find((m) => m.hrDepartment === "Finance");
    expect(fin?.officeDepartment).toBeNull();
  });

  it("attendance actions echo the supplied timestamp", async () => {
    const mock = new MockGreytHrAdapter();
    expect(await mock.checkIn("emp_1", T0)).toEqual({
      ok: true,
      recordedAtMs: T0,
      status: "CHECKED_IN",
    });
    expect(await mock.checkOut("emp_1", T1)).toEqual({
      ok: true,
      recordedAtMs: T1,
      status: "CHECKED_OUT",
    });
  });
});
