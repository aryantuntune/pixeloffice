// ---------------------------------------------------------------------------
// Google OAuth 2.0 provider (authorization-code flow, plain fetch).
//
// Docs: https://developers.google.com/identity/protocols/oauth2/web-server
//   - authorize:  https://accounts.google.com/o/oauth2/v2/auth
//   - token:      https://oauth2.googleapis.com/token  (exchange code)
// We request the `openid email profile` scopes and read the userinfo endpoint
// for the normalized identity. Only constructed when GOOGLE_CLIENT_ID/SECRET
// are present (plan: integrations are optional).
// ---------------------------------------------------------------------------

import {
  redirectUriFor,
  type FetchLike,
  type OAuthBaseConfig,
  type OAuthIdentity,
  type OAuthProvider,
} from "./oauth-provider";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const SCOPE = "openid email profile";

export class GoogleOAuthProvider implements OAuthProvider {
  readonly id = "google" as const;
  readonly label = "Google";

  private readonly redirectUri: string;

  constructor(
    private readonly config: OAuthBaseConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  ) {
    this.redirectUri = redirectUriFor("google", config.redirectBase);
  }

  authorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: SCOPE,
      state,
      access_type: "online",
      prompt: "select_account",
    });
    return `${AUTH_ENDPOINT}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<OAuthIdentity> {
    const tokenRes = await this.fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!tokenRes.ok) {
      throw new Error(`Google token exchange failed (${tokenRes.status})`);
    }
    const token = (await tokenRes.json()) as { access_token?: string };
    if (!token.access_token) {
      throw new Error("Google token exchange returned no access_token");
    }

    const infoRes = await this.fetchImpl(USERINFO_ENDPOINT, {
      method: "GET",
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!infoRes.ok) {
      throw new Error(`Google userinfo failed (${infoRes.status})`);
    }
    const info = (await infoRes.json()) as {
      sub?: string;
      email?: string;
      name?: string;
      given_name?: string;
    };
    if (!info.sub || !info.email) {
      throw new Error("Google userinfo missing sub/email");
    }
    return {
      subject: info.sub,
      email: info.email,
      name: info.name || info.given_name || info.email,
    };
  }
}
