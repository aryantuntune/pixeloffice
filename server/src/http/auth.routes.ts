// ---------------------------------------------------------------------------
// OAuth + session REST routes (mounted at /api/auth).
//
// Endpoints:
//   GET  /api/auth/config            -> which providers are enabled + flags
//   GET  /api/auth/:provider/login   -> 302 to the IdP consent screen (signed state)
//   GET  /api/auth/:provider/callback-> exchange code -> upsert user -> issue OUR
//                                       JWT -> 302 to the client app with #token=
//   GET  /api/auth/me                -> verified session claims (Bearer token)
//
// Dependencies are injected (no module singletons) so the integrator wires this
// from the container without this file importing it. Plan rules honored:
//   - no username/password; OAuth only
//   - integrations optional: with no providers configured the login routes 404
//     and the office still runs on the dev path
// ---------------------------------------------------------------------------

import { Router, type Request, type Response } from "express";
import type { AvatarId, Department } from "@pixeloffice/shared";
import { AVATAR_IDS, DEPARTMENTS } from "@pixeloffice/shared";
import type { AuthConfig } from "../auth/auth-config";
import type { UserRepository } from "../repositories/user.repository";
import { resolveRole } from "../auth/rbac";
import { createState, verifyState } from "../auth/oauth-state";
import { bearerToken } from "../auth/middleware";
import type { OAuthProviderId } from "../auth/oauth-provider";
import type { GoogleTokenStore } from "../auth/google-token.store";
import type { FetchLike } from "../auth/oauth-provider";
import {
  GreytHrAuthError,
  type GreytHrAuthService,
} from "../auth/greythr/greythr-auth.service";

/**
 * Optional Google Calendar connect deps. Present ONLY when GOOGLE_CLIENT_ID +
 * GOOGLE_CLIENT_SECRET are set; absent on the zero-config dev path so the
 * /api/auth/google/calendar/* routes 404 cleanly (integrations are optional).
 *
 * Endpoint bases are env-overridable so a local stub can stand in for Google.
 */
export interface GoogleCalendarConnectDeps {
  clientId: string;
  clientSecret: string;
  /** `${redirectBase}/api/auth/google/calendar/callback` is the registered URI. */
  redirectBase: string;
  /** Override https://accounts.google.com (GOOGLE_AUTH_BASE). */
  authBase: string;
  /** Override https://oauth2.googleapis.com (GOOGLE_TOKEN_BASE). */
  tokenBase: string;
  /** Refresh-token store keyed by stable identity.userId. */
  tokens: GoogleTokenStore;
  /**
   * Resolve a live Colyseus sessionId to its stable userId, exactly like the HR
   * routes do (via the OfficeRoom player list). Returns null for unknown/offline
   * sessions and for NPCs (NPCs can never connect a calendar).
   */
  resolveSessionUserId(sessionId: string): string | null;
  /** Injectable fetch for tests (token exchange). Defaults to global fetch. */
  fetchImpl?: FetchLike;
}

/** greytHR login deps; present only when GREYTHR_LOGIN_ENABLED=true. */
export interface GreytHrLoginDeps {
  service: GreytHrAuthService;
  /** Default subdomain advertised to the client login form (may be empty). */
  subdomain: string;
}

export interface AuthRouterDeps {
  config: AuthConfig;
  users: UserRepository;
  /** Present only when Google Calendar is configured (else routes 404). */
  googleCalendar?: GoogleCalendarConnectDeps;
  /** Present only when greytHR login is enabled (else /greythr/login 404s). */
  greytHrLogin?: GreytHrLoginDeps;
}

function isProviderId(v: string): v is OAuthProviderId {
  return v === "google" || v === "microsoft";
}

/** True when no allowlist is configured, or the email's domain is allowed. */
function emailDomainAllowed(email: string, allowed: Set<string>): boolean {
  if (allowed.size === 0) return true; // no restriction configured
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  return allowed.has(email.slice(at + 1).toLowerCase());
}

function pickDepartment(raw: unknown, fallback: Department): Department {
  return typeof raw === "string" && (DEPARTMENTS as readonly string[]).includes(raw)
    ? (raw as Department)
    : fallback;
}

/** Deterministic avatar pick from a stable subject (no UI choice in OAuth flow). */
function avatarForSubject(subject: string): AvatarId {
  let hash = 0;
  for (let i = 0; i < subject.length; i++) {
    hash = (hash * 31 + subject.charCodeAt(i)) >>> 0;
  }
  return AVATAR_IDS[hash % AVATAR_IDS.length];
}

const CAL_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const { config, users } = deps;

  // --- Google Calendar incremental-grant connect flow --------------------
  // Only mounted when Google Calendar is configured; otherwise these paths fall
  // through to the router's default 404 (integrations optional).
  if (deps.googleCalendar) {
    mountGoogleCalendarRoutes(router, config, deps.googleCalendar);
  }

  // --- greytHR ESS login (credentials -> our JWT) ------------------------
  // Only mounted when greytHR login is enabled; otherwise the path 404s.
  if (deps.greytHrLogin) {
    mountGreytHrLoginRoutes(router, config, deps.greytHrLogin);
  }

  // GET /api/auth/config --------------------------------------------------
  router.get("/config", (_req: Request, res: Response) => {
    res.json({
      providers: [...config.providers.values()].map((p) => ({
        id: p.id,
        label: p.label,
      })),
      authRequired: config.authRequired,
      defaultDepartment: config.defaultDepartment,
      departments: DEPARTMENTS,
      // Advertise greytHR sign-in so the client renders its form (and the
      // subdomain it should prefill). Absent integration => { enabled: false }.
      greythr: deps.greytHrLogin
        ? { enabled: true, subdomain: deps.greytHrLogin.subdomain }
        : { enabled: false },
    });
  });

  // GET /api/auth/me ------------------------------------------------------
  router.get("/me", (req: Request, res: Response) => {
    const token = bearerToken(req);
    const session = token ? config.jwt.tryVerify(token) : null;
    if (!session) {
      res.status(401).json({ error: "Invalid or missing token" });
      return;
    }
    res.json({
      sub: session.sub,
      email: session.email,
      name: session.name,
      role: session.role,
    });
  });

  // GET /api/auth/:provider/login -----------------------------------------
  router.get("/:provider/login", (req: Request, res: Response) => {
    const id = req.params.provider;
    if (!isProviderId(id)) {
      res.status(404).json({ error: "Unknown provider" });
      return;
    }
    const provider = config.providers.get(id);
    if (!provider) {
      res.status(404).json({ error: "Provider not enabled" });
      return;
    }
    const department = pickDepartment(req.query.department, config.defaultDepartment);
    const state = createState(config.stateSecret, { department });
    res.redirect(provider.authorizationUrl(state));
  });

  // GET /api/auth/:provider/callback --------------------------------------
  router.get("/:provider/callback", async (req: Request, res: Response) => {
    const id = req.params.provider;
    if (!isProviderId(id)) {
      res.status(404).json({ error: "Unknown provider" });
      return;
    }
    const provider = config.providers.get(id);
    if (!provider) {
      res.status(404).json({ error: "Provider not enabled" });
      return;
    }

    const error = typeof req.query.error === "string" ? req.query.error : null;
    if (error) {
      res.redirect(`${config.clientAppUrl}/#error=${encodeURIComponent(error)}`);
      return;
    }

    const code = typeof req.query.code === "string" ? req.query.code : "";
    const stateRaw = typeof req.query.state === "string" ? req.query.state : "";
    if (!code) {
      res.status(400).json({ error: "Missing authorization code" });
      return;
    }
    const state = verifyState(stateRaw, config.stateSecret);
    if (!state) {
      res.status(400).json({ error: "Invalid or expired state" });
      return;
    }

    let identity;
    try {
      identity = await provider.exchangeCode(code);
    } catch {
      res.redirect(`${config.clientAppUrl}/#error=oauth_exchange_failed`);
      return;
    }

    // Domain allowlist: when ALLOWED_EMAIL_DOMAINS is set, only verified emails
    // in those domains may enter (a corporate office should not admit arbitrary
    // external Google/Microsoft accounts). Unset = no restriction (dev default).
    if (!emailDomainAllowed(identity.email, config.allowedEmailDomains)) {
      res.redirect(`${config.clientAppUrl}/#error=domain_not_allowed`);
      return;
    }

    const department = pickDepartment(state.department, config.defaultDepartment);
    const avatarId = avatarForSubject(identity.subject);
    const userId = `${id}:${identity.subject}`;

    // Upsert the user (id keyed by provider+subject so re-logins are stable).
    await users.save({
      id: userId,
      name: identity.name,
      department,
      avatarId,
    });

    const role = resolveRole(identity.email, { adminEmails: config.adminEmails });
    const token = config.jwt.sign({
      sub: userId,
      email: identity.email,
      name: identity.name,
      role,
    });

    // Redirect to the client app with the token in the fragment (never logged
    // by servers/proxies). The client strips it and stores it in sessionStorage.
    res.redirect(`${config.clientAppUrl}/#token=${encodeURIComponent(token)}`);
  });

  return router;
}

/** Mount POST /greythr/login (mint our JWT) and POST /greythr/logout. */
function mountGreytHrLoginRoutes(
  router: Router,
  config: AuthConfig,
  deps: GreytHrLoginDeps,
): void {
  router.post("/greythr/login", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const loginId =
      (typeof body.loginId === "string" && body.loginId.trim()) ||
      (typeof body.username === "string" && body.username.trim()) ||
      "";
    const password = typeof body.password === "string" ? body.password : "";
    const subdomain =
      typeof body.subdomain === "string" && body.subdomain.trim()
        ? body.subdomain.trim()
        : deps.subdomain || undefined;

    if (!loginId || !password) {
      res.status(400).json({ error: "loginId and password are required" });
      return;
    }

    try {
      const { token, profile } = await deps.service.loginWithCredentials({
        subdomain,
        loginId,
        password,
      });
      res.json({ token, profile });
    } catch (err) {
      if (err instanceof GreytHrAuthError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: "greytHR sign-in failed" });
    }
  });

  // POST /greythr/reconnect: the user is ALREADY in the office (valid PixelOffice
  // JWT) but the underlying greytHR ESS session has expired (greytHR's own
  // absolute TTL) or was dropped (server restart wipes the in-memory store).
  // This re-authenticates ONLY the greytHR session and repopulates the shared
  // session store the attendance adapter reads — WITHOUT minting a new office
  // JWT or tearing down the office session. The user stays seated; they re-enter
  // only their greytHR password (the Employee No is taken from their JWT sub, so
  // it is never guessed or client-asserted). This stays Constitution-compliant:
  // identity is server-derived and the action is explicit (user types the
  // password); PixelOffice still stores no password — only the minted JWT and
  // the opaque greytHR session.
  router.post("/greythr/reconnect", async (req: Request, res: Response) => {
    const token = bearerToken(req);
    const session = token ? config.jwt.tryVerify(token) : null;
    if (!session?.sub) {
      res.status(401).json({ error: "Sign in again to reconnect greytHR." });
      return;
    }
    // Only greytHR identities (sub === "greythr:<employeeNo>") can reconnect; the
    // Employee No to log in with is derived from the verified token, never the
    // request body, so a user can only ever reconnect their OWN account.
    const prefix = "greythr:";
    if (!session.sub.startsWith(prefix)) {
      res.status(400).json({ error: "This account does not use greytHR sign-in." });
      return;
    }
    const employeeNo = session.sub.slice(prefix.length);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const password = typeof body.password === "string" ? body.password : "";
    if (!password) {
      res.status(400).json({ error: "password is required" });
      return;
    }
    const subdomain =
      typeof body.subdomain === "string" && body.subdomain.trim()
        ? body.subdomain.trim()
        : deps.subdomain || undefined;

    try {
      const { profile } = await deps.service.loginWithCredentials({
        subdomain,
        loginId: employeeNo,
        password,
      });
      // Defense in depth: the freshly authenticated greytHR account MUST resolve
      // to the same office identity. If it does not (credentials for a different
      // employee), drop that just-created session and refuse — never link
      // another account's session to this office identity.
      if (profile.userId !== session.sub) {
        await deps.service.logout(profile.userId);
        res.status(403).json({ error: "Those credentials belong to a different greytHR account." });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof GreytHrAuthError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: "greytHR reconnect failed" });
    }
  });

  // POST /greythr/logout: end the caller's greytHR session (identity from the
  // JWT). Idempotent — returns ok even without a valid token.
  router.post("/greythr/logout", async (req: Request, res: Response) => {
    const token = bearerToken(req);
    const session = token ? config.jwt.tryVerify(token) : null;
    if (session?.sub) {
      await deps.service.logout(session.sub);
    }
    res.json({ ok: true });
  });
}

/**
 * Mount the Google Calendar incremental-authorization flow:
 *   GET  /google/calendar/connect?sessionId=  -> 302 to Google consent (offline)
 *   GET  /google/calendar/callback            -> exchange code, store refresh token
 *   GET  /google/calendar/status?sessionId=   -> { connected: boolean }
 *   POST /google/calendar/disconnect          -> delete the stored grant
 *
 * Identity is resolved server-side from the LIVE Colyseus sessionId (mirroring
 * the HR routes) and carried SIGNED through OAuth state — never trusted from the
 * client. NPCs are rejected (resolveSessionUserId returns null for them).
 */
function mountGoogleCalendarRoutes(
  router: Router,
  config: AuthConfig,
  gc: GoogleCalendarConnectDeps,
): void {
  const fetchImpl: FetchLike =
    gc.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const redirectUri = `${gc.redirectBase.replace(/\/+$/, "")}/api/auth/google/calendar/callback`;

  function resolveUserId(req: Request): string | null {
    const raw =
      (typeof req.query.sessionId === "string" && req.query.sessionId) ||
      (typeof (req.body as Record<string, unknown> | undefined)?.sessionId === "string"
        ? ((req.body as Record<string, unknown>).sessionId as string)
        : "");
    if (!raw) return null;
    return gc.resolveSessionUserId(raw);
  }

  // GET /api/auth/google/calendar/connect?sessionId= ----------------------
  router.get("/google/calendar/connect", (req: Request, res: Response) => {
    const userId = resolveUserId(req);
    if (!userId) {
      res.status(400).json({ error: "Unknown or missing session" });
      return;
    }
    const state = createState(config.stateSecret, { userId });
    const params = new URLSearchParams({
      client_id: gc.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: CAL_SCOPE,
      state,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    });
    res.redirect(`${gc.authBase.replace(/\/+$/, "")}/o/oauth2/v2/auth?${params.toString()}`);
  });

  // GET /api/auth/google/calendar/callback --------------------------------
  router.get("/google/calendar/callback", async (req: Request, res: Response) => {
    const error = typeof req.query.error === "string" ? req.query.error : null;
    if (error) {
      res.redirect(`${config.clientAppUrl}/#calendar=error`);
      return;
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const stateRaw = typeof req.query.state === "string" ? req.query.state : "";
    if (!code) {
      res.status(400).json({ error: "Missing authorization code" });
      return;
    }
    const state = verifyState(stateRaw, config.stateSecret);
    if (!state || !state.userId) {
      res.status(400).json({ error: "Invalid or expired state" });
      return;
    }

    try {
      const tokenRes = await fetchImpl(`${gc.tokenBase.replace(/\/+$/, "")}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: gc.clientId,
          client_secret: gc.clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }).toString(),
      });
      if (!tokenRes.ok) throw new Error(`token exchange failed (${tokenRes.status})`);
      const body = (await tokenRes.json()) as {
        refresh_token?: string;
        scope?: string;
      };
      if (!body.refresh_token) {
        // No refresh token (user previously consented without prompt=consent, or
        // revoked). Surface as an error so the client can retry the connect.
        throw new Error("no refresh_token returned");
      }
      await gc.tokens.save(state.userId, {
        refreshToken: body.refresh_token,
        scope: body.scope,
        connectedAtMs: Date.now(),
      });
      res.redirect(`${config.clientAppUrl}/#calendar=connected`);
    } catch {
      res.redirect(`${config.clientAppUrl}/#calendar=error`);
    }
  });

  // GET /api/auth/google/calendar/status?sessionId= -----------------------
  router.get("/google/calendar/status", async (req: Request, res: Response) => {
    const userId = resolveUserId(req);
    if (!userId) {
      res.status(400).json({ error: "Unknown or missing session" });
      return;
    }
    const record = await gc.tokens.get(userId);
    res.json({ connected: Boolean(record) });
  });

  // POST /api/auth/google/calendar/disconnect -----------------------------
  router.post("/google/calendar/disconnect", async (req: Request, res: Response) => {
    const userId = resolveUserId(req);
    if (!userId) {
      res.status(400).json({ error: "Unknown or missing session" });
      return;
    }
    await gc.tokens.delete(userId);
    res.json({ connected: false });
  });
}
