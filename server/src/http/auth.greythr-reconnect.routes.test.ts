// ---------------------------------------------------------------------------
// Auth routes — POST /api/auth/greythr/reconnect.
//
// Verifies the in-place greytHR session refresh: a user who is ALREADY in the
// office (valid PixelOffice JWT) re-enters only their greytHR password to
// repopulate the session store, WITHOUT minting a new office JWT. Identity (the
// Employee No to log in with) is derived from the verified token, never the
// body, so a user can only ever reconnect their OWN account.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuthRouter } from "./auth.routes";
import type { AuthConfig } from "../auth/auth-config";
import { JwtService } from "../auth/jwt.service";
import { InMemoryUserRepository } from "../repositories/user.repository";
import type { GreytHrAuthService } from "../auth/greythr/greythr-auth.service";
import type { GreytHrLoginInput } from "../integrations/greythr/greythr-ess.client";

const SECRET = "reconnect-test-secret";

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

/** Records calls and lets each test control the login result. */
interface FakeService {
  service: GreytHrAuthService;
  logins: GreytHrLoginInput[];
  loggedOut: string[];
}

function fakeService(opts: {
  /** userId the login resolves to (defaults to "greythr:<loginId>"). */
  resolvedUserId?: (input: GreytHrLoginInput) => string;
  /** When set, loginWithCredentials throws this instead of resolving. */
  throwErr?: Error;
}): FakeService {
  const logins: GreytHrLoginInput[] = [];
  const loggedOut: string[] = [];
  const service = {
    async loginWithCredentials(input: GreytHrLoginInput) {
      logins.push(input);
      if (opts.throwErr) throw opts.throwErr;
      const userId = opts.resolvedUserId
        ? opts.resolvedUserId(input)
        : `greythr:${input.loginId}`;
      return {
        token: "ignored-fresh-token",
        profile: { userId } as never,
      };
    },
    async logout(userId: string) {
      loggedOut.push(userId);
    },
  } as unknown as GreytHrAuthService;
  return { service, logins, loggedOut };
}

async function boot(config: AuthConfig, svc: GreytHrAuthService): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/auth",
    createAuthRouter({
      config,
      users: new InMemoryUserRepository(),
      greytHrLogin: { service: svc, subdomain: "kalvium" },
    }),
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe("POST /api/auth/greythr/reconnect", () => {
  let server: Server;
  afterEach(() => server?.close());

  function tokenFor(config: AuthConfig, sub: string): string {
    return config.jwt.sign({ sub, email: "e@kalvium.com", name: "Emp", role: "member" });
  }

  it("401 without a bearer token", async () => {
    const config = makeConfig();
    const fake = fakeService({});
    let base: string;
    ({ server, base } = await boot(config, fake.service));
    const res = await fetch(`${base}/api/auth/greythr/reconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "pw" }),
    });
    expect(res.status).toBe(401);
    expect(fake.logins).toHaveLength(0);
  });

  it("400 when the identity is not a greytHR account", async () => {
    const config = makeConfig();
    const fake = fakeService({});
    let base: string;
    ({ server, base } = await boot(config, fake.service));
    const res = await fetch(`${base}/api/auth/greythr/reconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(config, "google:abc")}` },
      body: JSON.stringify({ password: "pw" }),
    });
    expect(res.status).toBe(400);
    expect(fake.logins).toHaveLength(0);
  });

  it("400 when the password is missing", async () => {
    const config = makeConfig();
    const fake = fakeService({});
    let base: string;
    ({ server, base } = await boot(config, fake.service));
    const res = await fetch(`${base}/api/auth/greythr/reconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(config, "greythr:KCC123")}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(fake.logins).toHaveLength(0);
  });

  it("reconnects with the Employee No derived from the token (not the body)", async () => {
    const config = makeConfig();
    const fake = fakeService({});
    let base: string;
    ({ server, base } = await boot(config, fake.service));
    const res = await fetch(`${base}/api/auth/greythr/reconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(config, "greythr:KCC123")}` },
      // A spoofed loginId in the body must be ignored.
      body: JSON.stringify({ password: "pw", loginId: "KCC999" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fake.logins).toHaveLength(1);
    expect(fake.logins[0].loginId).toBe("KCC123");
    expect(fake.logins[0].subdomain).toBe("kalvium");
  });

  it("403 + cleanup when credentials resolve to a different account", async () => {
    const config = makeConfig();
    const fake = fakeService({ resolvedUserId: () => "greythr:OTHER" });
    let base: string;
    ({ server, base } = await boot(config, fake.service));
    const res = await fetch(`${base}/api/auth/greythr/reconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(config, "greythr:KCC123")}` },
      body: JSON.stringify({ password: "pw" }),
    });
    expect(res.status).toBe(403);
    // The mismatched session that was just created must be dropped.
    expect(fake.loggedOut).toContain("greythr:OTHER");
  });
});
