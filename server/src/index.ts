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
import { networkInterfaces } from "node:os";
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

  // CORS: restrict to the client app origin instead of wildcard `*`, so a
  // logged-in user's other tabs/sites cannot cross-origin read the API (roster
  // PII, session claims). CONTRACT.md: "CORS enabled for the Vite origin".
  // CORS_ORIGINS (comma-separated) overrides; default is the client app URL.
  const corsOrigins = (process.env.CORS_ORIGINS ?? process.env.CLIENT_APP_URL ?? "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  // Vite dev (5173) and preview (4173) serve the client from a SEPARATE origin
  // than the API, so every REST/login call is cross-origin and triggers a CORS
  // preflight. Over a LAN the page origin is http://<lan-ip>:5173 — NOT in the
  // static allow-list — so without accepting it every API/login call fails with
  // an opaque "no response" (the preflight is rejected). In DEV ONLY we also
  // allow any host on the Vite dev/preview ports so `npm run dev` works from any
  // device on the network. In production the client is served same-origin
  // (SERVE_CLIENT) so this relaxation is gated OFF — prod uses only the explicit
  // CORS_ORIGINS/CLIENT_APP_URL allow-list, identical to before this change.
  const VITE_DEV_PORTS = new Set(["5173", "4173"]);
  const corsAllowList = new Set(corsOrigins);
  const allowViteDevPorts =
    process.env.NODE_ENV !== "production" && !shouldServeClient();
  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header = non-browser or same-origin (curl, health checks,
        // server-to-server) — always allow.
        if (!origin) return callback(null, true);
        if (corsAllowList.has(origin)) return callback(null, true);
        if (allowViteDevPorts) {
          try {
            if (VITE_DEV_PORTS.has(new URL(origin).port)) return callback(null, true);
          } catch {
            /* malformed Origin — fall through to deny */
          }
        }
        callback(null, false);
      },
    }),
  );
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

  // Bind on all interfaces (Node's default for listen(PORT)) so LAN devices can
  // reach the API/ws at http://<lan-ip>:PORT, matching the client's host-derived
  // dial target. Log the LAN address too so it's obvious the network is exposed.
  httpServer.listen(PORT, () => {
    const lan = lanAddress();
    console.log(
      `[PixelOffice] server listening on http://localhost:${PORT} ` +
        (lan ? `(LAN: http://${lan}:${PORT}) ` : "") +
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

/** First non-internal IPv4 address (the LAN IP teammates dial), or null if
 *  none is found. Display-only — the server already binds on all interfaces. */
function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return null;
}
