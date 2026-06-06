import { describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import { JwtService, type SessionClaims } from "./jwt.service";

const claims: SessionClaims = {
  sub: "google:123",
  email: "admin@example.com",
  name: "Aryan",
  role: "admin",
};

function svc(): JwtService {
  // Provide a fixed secret so we control verification; silence the warn path.
  return new JwtService({ secret: "test-secret-xyz", warn: () => {} });
}

describe("JwtService", () => {
  it("signs and verifies a round-trip preserving claims", () => {
    const s = svc();
    const token = s.sign(claims);
    const v = s.verify(token);
    expect(v.sub).toBe(claims.sub);
    expect(v.email).toBe(claims.email);
    expect(v.name).toBe(claims.name);
    expect(v.role).toBe("admin");
    expect(v.exp).toBeGreaterThan(v.iat);
  });

  it("rejects a tampered token", () => {
    const s = svc();
    const token = s.sign(claims);
    const tampered = token.slice(0, -2) + (token.endsWith("a") ? "bb" : "aa");
    expect(() => s.verify(tampered)).toThrow();
    expect(s.tryVerify(tampered)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const a = new JwtService({ secret: "secret-a", warn: () => {} });
    const b = new JwtService({ secret: "secret-b", warn: () => {} });
    const token = a.sign(claims);
    expect(() => b.verify(token)).toThrow();
  });

  it("rejects an expired token", () => {
    const secret = "exp-secret";
    // Hand-craft an already-expired token with the correct issuer.
    const expired = jwt.sign(
      { email: claims.email, name: claims.name, role: claims.role },
      secret,
      { subject: claims.sub, issuer: "pixeloffice", expiresIn: -10 },
    );
    const s = new JwtService({ secret, warn: () => {} });
    expect(() => s.verify(expired)).toThrow();
    expect(s.tryVerify(expired)).toBeNull();
  });

  it("rejects a token forged with alg:none", () => {
    const s = svc();
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
      "base64url",
    );
    const body = Buffer.from(
      JSON.stringify({
        sub: claims.sub,
        email: claims.email,
        name: claims.name,
        role: "admin",
        iss: "pixeloffice",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");
    const forged = `${header}.${body}.`;
    expect(() => s.verify(forged)).toThrow();
    expect(s.tryVerify(forged)).toBeNull();
  });

  it("rejects a token signed with a non-pinned HMAC algorithm (HS512/HS384)", () => {
    // The secret is correct, but the attacker chose a different HMAC variant.
    // With the algorithm pinned to HS256 the server must reject it.
    const secret = "test-secret-xyz";
    const s = new JwtService({ secret, warn: () => {} });
    for (const algorithm of ["HS512", "HS384"] as const) {
      const token = jwt.sign(
        { email: claims.email, name: claims.name, role: claims.role },
        secret,
        { algorithm, subject: claims.sub, issuer: "pixeloffice", expiresIn: "1h" },
      );
      expect(() => s.verify(token)).toThrow();
      expect(s.tryVerify(token)).toBeNull();
    }
  });

  it("signs with HS256 in the token header", () => {
    const s = svc();
    const token = s.sign(claims);
    const header = JSON.parse(
      Buffer.from(token.split(".")[0], "base64url").toString("utf8"),
    ) as { alg: string };
    expect(header.alg).toBe("HS256");
  });

  it("rejects a token with a wrong issuer", () => {
    const secret = "iss-secret";
    const bad = jwt.sign({ email: claims.email, role: "member" }, secret, {
      subject: "x",
      issuer: "somebody-else",
      expiresIn: "1h",
    });
    const s = new JwtService({ secret, warn: () => {} });
    expect(() => s.verify(bad)).toThrow();
  });

  it("generates an ephemeral secret and warns when none is provided", () => {
    const warn = vi.fn();
    const s = new JwtService({ warn });
    expect(s.ephemeral).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    // It still works end to end with its own secret.
    expect(s.verify(s.sign(claims)).sub).toBe(claims.sub);
  });

  it("does not warn when a secret is provided", () => {
    const warn = vi.fn();
    const s = new JwtService({ secret: "provided", warn });
    expect(s.ephemeral).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
