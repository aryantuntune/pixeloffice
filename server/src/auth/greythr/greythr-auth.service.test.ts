import { describe, expect, it } from "vitest";
import { JwtService } from "../jwt.service";
import { parseAdminEmails } from "../rbac";
import { InMemoryUserRepository } from "../../repositories/user.repository";
import {
  GreytHrEssError,
  type GreytHrAccount,
  type GreytHrEssClient,
  type GreytHrLoginInput,
  type GreytHrLoginResult,
} from "../../integrations/greythr/greythr-ess.client";
import { GreytHrAuthError, GreytHrAuthService } from "./greythr-auth.service";

function account(over: Partial<GreytHrAccount> = {}): GreytHrAccount {
  return {
    employeeId: 1480,
    employeeNo: "KCC00896",
    loginId: "KCC00896",
    name: "Aryan Sharma",
    email: "aryan@kalvium.com",
    department: "Engineering",
    designation: "Software Engineer Intern",
    location: "Bengaluru",
    reportingManager: "Jane Smith",
    company: "Kalvium",
    isManager: false,
    roles: ["employee"],
    ...over,
  };
}

/** Configurable fake greytHR ESS client (no network). */
class FakeEssClient implements GreytHrEssClient {
  loginCalls: GreytHrLoginInput[] = [];
  logoutCalls: string[] = [];
  constructor(
    private readonly result: GreytHrAccount | GreytHrEssError,
    private readonly sessionId = "sid-123",
  ) {}
  async login(input: GreytHrLoginInput): Promise<GreytHrLoginResult> {
    this.loginCalls.push(input);
    if (this.result instanceof GreytHrEssError) throw this.result;
    return { sessionId: this.sessionId, account: this.result };
  }
  async getAccount(): Promise<GreytHrAccount> {
    if (this.result instanceof GreytHrEssError) throw this.result;
    return this.result;
  }
  async logout(sessionId: string): Promise<void> {
    this.logoutCalls.push(sessionId);
  }
}

function makeService(
  client: GreytHrEssClient,
  over: { adminEmails?: string; allowedDomains?: Set<string> } = {},
) {
  const users = new InMemoryUserRepository();
  const jwt = new JwtService({ secret: "test-secret", warn: () => {} });
  const service = new GreytHrAuthService({
    client,
    jwt,
    users,
    adminEmails: parseAdminEmails(over.adminEmails),
    defaultDepartment: "Engineering",
    allowedEmailDomains: over.allowedDomains,
  });
  return { service, users, jwt };
}

describe("GreytHrAuthService.loginWithCredentials", () => {
  it("mints a JWT with a stable subject and the mapped department", async () => {
    const client = new FakeEssClient(account());
    const { service, jwt } = makeService(client);

    const { token, profile } = await service.loginWithCredentials({
      loginId: "KCC00896",
      password: "secret",
    });

    expect(profile.userId).toBe("greythr:KCC00896");
    expect(profile.name).toBe("Aryan Sharma");
    expect(profile.department).toBe("Engineering");
    expect(profile.departmentMapped).toBe(true);

    const claims = jwt.verify(token);
    expect(claims.sub).toBe("greythr:KCC00896");
    expect(claims.email).toBe("aryan@kalvium.com");
    expect(claims.department).toBe("Engineering"); // authoritative department claim
    expect(claims.role).toBe("member");
  });

  it("upserts the user with the stable id + deterministic default avatar", async () => {
    const client = new FakeEssClient(account());
    const { service, users } = makeService(client);

    const { profile } = await service.loginWithCredentials({
      loginId: "KCC00896",
      password: "secret",
    });

    const stored = await users.findById("greythr:KCC00896");
    expect(stored).not.toBeNull();
    expect(stored!.name).toBe("Aryan Sharma");
    expect(stored!.department).toBe("Engineering");
    expect(stored!.avatarId).toBe(profile.defaultAvatarId);
  });

  it("falls back to the default department for an unmapped greytHR label", async () => {
    const client = new FakeEssClient(account({ department: "Finance" }));
    const { service } = makeService(client);

    const { profile } = await service.loginWithCredentials({
      loginId: "KCC00896",
      password: "secret",
    });

    expect(profile.department).toBe("Engineering"); // default
    expect(profile.departmentMapped).toBe(false);
  });

  it("grants the admin role when the greytHR email is in ADMIN_EMAILS", async () => {
    const client = new FakeEssClient(account({ email: "boss@kalvium.com" }));
    const { service, jwt } = makeService(client, { adminEmails: "boss@kalvium.com" });

    const { token } = await service.loginWithCredentials({
      loginId: "KCC00896",
      password: "secret",
    });
    expect(jwt.verify(token).role).toBe("admin");
  });

  it("forwards the subdomain to the greytHR client", async () => {
    const client = new FakeEssClient(account());
    const { service } = makeService(client);
    await service.loginWithCredentials({
      subdomain: "kalvium",
      loginId: "KCC00896",
      password: "secret",
    });
    expect(client.loginCalls[0]?.subdomain).toBe("kalvium");
  });

  it("maps a credentials error to a 401 GreytHrAuthError", async () => {
    const client = new FakeEssClient(
      new GreytHrEssError("bad creds", "credentials", 401),
    );
    const { service } = makeService(client);
    await expect(
      service.loginWithCredentials({ loginId: "KCC00896", password: "wrong" }),
    ).rejects.toMatchObject({ name: "GreytHrAuthError", status: 401 });
  });

  it("maps a timeout to a 504 GreytHrAuthError", async () => {
    const client = new FakeEssClient(new GreytHrEssError("timed out", "timeout"));
    const { service } = makeService(client);
    await expect(
      service.loginWithCredentials({ loginId: "KCC00896", password: "x" }),
    ).rejects.toMatchObject({ status: 504 });
  });

  it("rejects an email outside the allowed domains with 403", async () => {
    const client = new FakeEssClient(account({ email: "ext@gmail.com" }));
    const { service } = makeService(client, {
      allowedDomains: new Set(["kalvium.com"]),
    });
    await expect(
      service.loginWithCredentials({ loginId: "KCC00896", password: "x" }),
    ).rejects.toBeInstanceOf(GreytHrAuthError);
  });

  it("rejects an account with no employee id (502)", async () => {
    const client = new FakeEssClient(account({ employeeNo: null, loginId: null }));
    const { service } = makeService(client);
    await expect(
      service.loginWithCredentials({ loginId: "x", password: "y" }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("logout ends the greytHR session captured at login", async () => {
    const client = new FakeEssClient(account(), "sid-xyz");
    const { service } = makeService(client);
    const { profile } = await service.loginWithCredentials({
      loginId: "KCC00896",
      password: "secret",
    });
    await service.logout(profile.userId);
    expect(client.logoutCalls).toEqual(["sid-xyz"]);
  });

  it("logout is a no-op (no throw) for an unknown user", async () => {
    const client = new FakeEssClient(account());
    const { service } = makeService(client);
    await service.logout("greythr:UNKNOWN");
    expect(client.logoutCalls).toEqual([]);
  });
});
