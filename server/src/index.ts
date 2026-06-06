// ---------------------------------------------------------------------------
// Server entry point: Express (admin/auth/hr REST + CORS) + Colyseus (the
// office room).
//
// The HTTP server is shared between Express and the Colyseus WebSocket
// transport so both live on one port. Services are constructed once in the
// container and injected into the room and routes.
//
// Everything beyond the original MVP is opt-in: the rate limiter and shutdown
// are dependency-free; the auth/hr routers are no-ops on the dev path (no
// providers, mock HR); static client serving is off unless SERVE_CLIENT=true;
// persistence stays in-memory unless DATABASE_URL/REDIS_URL are set. The
// zero-config `npm install && npm run dev` path is unchanged.
// ---------------------------------------------------------------------------

import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { DEFAULT_SERVER_PORT, ROOM_NAME } from "@pixeloffice/shared";
import { OfficeRoom } from "./rooms/office.room";
import { createAdminRouter } from "./http/admin.routes";
import { createAuthRouter } from "./http/auth.routes";
import { createHrRouter, type SessionUser } from "./http/hr.routes";
import { emailForName } from "./integrations/hr/mock-greythr.adapter";
import { createRateLimiter } from "./http/rate-limit";
import { mountStaticClient, shouldServeClient } from "./http/static-client";
import { installShutdown } from "./lifecycle/shutdown";
import { container, initContainer } from "./container";

const PORT = readPort();

async function main(): Promise<void> {
  // Resolve env-driven persistence (Postgres/Redis) before serving. With no env
  // vars this is a no-op (in-memory); a configured-but-down store degrades to
  // in-memory here and never crashes boot.
  await initContainer();

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Rate limit the REST API (60 req/min/IP; GET /api/health auto-skipped).
  app.use(
    "/api",
    createRateLimiter({
      capacity: Number(process.env.API_RATE_LIMIT ?? 60),
      windowMs: Number(process.env.API_RATE_WINDOW_MS ?? 60_000),
    }),
  );

  // Admin REST (events / meetings / broadcast / users / health). The router
  // guards protected writes itself when AUTH_REQUIRED=true (open in dev).
  app.use("/api", createAdminRouter());

  // OAuth + session routes. With no providers configured the login/callback
  // routes 404 and /config reports an empty provider list (dev path unaffected).
  app.use(
    "/api/auth",
    createAuthRouter({
      config: container.authConfig,
      users: container.users,
    }),
  );

  // HR / GreytHR routes. Resolves a live sessionId -> the user behind it so the
  // client can never act for someone else. Uses the mock adapter unless GreytHR
  // env is set; the client widget self-hides when status 404s.
  app.use(
    "/api/hr",
    createHrRouter({
      attendance: container.attendance,
      hr: container.hr,
      resolveSession(sessionId): SessionUser | null {
        const room = container.registry.room;
        if (!room) return null;
        const p = room.listPlayers().find((pl) => pl.sessionId === sessionId);
        if (!p) return null;
        // No real OAuth email on the dev path -> derive one so the mock yields
        // hits. When OAuth provides a real email, surface it here instead.
        return { userId: p.userId, name: p.name, email: emailForName(p.name) };
      },
    }),
  );

  // Static client (single-container production image). Registered LAST so the
  // SPA fallback never swallows /api routes. Off unless SERVE_CLIENT=true.
  if (shouldServeClient()) {
    mountStaticClient(app);
  }

  const httpServer = createServer(app);

  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
  });

  gameServer.define(ROOM_NAME, OfficeRoom);

  httpServer.listen(PORT, () => {
    console.log(
      `[PixelOffice] server listening on http://localhost:${PORT} ` +
        `(ws room "${ROOM_NAME}", REST under /api)`,
    );
  });

  // Graceful shutdown: broadcast a restart toast, drain Colyseus, close HTTP,
  // and end any datastore connections (best-effort), with an 8s hard-exit
  // failsafe (Reliability: recover from service restarts).
  installShutdown({
    gameServer,
    httpServer,
    getRoom: () => container.registry.room,
    closables: [
      ...(container.database ? [container.database] : []),
      ...(container.redis ? [container.redis] : []),
    ],
  });
}

void main();

function readPort(): number {
  const raw = process.env.PORT;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SERVER_PORT;
}
