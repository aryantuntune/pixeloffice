import { describe, expect, it } from "vitest";
import { DevAuthProvider } from "./auth-provider";
import { JwtService } from "./jwt.service";
import { JwtAuthProvider } from "./jwt-auth.provider";

function make(authRequired: boolean) {
  const jwt = new JwtService({ secret: "room-secret", warn: () => {} });
  const provider = new JwtAuthProvider({
    jwt,
    fallback: new DevAuthProvider(),
    authRequired,
    defaultDepartment: "Engineering",
  });
  return { jwt, provider };
}

describe("JwtAuthProvider", () => {
  it("authenticates a valid token, using token claims for userId", async () => {
    const { jwt, provider } = make(false);
    const token = jwt.sign({
      sub: "google:abc",
      email: "a@b.com",
      name: "Ada",
      role: "member",
    });
    const user = await provider.authenticate({
      token,
      department: "Design",
      avatarId: "ruby",
    });
    expect(user.userId).toBe("google:abc");
    expect(user.name).toBe("Ada");
    expect(user.department).toBe("Design");
    expect(user.avatarId).toBe("ruby");
  });

  it("falls back to the default department when token user picks none", async () => {
    const { jwt, provider } = make(false);
    const token = jwt.sign({ sub: "s", email: "e@x.com", name: "N", role: "member" });
    const user = await provider.authenticate({ token });
    expect(user.department).toBe("Engineering");
  });

  it("rejects an invalid token", async () => {
    const { provider } = make(false);
    await expect(provider.authenticate({ token: "garbage" })).rejects.toThrow();
  });

  it("falls back to dev profile when no token and auth not required", async () => {
    const { provider } = make(false);
    const user = await provider.authenticate({
      name: "Dev",
      department: "HR",
      avatarId: "slate",
    });
    expect(user.name).toBe("Dev");
    expect(user.department).toBe("HR");
    expect(user.userId).toMatch(/^dev:/);
  });

  it("rejects a tokenless join when AUTH_REQUIRED", async () => {
    const { provider } = make(true);
    await expect(
      provider.authenticate({ name: "Dev", department: "HR", avatarId: "slate" }),
    ).rejects.toThrow(/required/i);
  });
});
