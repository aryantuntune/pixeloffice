// ---------------------------------------------------------------------------
// Auth configuration assembled from the environment.
//
// This is the single place env vars are read for auth. It builds:
//   - the JwtService (ephemeral secret in dev)
//   - the enabled OAuth providers (only those whose credentials are present)
//   - the admin-email set (RBAC), default department, client app URL, and the
//     AUTH_REQUIRED gate.
// With NO env set: no OAuth providers, ephemeral JWT, AUTH_REQUIRED=false — the
// zero-config dev path is untouched (plan: integrations are optional).
// ---------------------------------------------------------------------------

import type { SignOptions } from "jsonwebtoken";
import { DEPARTMENTS, type Department } from "@pixeloffice/shared";
import { JwtService } from "./jwt.service";
import { parseAdminEmails } from "./rbac";
import { GoogleOAuthProvider } from "./google-oauth.provider";
import { MicrosoftOAuthProvider } from "./microsoft-oauth.provider";
import type { OAuthProvider, OAuthProviderId } from "./oauth-provider";

const DEFAULT_CLIENT_APP_URL = "http://localhost:5173";

export interface AuthConfig {
  jwt: JwtService;
  /** Enabled OAuth providers keyed by id (empty in zero-config dev). */
  providers: Map<OAuthProviderId, OAuthProvider>;
  /** Emails granted the `admin` role. */
  adminEmails: Set<string>;
  /** Department assigned to OAuth users unless overridden at login. */
  defaultDepartment: Department;
  /** Where to redirect the browser after a successful OAuth callback. */
  clientAppUrl: string;
  /** When true, admin REST + room join require a valid JWT. */
  authRequired: boolean;
  /** Shared secret used for the OAuth state HMAC (JwtService's secret). */
  stateSecret: string;
}

function pickDepartment(raw: string | undefined): Department {
  if (raw && (DEPARTMENTS as readonly string[]).includes(raw)) {
    return raw as Department;
  }
  return "Engineering";
}

/** Build a JwtService (exposed so callers can reuse its secret for state). */
function buildProviders(
  env: NodeJS.ProcessEnv,
): Map<OAuthProviderId, OAuthProvider> {
  const providers = new Map<OAuthProviderId, OAuthProvider>();
  const redirectBase = (env.OAUTH_REDIRECT_BASE ?? "").trim();

  // A provider is only enabled when it has both creds AND a redirect base.
  if (
    redirectBase &&
    env.GOOGLE_CLIENT_ID &&
    env.GOOGLE_CLIENT_SECRET &&
    env.GOOGLE_CLIENT_ID.trim() &&
    env.GOOGLE_CLIENT_SECRET.trim()
  ) {
    providers.set(
      "google",
      new GoogleOAuthProvider({
        clientId: env.GOOGLE_CLIENT_ID.trim(),
        clientSecret: env.GOOGLE_CLIENT_SECRET.trim(),
        redirectBase,
      }),
    );
  }

  if (
    redirectBase &&
    env.MS_CLIENT_ID &&
    env.MS_CLIENT_SECRET &&
    env.MS_CLIENT_ID.trim() &&
    env.MS_CLIENT_SECRET.trim()
  ) {
    providers.set(
      "microsoft",
      new MicrosoftOAuthProvider({
        clientId: env.MS_CLIENT_ID.trim(),
        clientSecret: env.MS_CLIENT_SECRET.trim(),
        redirectBase,
        tenant: env.MS_TENANT?.trim() || undefined,
      }),
    );
  }

  return providers;
}

/** Assemble the full auth config from the environment. */
export function buildAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const jwt = new JwtService({
    secret: env.JWT_SECRET,
    expiresIn: (env.JWT_EXPIRES_IN ?? "12h") as SignOptions["expiresIn"],
  });

  return {
    jwt,
    providers: buildProviders(env),
    adminEmails: parseAdminEmails(env.ADMIN_EMAILS),
    defaultDepartment: pickDepartment(env.DEFAULT_DEPARTMENT),
    clientAppUrl: (env.CLIENT_APP_URL ?? DEFAULT_CLIENT_APP_URL).replace(/\/+$/, ""),
    authRequired: env.AUTH_REQUIRED === "true",
    stateSecret: jwt.secretForState(),
  };
}
