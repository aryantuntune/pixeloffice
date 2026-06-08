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

// Must be first: load .env before the container reads process.env.
import "./load-env";
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

  // CORS: don't use wildcard `*` (so a logged-in user's other tabs/sites cannot
  // cross-origin read the API — roster PII, session claims). CONTRACT.md: "CORS
  // enabled for the Vite origin". When CORS_ORIGINS/CLIENT_APP_URL is set we honor
  // that exact allowlist (production). Otherwise we reflect any localhost/LAN
  // origin on the Vite dev (5173) or preview (4173) port — this keeps the
  // ship-tested flows working: dev, `vite preview`, and a teammate joining over
  // the LAN by IP (a real feature) — without ever opening the API to the wider web.
  const explicitOrigins = (process.env.CORS_ORIGINS ?? process.env.CLIENT_APP_URL ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const VITE_PORTS = new Set(["5173", "4173"]);
  const corsOrigin: cors.CorsOptions["origin"] = explicitOrigins.length
    ? explicitOrigins
    : (origin, cb) => {
        if (!origin) return cb(null, true); // same-origin / curl / server-to-server
        try {
          const u = new URL(origin);
          const localish =
            u.hostname === "localhost" ||
            u.hostname === "127.0.0.1" ||
            /^(10|127)\./.test(u.hostname) ||
            /^192\.168\./.test(u.hostname) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname);
          return cb(null, localish && VITE_PORTS.has(u.port));
        } catch {
          return cb(null, false);
        }
      };
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json());

  // Behind a vetted reverse proxy (the single-container prod deploy), trust the
  // forwarded chain so the rate limiter keys off the real client IP rather than
  // collapsing every user into the proxy's single bucket. Off by default.
  const trustProxy = ["true", "1", "yes"].includes((process.env.TRUST_PROXY ?? "").toLowerCase());
  if (trustProxy) app.set("trust proxy", true);

  // Rate limit the REST API (60 req/min/IP; GET /api/health auto-skipped).
  app.use(
    "/api",
    createRateLimiter({
      capacity: Number(process.env.API_RATE_LIMIT ?? 60),
      windowMs: Number(process.env.API_RATE_WINDOW_MS ?? 60_000),
      trustProxy,
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
      // greytHR login routes — present only when greytHR login is enabled.
      ...(container.greytHrAuth && container.greytHrLoginConfig
        ? {
            greytHrLogin: {
              service: container.greytHrAuth,
              subdomain: container.greytHrLoginConfig.subdomain,
            },
          }
        : {}),
      // Google Calendar connect flow — present only when Google OAuth creds are
      // set (else the calendar routes 404). Endpoint bases are env-overridable
      // so a local stub can stand in for Google.
      ...(container.googleCalConfigured
        ? {
            googleCalendar: {
              clientId: process.env.GOOGLE_CLIENT_ID!.trim(),
              clientSecret: process.env.GOOGLE_CLIENT_SECRET!.trim(),
              redirectBase: (process.env.OAUTH_REDIRECT_BASE ?? `http://localhost:${PORT}`).trim(),
              authBase: process.env.GOOGLE_AUTH_BASE ?? "https://accounts.google.com",
              tokenBase: process.env.GOOGLE_TOKEN_BASE ?? "https://oauth2.googleapis.com",
              tokens: container.googleTokenStore,
              resolveSessionUserId(sessionId: string): string | null {
                const room = container.registry.room;
                if (!room) return null;
                const p = room.listPlayers().find((pl) => pl.sessionId === sessionId);
                if (!p || p.isNpc) return null; // NPCs never connect a calendar
                return p.userId;
              },
            },
          }
        : {}),
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
      portalUrl: container.hrPortalUrl,
      // greytHR derives the employee from the session, so never resolve by email.
      resolveEmployeeByEmail: false,
      // Wire the auth gate so AUTH_REQUIRED actually enforces JWT identity on the
      // attendance routes in production (without this, the IDOR-closing guard is
      // never installed and identity falls back to the client-supplied sessionId).
      auth: {
        jwt: container.authConfig.jwt,
        required: container.authConfig.authRequired,
      },
      resolveSession(sessionId): SessionUser | null {
        const room = container.registry.room;
        if (!room) return null;
        const p = room.listPlayers().find((pl) => pl.sessionId === sessionId);
        if (!p) return null;
        // Ambient NPCs are not real users and must never touch HR (plan rule):
        // refuse to resolve an NPC sessionId to an attendance identity.
        if (p.isNpc) return null;
        // No real OAuth email on the dev path -> derive one so the mock yields
        // hits. When OAuth provides a real email, surface it here instead.
        return { userId: p.userId, name: p.name, email: emailForName(p.name) };
      },
    }),
  );

  // Uniform JSON 404 for unmatched /api routes (every real handler returns
  // {error}). Registered AFTER the API routers but BEFORE the SPA fallback so an
  // unknown /api path is never served index.html nor the Express HTML 404 page.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Static client (single-container production image). Registered LAST so the
  // SPA fallback never swallows /api routes. Off unless SERVE_CLIENT=true.
  if (shouldServeClient()) {
    mountStaticClient(app);
  }

  // Terminal error handler: log server-side, return a generic JSON body. Without
  // this Express's default finalhandler serializes err.stack (absolute paths,
  // internal frames) into the response — reachable unauthenticated by POSTing
  // malformed JSON to any /api route. Never echo err.message/err.stack.
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("[PixelOffice] unhandled request error:", err);
    if (res.headersSent) {
      next(err);
      return;
    }
    const status =
      typeof err === "object" && err !== null && "status" in err && typeof (err as { status: unknown }).status === "number"
        ? (err as { status: number }).status
        : typeof err === "object" && err !== null && "statusCode" in err && typeof (err as { statusCode: unknown }).statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 500;
    res.status(status).json({ error: "Internal server error" });
  });

  const httpServer = createServer(app);

  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
    // Our lifecycle module owns SIGINT/SIGTERM; Colyseus's built-in handler
    // would race it and log "already_shutting_down" (seen in live logs).
    gracefullyShutdown: false,
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
      // Stop the Google Calendar background poll loop on shutdown (no-op when
      // unconfigured). Wrap stop() as the closable close() contract.
      ...(container.googleCalendar
        ? [{ close: () => container.googleCalendar!.stop() }]
        : []),
    ],
  });
}

void main();

function readPort(): number {
  const raw = process.env.PORT;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SERVER_PORT;
}
