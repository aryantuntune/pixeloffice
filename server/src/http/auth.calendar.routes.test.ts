// ---------------------------------------------------------------------------
// Google Calendar connect routes — connect 302, state validation, callback
// refresh-token storage, status, disconnect. Mocked fetch; no network.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuthRouter, type GoogleCalendarConnectDeps } from "./auth.routes";
import type { AuthConfig } from "../auth/auth-config";
import { JwtService } from "../auth/jwt.service";
import { createState } from "../auth/oauth-state";
import { InMemoryUserRepository } from "../repositories/user.repository";
import { InMemoryGoogleTokenStore } from "../auth/google-token.store";
import type { FetchLike } from "../auth/oauth-provider";

const SECRET = "calendar-routes-secret";

function makeConfig(): AuthConfig {
  const jwt = new JwtService({ secret: SECRET, warn: () => {} });
  return {
    jwt,
    providers: new Map(),
    adminEmails: new Set<string>(),
    defaultDepartment: "Engineering",
    clientAppUrl: "http://localhost:5173",
    authRequired: false,
    stateSecret: jwt.secretForState(),
    allowedEmailDomains: new Set<string>(),
  };
}

function fakeTokenFetch(body: unknown, ok = true): FetchLike {
  return async () => ({
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

async function boot(gc?: Partial<GoogleCalendarConnectDeps>, tokens = new InMemoryGoogleTokenStore()) {
  const config = makeConfig();
  const googleCalendar: GoogleCalendarConnectDeps | undefined = gc
    ? {
        clientId: "cid",
        clientSecret: "sec",
        redirectBase: "http://localhost:2567",
        authBase: "https://auth.test",
        tokenBase: "https://token.test",
        tokens,
        resolveSessionUserId: (sid: string) => (sid === "S1" ? "google:abc" : null),
        fetchImpl: fakeTokenFetch({ refresh_token: "RT", scope: "cal" }),
        ...gc,
      }
    : undefined;
  const app = express();
  app.use(express.json());
  app.use("/api/auth", createAuthRouter({ config, users: new InMemoryUserRepository(), googleCalendar }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}`, config, tokens };
}

describe("Google Calendar connect routes", () => {
  let server: Server;
  afterEach(() => server?.close());

  it("404s every calendar route when Google is not configured", async () => {
    let base: string;
    ({ server, base } = await boot(undefined));
    for (const path of [
      "/api/auth/google/calendar/connect?sessionId=S1",
      "/api/auth/google/calendar/status?sessionId=S1",
    ]) {
      const res = await fetch(`${base}${path}`, { redirect: "manual" });
      expect(res.status).toBe(404);
    }
  });

  it("connect 302s to Google consent with offline+consent+read/write-owned event scopes", async () => {
    let base: string;
    ({ server, base } = await boot({}));
    const res = await fetch(`${base}/api/auth/google/calendar/connect?sessionId=S1`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location")!;
    expect(loc).toContain("https://auth.test/o/oauth2/v2/auth");
    expect(loc).toContain("access_type=offline");
    expect(loc).toContain("prompt=consent");
    expect(loc).toContain("include_granted_scopes=true");
    expect(loc).toContain(encodeURIComponent("https://www.googleapis.com/auth/calendar.events.readonly"));
    expect(loc).toContain(encodeURIComponent("https://www.googleapis.com/auth/calendar.events.owned"));
    expect(loc).toContain("state=");
  });

  it("connect 400s for an unknown session (e.g. an NPC)", async () => {
    let base: string;
    ({ server, base } = await boot({}));
    const res = await fetch(`${base}/api/auth/google/calendar/connect?sessionId=NPC`, {
      redirect: "manual",
    });
    expect(res.status).toBe(400);
  });

  it("callback stores the refresh token and redirects #calendar=connected", async () => {
    let base: string;
    let config: AuthConfig;
    let tokens: InMemoryGoogleTokenStore;
    ({ server, base, config, tokens } = await boot({}));
    const state = createState(config.stateSecret, { userId: "google:abc" });
    const res = await fetch(
      `${base}/api/auth/google/calendar/callback?code=AC&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("#calendar=connected");
    expect(tokens.get("google:abc")?.refreshToken).toBe("RT");
  });

  it("callback rejects a tampered/invalid state with 400", async () => {
    let base: string;
    ({ server, base } = await boot({}));
    const res = await fetch(`${base}/api/auth/google/calendar/callback?code=AC&state=tampered`, {
      redirect: "manual",
    });
    expect(res.status).toBe(400);
  });

  it("callback redirects #calendar=error when no refresh_token is returned", async () => {
    let base: string;
    let config: AuthConfig;
    ({ server, base, config } = await boot({ fetchImpl: fakeTokenFetch({ scope: "cal" }) }));
    const state = createState(config.stateSecret, { userId: "google:abc" });
    const res = await fetch(
      `${base}/api/auth/google/calendar/callback?code=AC&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("#calendar=error");
  });

  it("status reflects connected true/false and disconnect deletes the grant", async () => {
    let base: string;
    let tokens: InMemoryGoogleTokenStore;
    ({ server, base, tokens } = await boot({}));

    let res = await fetch(`${base}/api/auth/google/calendar/status?sessionId=S1`);
    expect(await res.json()).toEqual({ connected: false });

    tokens.save("google:abc", { refreshToken: "RT" });
    res = await fetch(`${base}/api/auth/google/calendar/status?sessionId=S1`);
    expect(await res.json()).toEqual({ connected: true });

    res = await fetch(`${base}/api/auth/google/calendar/disconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "S1" }),
    });
    expect(await res.json()).toEqual({ connected: false });
    expect(tokens.get("google:abc")).toBeNull();
  });
});
