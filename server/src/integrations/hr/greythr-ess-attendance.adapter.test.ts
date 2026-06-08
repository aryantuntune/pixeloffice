import { describe, expect, it, vi } from "vitest";
import { GreytHrEssAttendanceAdapter } from "./greythr-ess-attendance.adapter";
import { InMemoryGreytHrSessionStore } from "../../auth/greythr/greythr-session.store";

const BASE = "https://greythr.example.com";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A session store pre-seeded with one user -> session id. */
function storeWith(userId: string, sessionId: string): InMemoryGreytHrSessionStore {
  const s = new InMemoryGreytHrSessionStore();
  s.set(userId, sessionId);
  return s;
}

describe("GreytHrEssAttendanceAdapter — construction", () => {
  it("throws without a baseUrl", () => {
    expect(
      () =>
        new GreytHrEssAttendanceAdapter({
          baseUrl: "",
          sessions: new InMemoryGreytHrSessionStore(),
        }),
    ).toThrow();
  });
});

describe("GreytHrEssAttendanceAdapter — check-in / check-out", () => {
  it("posts sign-in with the user's Bearer session and returns greytHR's swipe time", async () => {
    const sessions = storeWith("greythr:KCC001", "sess-abc");
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`${BASE}/api/attendance/sign-in`);
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sess-abc");
      return jsonResponse({
        success: true,
        data: { ok: true, status: "CHECKED_IN", recordedAtMs: 1_700_000_000_000 },
        error: null,
      });
    }) as unknown as typeof fetch;

    const a = new GreytHrEssAttendanceAdapter({ baseUrl: `${BASE}/`, sessions, fetchFn });
    const result = await a.checkIn("greythr:KCC001", 999);

    expect(result.ok).toBe(true);
    expect(result.status).toBe("CHECKED_IN");
    expect(result.recordedAtMs).toBe(1_700_000_000_000); // greytHR's time, not the caller's
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("parses the NEW nested greytHR swipe shape (status object, no recordedAtMs)", async () => {
    const sessions = storeWith("greythr:KCC001", "sess-abc");
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        success: true,
        data: {
          action: "sign-in",
          performed: true,
          alreadyDone: false,
          message: "Signed in successfully.",
          swipe: { firstInTime: "09:52 AM", lastOutTime: null, attWorkLocation: 81 },
          status: { signedIn: true, nextAction: "sign-out", firstInTime: "09:52 AM", lastOutTime: null },
        },
        error: null,
      }),
    ) as unknown as typeof fetch;

    const a = new GreytHrEssAttendanceAdapter({ baseUrl: BASE, sessions, fetchFn });
    const result = await a.checkIn("greythr:KCC001", 12_345);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("CHECKED_IN");
    // No epoch in greytHR's payload -> fall back to the caller's clock.
    expect(result.recordedAtMs).toBe(12_345);
  });

  it("posts sign-out and maps the status", async () => {
    const sessions = storeWith("u1", "s1");
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(`${BASE}/api/attendance/sign-out`);
      return jsonResponse({
        success: true,
        data: { ok: true, status: "CHECKED_OUT", recordedAtMs: 42 },
        error: null,
      });
    }) as unknown as typeof fetch;

    const a = new GreytHrEssAttendanceAdapter({ baseUrl: BASE, sessions, fetchFn });
    const result = await a.checkOut("u1", 7);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("CHECKED_OUT");
    expect(result.recordedAtMs).toBe(42);
  });

  it("returns ok:false (never throws, never calls fetch) when the user has no greytHR session", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const a = new GreytHrEssAttendanceAdapter({
      baseUrl: BASE,
      sessions: new InMemoryGreytHrSessionStore(),
      fetchFn,
    });
    const result = await a.checkIn("dev:nobody", 123);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("CHECKED_IN");
    expect(result.recordedAtMs).toBe(123); // falls back to the caller's clock
    expect(result.reason).toMatch(/sign in/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("drops the session and degrades on a 401 (expired session)", async () => {
    const sessions = storeWith("u1", "stale");
    const fetchFn = vi.fn(async () =>
      jsonResponse(
        { success: false, data: null, error: { code: "UNAUTHORIZED", message: "expired" } },
        401,
      ),
    ) as unknown as typeof fetch;

    const a = new GreytHrEssAttendanceAdapter({ baseUrl: BASE, sessions, fetchFn });
    const result = await a.checkIn("u1", 5);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/expired/i);
    // The dead session is removed so the user is prompted to sign in again.
    expect(sessions.get("u1")).toBeNull();
  });

  it("degrades gracefully on a network error (returns ok:false, does not throw)", async () => {
    const sessions = storeWith("u1", "s1");
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const a = new GreytHrEssAttendanceAdapter({ baseUrl: BASE, sessions, fetchFn });
    const result = await a.checkOut("u1", 5);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("CHECKED_OUT");
    expect(result.reason).toMatch(/network/i);
  });

  it("getStatus reads /api/attendance/status and maps a live signed-in snapshot", async () => {
    const sessions = storeWith("greythr:KCC001", "sess-abc");
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`${BASE}/api/attendance/status`);
      expect(init?.method).toBe("GET");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sess-abc");
      return jsonResponse({
        success: true,
        data: {
          signedIn: true,
          nextAction: "sign-out",
          firstInTime: "2026-06-08T04:15:28.352487",
          lastOutTime: null,
          workLocationId: 81,
          allowLocationSelection: true,
          shift: { name: "9:00 AM -6:30 PM", startTime: "09:00:00", endTime: "18:30:00" },
          locations: [
            { id: 81, code: "OFF", description: "Office" },
            { id: 80, code: "WFH", description: "Work from Home" },
          ],
        },
        error: null,
      });
    }) as unknown as typeof fetch;

    const a = new GreytHrEssAttendanceAdapter({ baseUrl: BASE, sessions, fetchFn });
    const snap = await a.getStatus("greythr:KCC001");
    expect(snap?.status).toBe("CHECKED_IN");
    // "2026-06-08T04:15:28.352487" is naive UTC -> 09:45:28 IST. Assert the
    // exact UTC epoch so the test is timezone-independent.
    expect(snap?.firstInMs).toBe(Date.parse("2026-06-08T04:15:28.352Z"));
    expect(snap?.lastOutMs).toBeNull();
    expect(snap?.workLocation).toBe("Office");
    expect(snap?.workLocationId).toBe(81);
    expect(snap?.allowLocationSelection).toBe(true);
    expect(snap?.locations).toEqual([
      { id: 81, description: "Office" },
      { id: 80, description: "Work from Home" },
    ]);
    expect(snap?.shiftName).toBe("9:00 AM -6:30 PM");
  });

  it("getStatus maps a signed-out snapshot (signedIn:false with a last-out time)", async () => {
    const sessions = storeWith("u1", "s1");
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        success: true,
        data: {
          signedIn: false,
          lastOutTime: "2026-06-08T14:34:00Z",
          firstInTime: "2026-06-08T04:15:28.352487",
          workLocationId: null,
          allowLocationSelection: false,
          locations: [],
        },
        error: null,
      }),
    ) as unknown as typeof fetch;
    const a = new GreytHrEssAttendanceAdapter({ baseUrl: BASE, sessions, fetchFn });
    const snap = await a.getStatus("u1");
    expect(snap?.status).toBe("CHECKED_OUT");
    expect(snap?.lastOutMs).toBe(Date.parse("2026-06-08T14:34:00Z"));
    expect(snap?.workLocation).toBeNull();
    expect(snap?.allowLocationSelection).toBe(false);
    expect(snap?.locations).toEqual([]);
  });

  it("posts sign-in with the chosen work location in the body", async () => {
    const sessions = storeWith("u1", "s1");
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({ attLocation: 80 });
      return jsonResponse({
        success: true,
        data: { action: "sign-in", performed: true, status: { signedIn: true } },
        error: null,
      });
    }) as unknown as typeof fetch;
    const a = new GreytHrEssAttendanceAdapter({ baseUrl: BASE, sessions, fetchFn });
    const result = await a.checkIn("u1", 123, { attLocation: 80 });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("CHECKED_IN");
  });

  it("posts sign-out WITHOUT a body (no location needed)", async () => {
    const sessions = storeWith("u1", "s1");
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBeUndefined();
      return jsonResponse({
        success: true,
        data: { action: "sign-out", performed: true, status: { signedIn: false } },
        error: null,
      });
    }) as unknown as typeof fetch;
    const a = new GreytHrEssAttendanceAdapter({ baseUrl: BASE, sessions, fetchFn });
    const result = await a.checkOut("u1", 123);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("CHECKED_OUT");
  });

  it("getStatus returns null (and never fetches) when the user has no session", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const a = new GreytHrEssAttendanceAdapter({
      baseUrl: BASE,
      sessions: new InMemoryGreytHrSessionStore(),
      fetchFn,
    });
    expect(await a.getStatus("nobody")).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("getStatus drops the session and returns null on a 401", async () => {
    const sessions = storeWith("u1", "stale");
    const fetchFn = vi.fn(async () =>
      jsonResponse({ success: false, data: null, error: { code: "UNAUTHORIZED" } }, 401),
    ) as unknown as typeof fetch;
    const a = new GreytHrEssAttendanceAdapter({ baseUrl: BASE, sessions, fetchFn });
    expect(await a.getStatus("u1")).toBeNull();
    expect(sessions.get("u1")).toBeNull();
  });

  it("getStatus degrades to null on a network error (never throws)", async () => {
    const sessions = storeWith("u1", "s1");
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const a = new GreytHrEssAttendanceAdapter({ baseUrl: BASE, sessions, fetchFn });
    await expect(a.getStatus("u1")).resolves.toBeNull();
  });

  it("lookupEmployee/syncDepartments degrade to null/[] (not part of the swipe path)", async () => {
    const a = new GreytHrEssAttendanceAdapter({
      baseUrl: BASE,
      sessions: new InMemoryGreytHrSessionStore(),
    });
    expect(await a.lookupEmployee("x@y.com")).toBeNull();
    expect(await a.syncDepartments()).toEqual([]);
  });
});
