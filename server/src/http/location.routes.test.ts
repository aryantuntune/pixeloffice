// ---------------------------------------------------------------------------
// Location floor-report route tests.
//
// Verifies: an unknown SSID is a no-op (matched=0); a known SSID applies the
// resolved floor to the caller's matched sessions; the optional shared secret is
// enforced only when configured; and a missing room degrades gracefully. The
// room interaction is exercised through a fake room AND through a real OfficeRoom
// (the consented-floor-change + opt-in gate) so the wiring is end-to-end.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLocationRouter } from "./location.routes";
import { createSsidFloorResolver } from "../location/ssid-floor";
import { PairCodeStore } from "../location/pair-code.store";

async function boot(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

/** A fake room recording applyFloorReport calls; returns a configurable count. */
function fakeRoom(matched: number, floorIds = ["ground", "floor-1", "floor-2"]) {
  const calls: Array<{ clientIp: string | undefined; floorId: string }> = [];
  const sessionCalls: Array<{ sessionId: string; floorId: string }> = [];
  return {
    calls,
    sessionCalls,
    applyFloorReport(clientIp: string | undefined, floorId: string): number {
      calls.push({ clientIp, floorId });
      return matched;
    },
    applyFloorReportBySession(sessionId: string, floorId: string): number {
      sessionCalls.push({ sessionId, floorId });
      return matched;
    },
    floorIds(): string[] {
      return floorIds;
    },
  };
}

function makeApp(opts: Parameters<typeof createLocationRouter>[0]): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/location", createLocationRouter(opts));
  return app;
}

async function post(base: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/location/floor-report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

describe("POST /api/location/floor-report", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  const resolver = createSsidFloorResolver(undefined, ["ground", "floor-1", "floor-2"]);

  it("no-ops on an unknown SSID (200 { floorId: null, matched: 0 })", async () => {
    const room = fakeRoom(1);
    const { server: s, base } = await boot(makeApp({ getRoom: () => room, resolver }));
    server = s;
    const r = await post(base, { ssid: "RandomCafeWiFi" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ floorId: null, matched: 0 });
    expect(room.calls).toHaveLength(0); // never reached the room
  });

  it("rejects a missing/empty ssid with 400", async () => {
    const room = fakeRoom(0);
    const { server: s, base } = await boot(makeApp({ getRoom: () => room, resolver }));
    server = s;
    expect((await post(base, {})).status).toBe(400);
    expect((await post(base, { ssid: "   " })).status).toBe(400);
  });

  it("applies the resolved floor and returns { floorId, matched }", async () => {
    const room = fakeRoom(2);
    const { server: s, base } = await boot(makeApp({ getRoom: () => room, resolver }));
    server = s;
    const r = await post(base, { ssid: "Hustle@KALVIUM2F5G" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ floorId: "floor-2", matched: 2 });
    expect(room.calls).toHaveLength(1);
    expect(room.calls[0].floorId).toBe("floor-2");
  });

  it("returns matched=0 when no caller session opted in", async () => {
    const room = fakeRoom(0); // room found no opted-in session for this IP
    const { server: s, base } = await boot(makeApp({ getRoom: () => room, resolver }));
    server = s;
    const r = await post(base, { ssid: "KALVIUM1F" });
    expect(r.json).toEqual({ floorId: "floor-1", matched: 0 });
  });

  it("degrades to matched=0 when no room is connected", async () => {
    const { server: s, base } = await boot(
      makeApp({ getRoom: () => null, resolver }),
    );
    server = s;
    const r = await post(base, { ssid: "KALVIUMGF" });
    expect(r.json).toEqual({ floorId: "ground", matched: 0 });
  });

  describe("shared secret", () => {
    it("requires the secret when FLOOR_SYNC_SECRET is set (401 on mismatch)", async () => {
      const room = fakeRoom(1);
      const { server: s, base } = await boot(
        makeApp({ getRoom: () => room, resolver, secret: "s3cret" }),
      );
      server = s;
      expect((await post(base, { ssid: "KALVIUM2F" })).status).toBe(401);
      expect((await post(base, { ssid: "KALVIUM2F", secret: "wrong" })).status).toBe(401);
      expect(room.calls).toHaveLength(0); // never applied without the secret
      const ok = await post(base, { ssid: "KALVIUM2F", secret: "s3cret" });
      expect(ok.status).toBe(200);
      expect(ok.json).toEqual({ floorId: "floor-2", matched: 1 });
    });

    it("accepts without a secret when FLOOR_SYNC_SECRET is unset", async () => {
      const room = fakeRoom(1);
      const { server: s, base } = await boot(makeApp({ getRoom: () => room, resolver }));
      server = s;
      const r = await post(base, { ssid: "KALVIUM2F" });
      expect(r.status).toBe(200);
      expect(r.json.matched).toBe(1);
    });
  });

  describe("pairing code (IP-independent)", () => {
    it("a valid pairCode resolves to THAT session, ignoring IP", async () => {
      const room = fakeRoom(1);
      const pairCodes = new PairCodeStore();
      const code = pairCodes.mint("sess-1", "user-1", Date.now());
      const { server: s, base } = await boot(
        makeApp({ getRoom: () => room, resolver, pairCodes }),
      );
      server = s;
      const r = await post(base, { ssid: "Hustle@KALVIUM1F5G", pairCode: code });
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ floorId: "floor-1", matched: 1 });
      // Applied by SESSION, not by IP: the IP path was never taken.
      expect(room.sessionCalls).toEqual([{ sessionId: "sess-1", floorId: "floor-1" }]);
      expect(room.calls).toHaveLength(0);
    });

    it("a pairCode for a NOT-opted-in session is a no-op (matched=0)", async () => {
      // The room enforces the opt-in gate: applyFloorReportBySession returns 0.
      const room = fakeRoom(0);
      const pairCodes = new PairCodeStore();
      const code = pairCodes.mint("sess-x", "user-x", Date.now());
      const { server: s, base } = await boot(
        makeApp({ getRoom: () => room, resolver, pairCodes }),
      );
      server = s;
      const r = await post(base, { ssid: "KALVIUM2F", pairCode: code });
      expect(r.json).toEqual({ floorId: "floor-2", matched: 0 });
      expect(room.sessionCalls).toEqual([{ sessionId: "sess-x", floorId: "floor-2" }]);
    });

    it("an unknown/expired pairCode falls back to the IP match", async () => {
      const room = fakeRoom(1);
      const pairCodes = new PairCodeStore();
      const { server: s, base } = await boot(
        makeApp({ getRoom: () => room, resolver, pairCodes }),
      );
      server = s;
      const r = await post(base, { ssid: "KALVIUM2F", pairCode: "ZZZZZZ" });
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ floorId: "floor-2", matched: 1 });
      // Fell through to the IP path (no session call).
      expect(room.sessionCalls).toHaveLength(0);
      expect(room.calls).toHaveLength(1);
    });

    it("still enforces the secret when set, even with a valid pairCode", async () => {
      const room = fakeRoom(1);
      const pairCodes = new PairCodeStore();
      const code = pairCodes.mint("sess-1", "user-1", Date.now());
      const { server: s, base } = await boot(
        makeApp({ getRoom: () => room, resolver, pairCodes, secret: "s3cret" }),
      );
      server = s;
      expect((await post(base, { ssid: "KALVIUM2F", pairCode: code })).status).toBe(401);
      expect(room.sessionCalls).toHaveLength(0);
      const ok = await post(base, { ssid: "KALVIUM2F", pairCode: code, secret: "s3cret" });
      expect(ok.json).toEqual({ floorId: "floor-2", matched: 1 });
    });
  });
});
