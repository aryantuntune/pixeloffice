// ---------------------------------------------------------------------------
// OAuth provider seam (Google / Microsoft).
//
// Each provider implements the standard authorization-code flow with plain
// `fetch` — no passport, no SDK. The flow is identical across providers; only
// the endpoint URLs, scopes, and userinfo shape differ, so we keep one
// interface and two thin concrete adapters (google-oauth.provider.ts,
// microsoft-oauth.provider.ts). Plan rule: integrations are optional, so a
// provider is only constructed when its env credentials are present.
// ---------------------------------------------------------------------------

/** Normalized identity resolved from an IdP after the code exchange. */
export interface OAuthIdentity {
  /** Stable IdP subject (e.g. Google `sub`, Microsoft `oid`/`sub`). */
  subject: string;
  email: string;
  name: string;
}

/** Provider key used in routes (/api/auth/:provider/...). */
export type OAuthProviderId = "google" | "microsoft";

/**
 * A configured OAuth provider. Construction implies it is enabled (credentials
 * present); the routes never see a half-configured provider.
 */
export interface OAuthProvider {
  readonly id: OAuthProviderId;
  /** Human label for the client login button ("Google" / "Microsoft"). */
  readonly label: string;
  /** Build the provider consent URL to 302 the browser to. */
  authorizationUrl(state: string): string;
  /** Exchange an authorization `code` for a normalized identity. */
  exchangeCode(code: string): Promise<OAuthIdentity>;
}

/** Shared config every provider needs. */
export interface OAuthBaseConfig {
  clientId: string;
  clientSecret: string;
  /** Base of the server's public URL, e.g. "http://localhost:2567".
   *  The redirect URI is `${redirectBase}/api/auth/${id}/callback`. */
  redirectBase: string;
}

/** Compute the registered redirect URI for a provider. */
export function redirectUriFor(id: OAuthProviderId, redirectBase: string): string {
  return `${redirectBase.replace(/\/+$/, "")}/api/auth/${id}/callback`;
}

/**
 * Minimal fetch contract (injectable for tests so no network is needed).
 * Matches the global `fetch` signature for the calls we make.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;
