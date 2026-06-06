// ---------------------------------------------------------------------------
// Microsoft Identity Platform (Azure AD) OAuth 2.0 provider.
//
// Docs: https://learn.microsoft.com/azure/active-directory/develop/v2-oauth2-auth-code-flow
//   - authorize: https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize
//   - token:     https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
//   - userinfo:  https://graph.microsoft.com/oidc/userinfo  (or /v1.0/me)
// Tenant defaults to "common" (multi-tenant + personal). Only constructed when
// MS_CLIENT_ID/SECRET are present (plan: integrations are optional).
// ---------------------------------------------------------------------------

import {
  redirectUriFor,
  type FetchLike,
  type OAuthBaseConfig,
  type OAuthIdentity,
  type OAuthProvider,
} from "./oauth-provider";

const USERINFO_ENDPOINT = "https://graph.microsoft.com/oidc/userinfo";
const SCOPE = "openid email profile User.Read";
const DEFAULT_TENANT = "common";

export interface MicrosoftConfig extends OAuthBaseConfig {
  /** Azure AD tenant id, or "common"/"organizations"/"consumers". */
  tenant?: string;
}

export class MicrosoftOAuthProvider implements OAuthProvider {
  readonly id = "microsoft" as const;
  readonly label = "Microsoft";

  private readonly redirectUri: string;
  private readonly tenant: string;

  constructor(
    private readonly config: MicrosoftConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  ) {
    this.redirectUri = redirectUriFor("microsoft", config.redirectBase);
    this.tenant = config.tenant && config.tenant.length > 0 ? config.tenant : DEFAULT_TENANT;
  }

  private authEndpoint(): string {
    return `https://login.microsoftonline.com/${this.tenant}/oauth2/v2.0/authorize`;
  }

  private tokenEndpoint(): string {
    return `https://login.microsoftonline.com/${this.tenant}/oauth2/v2.0/token`;
  }

  authorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: SCOPE,
      state,
      response_mode: "query",
    });
    return `${this.authEndpoint()}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<OAuthIdentity> {
    const tokenRes = await this.fetchImpl(this.tokenEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: "authorization_code",
        scope: SCOPE,
      }).toString(),
    });
    if (!tokenRes.ok) {
      throw new Error(`Microsoft token exchange failed (${tokenRes.status})`);
    }
    const token = (await tokenRes.json()) as { access_token?: string };
    if (!token.access_token) {
      throw new Error("Microsoft token exchange returned no access_token");
    }

    const infoRes = await this.fetchImpl(USERINFO_ENDPOINT, {
      method: "GET",
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!infoRes.ok) {
      throw new Error(`Microsoft userinfo failed (${infoRes.status})`);
    }
    const info = (await infoRes.json()) as {
      sub?: string;
      oid?: string;
      email?: string;
      preferred_username?: string;
      name?: string;
    };
    const subject = info.sub || info.oid;
    const email = info.email || info.preferred_username;
    if (!subject || !email) {
      throw new Error("Microsoft userinfo missing subject/email");
    }
    return {
      subject,
      email,
      name: info.name || email,
    };
  }
}
