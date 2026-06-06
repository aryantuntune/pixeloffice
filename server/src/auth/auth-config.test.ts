import { describe, expect, it } from "vitest";
import { buildAuthConfig } from "./auth-config";

function env(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return over as unknown as NodeJS.ProcessEnv;
}

describe("buildAuthConfig — provider gating", () => {
  it("enables no providers with empty env (zero-config dev)", () => {
    const cfg = buildAuthConfig(env());
    expect(cfg.providers.size).toBe(0);
    expect(cfg.authRequired).toBe(false);
    expect(cfg.jwt.ephemeral).toBe(true);
    expect(cfg.defaultDepartment).toBe("Engineering");
    expect(cfg.clientAppUrl).toBe("http://localhost:5173");
  });

  it("does not enable a provider missing the redirect base", () => {
    const cfg = buildAuthConfig(
      env({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }),
    );
    expect(cfg.providers.has("google")).toBe(false);
  });

  it("does not enable a provider missing a credential", () => {
    const cfg = buildAuthConfig(
      env({ GOOGLE_CLIENT_ID: "id", OAUTH_REDIRECT_BASE: "http://localhost:2567" }),
    );
    expect(cfg.providers.has("google")).toBe(false);
  });

  it("enables google when fully configured", () => {
    const cfg = buildAuthConfig(
      env({
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
        OAUTH_REDIRECT_BASE: "http://localhost:2567",
      }),
    );
    expect(cfg.providers.has("google")).toBe(true);
    expect(cfg.providers.get("google")!.label).toBe("Google");
  });

  it("enables both providers independently", () => {
    const cfg = buildAuthConfig(
      env({
        GOOGLE_CLIENT_ID: "g",
        GOOGLE_CLIENT_SECRET: "gs",
        MS_CLIENT_ID: "m",
        MS_CLIENT_SECRET: "ms",
        OAUTH_REDIRECT_BASE: "http://localhost:2567",
      }),
    );
    expect(cfg.providers.has("google")).toBe(true);
    expect(cfg.providers.has("microsoft")).toBe(true);
  });

  it("respects AUTH_REQUIRED, ADMIN_EMAILS, DEFAULT_DEPARTMENT, CLIENT_APP_URL", () => {
    const cfg = buildAuthConfig(
      env({
        AUTH_REQUIRED: "true",
        ADMIN_EMAILS: "admin@example.com",
        DEFAULT_DEPARTMENT: "Product",
        CLIENT_APP_URL: "https://office.company.com/",
        JWT_SECRET: "real-secret",
      }),
    );
    expect(cfg.authRequired).toBe(true);
    expect(cfg.adminEmails.has("admin@example.com")).toBe(true);
    expect(cfg.defaultDepartment).toBe("Product");
    expect(cfg.clientAppUrl).toBe("https://office.company.com");
    expect(cfg.jwt.ephemeral).toBe(false);
  });

  it("builds a valid authorization URL with state + redirect_uri", () => {
    const cfg = buildAuthConfig(
      env({
        GOOGLE_CLIENT_ID: "the-id",
        GOOGLE_CLIENT_SECRET: "the-secret",
        OAUTH_REDIRECT_BASE: "http://localhost:2567",
      }),
    );
    const url = cfg.providers.get("google")!.authorizationUrl("STATE123");
    expect(url).toContain("accounts.google.com");
    expect(url).toContain("client_id=the-id");
    expect(url).toContain("state=STATE123");
    expect(url).toContain(
      encodeURIComponent("http://localhost:2567/api/auth/google/callback"),
    );
  });
});
