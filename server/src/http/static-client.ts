// ---------------------------------------------------------------------------
// Static client serving (opt-in via SERVE_CLIENT=true, off by default).
//
// In dev the Vite server (:5173) serves the client and the zero-config path is
// untouched. In a single-container production image we build the client to
// client/dist and let Express serve those files from the same origin/port as
// the API + ws transport. This is a SPA so unknown non-/api GET routes fall
// back to index.html.
//
// The integrator mounts this in index.ts only when SERVE_CLIENT is enabled, so
// `npm run dev` with no env vars never touches the filesystem here.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type NextFunction, type Request, type Response } from "express";

export interface StaticClientOptions {
  /** Absolute path to the built client (client/dist). Auto-detected if omitted. */
  distDir?: string;
  /** Logger for the resolved path / warnings. Default: console. */
  logger?: Pick<Console, "log" | "warn">;
}

/** Read SERVE_CLIENT as a boolean (truthy: "true"/"1"/"yes"). */
export function shouldServeClient(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.SERVE_CLIENT ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/** Resolve the default client/dist location relative to this compiled module. */
export function defaultDistDir(): string {
  // server/src/http/static-client.ts -> repo root is three levels up from src/http.
  const here = path.dirname(fileURLToPath(import.meta.url));
  // here = .../server/src/http  ->  ../../.. = repo root
  return path.resolve(here, "../../../client/dist");
}

/**
 * Mount static client serving on the given Express app. Call AFTER the /api
 * router so API routes always win. Returns true if mounted, false if the dist
 * directory was missing (the office still boots; only static serving is off).
 *
 * IMPORTANT: register this last — the SPA fallback matches all remaining GETs.
 */
export function mountStaticClient(app: Express, options: StaticClientOptions = {}): boolean {
  const log = options.logger ?? console;
  const distDir = options.distDir ?? defaultDistDir();
  const indexHtml = path.join(distDir, "index.html");

  if (!existsSync(indexHtml)) {
    log.warn(
      `[static-client] SERVE_CLIENT is on but no build found at ${distDir} — ` +
        "run `npm run build -w client`. Serving API only.",
    );
    return false;
  }

  // Serve hashed assets with normal static caching; index.html is handled by
  // the fallback (no cache there so new deploys are picked up).
  app.use(express.static(distDir, { index: false }));

  // SPA fallback: any GET that isn't an /api route serves index.html so client
  // routing works on refresh. Non-GET and /api requests are left untouched.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api")) return next();
    res.sendFile(indexHtml);
  });

  log.log(`[static-client] serving client build from ${distDir}`);
  return true;
}
