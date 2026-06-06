import { describe, expect, it, vi } from "vitest";
import { GreytHrAdapter } from "./greythr.adapter";
import { HrAdapterError } from "./hr-adapter";

const CFG = { baseUrl: "https://greythr.example.com/", apiToken: "tok" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GreytHrAdapter — construction", () => {
  it("throws a config error when baseUrl/apiToken missing", () => {
    expect(() => new GreytHrAdapter({ baseUrl: "", apiToken: "" })).toThrow(HrAdapterError);
  });
});

describe("GreytHrAdapter — lookupEmployee", () => {
  it("sends bearer auth and maps a {data:[...]} response", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/v1/employees?email=ada%40x.com");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      return jsonResponse({
        data: [{ id: "e1", email: "ada@x.com", fullName: "Ada", departmentName: "Engineering" }],
      });
    }) as unknown as typeof fetch;

    const a = new GreytHrAdapter({ ...CFG, fetchFn });
    const rec = await a.lookupEmployee("ada@x.com");
    expect(rec).toEqual({ id: "e1", email: "ada@x.com", name: "Ada", department: "Engineering" });
  });

  it("returns null for empty email without calling fetch", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const a = new GreytHrAdapter({ ...CFG, fetchFn });
    expect(await a.lookupEmployee("  ")).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("GreytHrAdapter — syncDepartments", () => {
  it("maps labels onto office departments (aliases + null)", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        data: [{ name: "Software Engineering" }, { name: "Finance" }, { name: "HR" }],
      }),
    ) as unknown as typeof fetch;
    const a = new GreytHrAdapter({ ...CFG, fetchFn });
    const map = await a.syncDepartments();
    expect(map).toEqual([
      { hrDepartment: "Software Engineering", officeDepartment: "Engineering" },
      { hrDepartment: "Finance", officeDepartment: null },
      { hrDepartment: "HR", officeDepartment: "HR" },
    ]);
  });
});

describe("GreytHrAdapter — attendance + error mapping", () => {
  it("checkIn posts a timestamped body and returns CHECKED_IN", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/v1/attendance/check-in");
      const body = JSON.parse(String(init?.body));
      expect(body.employeeId).toBe("e1");
      expect(typeof body.timestamp).toBe("string");
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const a = new GreytHrAdapter({ ...CFG, fetchFn });
    const r = await a.checkIn("e1", 1700000000000);
    expect(r).toEqual({ ok: true, recordedAtMs: 1700000000000, status: "CHECKED_IN" });
  });

  it("maps HTTP non-2xx to an http HrAdapterError", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const a = new GreytHrAdapter({ ...CFG, fetchFn });
    await expect(a.checkOut("e1", 1)).rejects.toMatchObject({ kind: "http", status: 500 });
  });

  it("maps an aborted request to a timeout HrAdapterError", async () => {
    const fetchFn = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    const a = new GreytHrAdapter({ ...CFG, fetchFn, timeoutMs: 5 });
    await expect(a.lookupEmployee("x@y.com")).rejects.toMatchObject({ kind: "timeout" });
  });

  it("maps a generic fetch throw to a network HrAdapterError", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const a = new GreytHrAdapter({ ...CFG, fetchFn });
    await expect(a.syncDepartments()).rejects.toMatchObject({ kind: "network" });
  });
});
