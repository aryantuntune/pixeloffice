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
import { roleForEmail } from "../auth/rbac";
import { createState, verifyState } from "../auth/oauth-state";
import { bearerToken } from "../auth/middleware";
import type { OAuthProviderId } from "../auth/oauth-provider";

export interface AuthRouterDeps {
  config: AuthConfig;
  users: UserRepository;
}

function isProviderId(v: string): v is OAuthProviderId {
  return v === "google" || v === "microsoft";
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

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const { config, users } = deps;

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

    const role = roleForEmail(identity.email, config.adminEmails);
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
