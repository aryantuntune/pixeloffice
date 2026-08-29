// ---------------------------------------------------------------------------
// Regression test for the incident: a rejected async route handler (e.g. a
// dead Redis token store) must turn into a 500 response, not an unhandled
// promise rejection that kills the whole process. See server/src/index.ts
// (express-async-errors import) and CHANGES to redis.ts retryStrategy.
// ---------------------------------------------------------------------------

import "express-async-errors";
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuthRouter, type GoogleCalendarConnectDeps } from "./auth.routes";
import type { AuthConfig } from "../auth/auth-config";
import { JwtService } from "../auth/jwt.service";
import { InMemoryUserRepository } from "../repositories/user.repository";
import type { GoogleTokenStore } from "../auth/google-token.store";

function makeConfig(): AuthConfig {
  const jwt = new JwtService({ secret: "s", warn: () => {} });
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

/** Simulates a dead Redis connection: every call rejects, like ioredis's
 * "Connection is closed" once the client gives up reconnecting. */
class RejectingTokenStore implements GoogleTokenStore {
  async save(): Promise<void> {
    throw new Error("Connection is closed.");
  }
  async get(): Promise<null> {
    throw new Error("Connection is closed.");
  }
  async delete(): Promise<void> {
    throw new Error("Connection is closed.");
  }
  async connectedUserIds(): Promise<string[]> {
    throw new Error("Connection is closed.");
  }
}

describe("async route rejection does not crash the process", () => {
  let server: Server;
  afterEach(() => server?.close());

  it("GET /google/calendar/status returns 500 instead of an unhandled rejection", async () => {
    const config = makeConfig();
    const googleCalendar: GoogleCalendarConnectDeps = {
      clientId: "cid",
      clientSecret: "sec",
      redirectBase: "http://localhost:2567",
      authBase: "https://auth.test",
      tokenBase: "https://token.test",
      tokens: new RejectingTokenStore(),
      resolveSessionUserId: (sid: string) => (sid === "S1" ? "google:abc" : null),
    };
    const app = express();
    app.use(express.json());
    app.use("/api/auth", createAuthRouter({ config, users: new InMemoryUserRepository(), googleCalendar }));
    // Same terminal error handler shape as server/src/index.ts.
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: "Internal server error" });
    });

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/api/auth/google/calendar/status?sessionId=S1`);
    expect(res.status).toBe(500);
  });
});
