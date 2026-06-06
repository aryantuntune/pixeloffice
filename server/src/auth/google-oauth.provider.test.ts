import { describe, expect, it } from "vitest";
import { GoogleOAuthProvider } from "./google-oauth.provider";
import { MicrosoftOAuthProvider } from "./microsoft-oauth.provider";
import type { FetchLike } from "./oauth-provider";

const base = {
  clientId: "cid",
  clientSecret: "csecret",
  redirectBase: "http://localhost:2567",
};

/** Build a fake fetch that returns canned JSON per URL substring. */
function fakeFetch(map: Record<string, unknown>, fail?: string): FetchLike {
  return async (input: string) => {
    for (const [key, value] of Object.entries(map)) {
      if (input.includes(key)) {
        const ok = fail !== key;
        return {
          ok,
          status: ok ? 200 : 400,
          json: async () => value,
          text: async () => JSON.stringify(value),
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
}

describe("GoogleOAuthProvider", () => {
  it("builds an authorization URL with redirect_uri + state", () => {
    const p = new GoogleOAuthProvider(base);
    const url = p.authorizationUrl("ST");
    expect(url).toContain("accounts.google.com");
    expect(url).toContain("state=ST");
    expect(url).toContain(
      encodeURIComponent("http://localhost:2567/api/auth/google/callback"),
    );
    expect(url).toContain("scope=openid+email+profile");
  });

  it("exchanges a code -> normalized identity", async () => {
    const fetchImpl = fakeFetch({
      "oauth2.googleapis.com/token": { access_token: "AT" },
      "userinfo": { sub: "g-123", email: "a@b.com", name: "Ada" },
    });
    const p = new GoogleOAuthProvider(base, fetchImpl);
    const id = await p.exchangeCode("the-code");
    expect(id).toEqual({ subject: "g-123", email: "a@b.com", name: "Ada" });
  });

  it("throws when token exchange fails", async () => {
    const fetchImpl = fakeFetch(
      { "oauth2.googleapis.com/token": {}, userinfo: {} },
      "oauth2.googleapis.com/token",
    );
    const p = new GoogleOAuthProvider(base, fetchImpl);
    await expect(p.exchangeCode("c")).rejects.toThrow(/token exchange/i);
  });
});

describe("MicrosoftOAuthProvider", () => {
  it("builds an authorization URL against the common tenant by default", () => {
    const p = new MicrosoftOAuthProvider(base);
    const url = p.authorizationUrl("ST");
    expect(url).toContain("login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(url).toContain("state=ST");
  });

  it("exchanges a code -> normalized identity (oid + preferred_username)", async () => {
    const fetchImpl = fakeFetch({
      "oauth2/v2.0/token": { access_token: "AT" },
      "oidc/userinfo": { oid: "m-9", preferred_username: "user@org.com", name: "Mo" },
    });
    const p = new MicrosoftOAuthProvider(base, fetchImpl);
    const id = await p.exchangeCode("c");
    expect(id).toEqual({ subject: "m-9", email: "user@org.com", name: "Mo" });
  });
});
