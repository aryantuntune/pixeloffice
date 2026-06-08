// ---------------------------------------------------------------------------
// Location floor-report REST API (mounted at /api/location). Plain Express.
//
// A small COMPANION helper on each office machine reads the WiFi SSID via the OS
// (browsers cannot) and POSTs it here. We map the SSID to a floor id and apply
// it to the caller's OWN live session(s) — but only when that user has opted in
// to floor sync in-app.
//
// SESSION MATCHING — two paths:
//   1. PAIRING CODE (preferred, IP-independent): when the body carries a valid
//      `pairCode` (minted on opt-in, delivered to the client via
//      S2C.FLOOR_SYNC_CODE, pasted into the companion as FLOOR_SYNC_PAIR_CODE),
//      we resolve it to the EXACT session that minted it and apply there,
//      IGNORING IP. This fixes the fragile IP match when many clients share one
//      egress IP (NAT, VPN, Docker, or several localhost tabs in dev).
//   2. IP FALLBACK (zero-setup single user): with no pairCode we match the
//      caller's OWN live sessions by their captured client IP — the companion
//      and browser run on the SAME machine, so they share a LAN IP.
//
// CONSTITUTION-SAFE (AGENTS.md "presence, not surveillance"):
//   * OPT-IN: a report only APPLIES to a session whose floor sync is ENABLED
//     (the room enforces this). A non-opted-in caller gets matched=0 — fine.
//   * PRIVACY — HARD RULE: this route NEVER logs or persists the SSID or the IP.
//     The SSID is resolved to a floor id and discarded; the IP is matched and
//     discarded. No location history is kept.
//   * Self-report has no abuse surface (you can only move your OWN machine's
//     sessions), so the shared secret is OPTIONAL: required only when
//     FLOOR_SYNC_SECRET is set, otherwise the endpoint accepts the report.
//
// The room is the only Colyseus-aware module; this route reaches it through the
// live registry (container.registry.room) and never touches the player map.
// ---------------------------------------------------------------------------

import { Router, type Request, type Response } from "express";
import { container } from "../container";
import { clientIp } from "./rate-limit";
import {
  createSsidFloorResolver,
  type SsidFloorResolver,
} from "../location/ssid-floor";
import type { PairCodeStore } from "../location/pair-code.store";

export interface LocationRouterOptions {
  /** Resolve the connected room (defaults to the live registry). */
  getRoom?: () => {
    applyFloorReport(clientIp: string | undefined, floorId: string): number;
    /** Apply to an explicit session id (pair-code path; IP-independent). */
    applyFloorReportBySession(sessionId: string, floorId: string): number;
    floorIds(): string[];
  } | null;
  /** Same trust-proxy decision the rest of the app uses (XFF only when true). */
  trustProxy?: boolean;
  /** Optional shared secret; when set, body.secret must match (else 401). */
  secret?: string;
  /** Injectable resolver (defaults to env-driven SSID_FLOOR_MAP). */
  resolver?: SsidFloorResolver;
  /** Env source for the default resolver (tests inject a custom map). */
  env?: NodeJS.ProcessEnv;
  /** Pairing-code store (defaults to the container singleton). Resolves a
   *  body.pairCode to the exact session, IP-independent. */
  pairCodes?: PairCodeStore;
}

export function createLocationRouter(options: LocationRouterOptions = {}): Router {
  const router = Router();

  const getRoom = options.getRoom ?? (() => container.registry.room);
  const pairCodes = options.pairCodes ?? container.pairCodes;
  const trustProxy = options.trustProxy ?? false;
  const secret =
    options.secret !== undefined
      ? options.secret
      : (options.env ?? process.env).FLOOR_SYNC_SECRET?.trim() || undefined;

  // The resolver is validated against the ACTIVE building's floor ids so a rule
  // naming a missing floor never resolves to a phantom floor. Built lazily on
  // first request so the room/building is up. NEVER logs the SSID.
  let resolver = options.resolver;
  const resolverFor = (): SsidFloorResolver => {
    if (resolver) return resolver;
    const room = getRoom();
    resolver = createSsidFloorResolver(options.env ?? process.env, room?.floorIds());
    return resolver;
  };

  // POST /api/location/floor-report { ssid, pairCode?, secret? }
  //   -> { floorId, matched } ---------------------------------------------------
  router.post("/floor-report", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      ssid?: unknown;
      pairCode?: unknown;
      secret?: unknown;
    };

    // Optional shared secret: enforced only when FLOOR_SYNC_SECRET is configured.
    if (secret !== undefined) {
      const provided = typeof body.secret === "string" ? body.secret : "";
      if (provided !== secret) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    const ssid = typeof body.ssid === "string" ? body.ssid : "";
    if (ssid.trim().length === 0) {
      res.status(400).json({ error: "ssid required" });
      return;
    }

    // Resolve SSID -> floor id (NEVER logged). No match is a benign no-op.
    const floorId = resolverFor().ssidToFloorId(ssid);
    if (!floorId) {
      res.status(200).json({ floorId: null, matched: 0 });
      return;
    }

    const room = getRoom();
    if (!room) {
      res.status(200).json({ floorId, matched: 0 });
      return;
    }

    // PAIRING CODE path (preferred, IP-INDEPENDENT): when the companion sent a
    // valid pairCode, resolve it to the EXACT session that minted it and apply
    // there, ignoring IP. This fixes the fragile IP match when many clients
    // share one egress IP (NAT, VPN, Docker, or several localhost tabs). An
    // unknown/expired code falls through to the IP match below — never a hard
    // error (a stale code should not break a single-user zero-setup deploy).
    const pairCode = typeof body.pairCode === "string" ? body.pairCode : "";
    if (pairCode.trim().length > 0) {
      const entry = pairCodes.lookup(pairCode, Date.now());
      if (entry) {
        // The opted-in gate + consented change live in the room (same as IP).
        const matched = room.applyFloorReportBySession(entry.sessionId, floorId);
        res.status(200).json({ floorId, matched });
        return;
      }
    }

    // IP FALLBACK (zero-setup single user): match the caller's OWN live sessions
    // by their captured client IP (honoring trust-proxy exactly like the rest of
    // the app), then apply to opted-in ones. PRIVACY: the IP is matched and
    // discarded — never logged or persisted here.
    const ip = clientIp(req, trustProxy);
    const matched = room.applyFloorReport(ip, floorId);

    res.status(200).json({ floorId, matched });
  });

  return router;
}
