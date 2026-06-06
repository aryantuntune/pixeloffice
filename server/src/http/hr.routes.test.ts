// ---------------------------------------------------------------------------
// HR routes — identity / IDOR tests.
//
// Verifies that under AUTH_REQUIRED the acting user is taken from the verified
// JWT and a body-supplied sessionId cannot impersonate another user, while the
// zero-config dev path still resolves identity from a live sessionId.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHrRouter, type SessionUser } from "./hr.routes";
import { AttendanceService } from "../integrations/hr/attendance.service";
import { MockGreytHrAdapter } from "../integrations/hr/mock-greythr.adapter";
import { JwtService } from "../auth/jwt.service";

function makeApp(deps: Parameters<typeof createHrRouter>[0]): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/hr", createHrRouter(deps));
  return app;
}

async function boot(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe("HR routes — auth required (IDOR closed)", () => {
  let server: Server;
  let base: string;
  let attendance: AttendanceService;
  const jwt = new JwtService({ secret: "hr-test-secret", warn: () => {} });

  // A live session table the resolver reads from. The "victim" has a live
  // Colyseus session whose id is broadcast to everyone in the real protocol.
  const sessions: Record<string, SessionUser> = {
    "victim-session": { userId: "victim", name: "Victim", email: "victim@x.dev" },
    "attacker-session": { userId: "attacker", name: "Attacker", email: "attacker@x.dev" },
  };

  beforeEach(async () => {
    attendance = new AttendanceService(new MockGreytHrAdapter());
    const app = makeApp({
      attendance,
      hr: new MockGreytHrAdapter(),
      resolveSession: (sid) => sessions[sid] ?? null,
      auth: { jwt, required: true },
      now: () => 1000,
    });
    ({ server, base } = await boot(app));
  });

  afterEach(() => {
    server.close();
  });

  it("rejects an unauthenticated check-in (no token) with 401", async () => {
    const res = await fetch(`${base}/api/hr/check-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "victim-session" }),
    });
    expect(res.status).toBe(401);
    // The victim must not have been checked in.
    expect(attendance.getState("victim").status).toBe("NOT_CHECKED_IN");
  });

  it("checks in the TOKEN subject, ignoring a victim sessionId in the body", async () => {
    const token = jwt.sign({
      sub: "attacker",
      email: "attacker@x.dev",
      name: "Attacker",
      role: "member",
    });
    const res = await fetch(`${base}/api/hr/check-in`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      // Attacker supplies the victim's broadcast sessionId.
      body: JSON.stringify({ sessionId: "victim-session" }),
    });
    // Rejected because the supplied session belongs to a different user.
    expect(res.status).toBe(403);
    expect(attendance.getState("victim").status).toBe("NOT_CHECKED_IN");
    expect(attendance.getState("attacker").status).toBe("NOT_CHECKED_IN");
  });

  it("checks in the authenticated user when no/own sessionId is supplied", async () => {
    const token = jwt.sign({
      sub: "attacker",
      email: "attacker@x.dev",
      name: "Attacker",
      role: "member",
    });
    const res = await fetch(`${base}/api/hr/check-in`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("CHECKED_IN");
    expect(attendance.getState("attacker").status).toBe("CHECKED_IN");
    // The victim is untouched.
    expect(attendance.getState("victim").status).toBe("NOT_CHECKED_IN");
  });

  it("status reflects the token subject, not a supplied sessionId", async () => {
    await attendance.checkIn("attacker", 500);
    const token = jwt.sign({
      sub: "attacker",
      email: "attacker@x.dev",
      name: "Attacker",
      role: "member",
    });
    const res = await fetch(`${base}/api/hr/status?sessionId=victim-session`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });
});

describe("HR routes — dev path (no auth)", () => {
  let server: Server;
  let base: string;
  let attendance: AttendanceService;

  const sessions: Record<string, SessionUser> = {
    "alice-session": { userId: "alice", name: "Alice", email: "alice@x.dev" },
  };

  beforeEach(async () => {
    attendance = new AttendanceService(new MockGreytHrAdapter());
    const app = makeApp({
      attendance,
      hr: new MockGreytHrAdapter(),
      resolveSession: (sid) => sessions[sid] ?? null,
      now: () => 1000,
    });
    ({ server, base } = await boot(app));
  });

  afterEach(() => {
    server.close();
  });

  it("resolves identity from a live sessionId (open dev console)", async () => {
    const res = await fetch(`${base}/api/hr/check-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "alice-session" }),
    });
    expect(res.status).toBe(200);
    expect(attendance.getState("alice").status).toBe("CHECKED_IN");
  });

  it("400s when no sessionId is supplied", async () => {
    const res = await fetch(`${base}/api/hr/check-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("404s for an unknown sessionId", async () => {
    const res = await fetch(`${base}/api/hr/check-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ghost" }),
    });
    expect(res.status).toBe(404);
  });
});
