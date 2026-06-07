import { describe, expect, it } from "vitest";
import { parseAdminEmails, resolveRole, roleForEmail, roleForEmailFromEnv } from "./rbac";

describe("RBAC role derivation", () => {
  it("parses a comma-separated list, trimming + lowercasing", () => {
    const set = parseAdminEmails(" Admin@Example.com , boss@co.com ,");
    expect(set.has("admin@example.com")).toBe(true);
    expect(set.has("boss@co.com")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("returns an empty set for undefined/empty", () => {
    expect(parseAdminEmails(undefined).size).toBe(0);
    expect(parseAdminEmails("").size).toBe(0);
    expect(parseAdminEmails("  ,  ").size).toBe(0);
  });

  it("assigns admin only to listed emails (case-insensitive)", () => {
    const admins = parseAdminEmails("admin@example.com");
    expect(roleForEmail("ADMIN@example.com", admins)).toBe("admin");
    expect(roleForEmail("someone@else.com", admins)).toBe("member");
  });

  it("defaults to member when no ADMIN_EMAILS configured", () => {
    expect(roleForEmailFromEnv("admin@example.com", {} as NodeJS.ProcessEnv)).toBe("member");
  });

  it("reads ADMIN_EMAILS from env", () => {
    const env = { ADMIN_EMAILS: "admin@example.com" } as unknown as NodeJS.ProcessEnv;
    expect(roleForEmailFromEnv("admin@example.com", env)).toBe("admin");
    expect(roleForEmailFromEnv("x@y.com", env)).toBe("member");
  });
});

describe("resolveRole tiers", () => {
  it("grants admin to greytHR managers", () => {
    expect(resolveRole("a@x.com", { isManager: true })).toBe("admin");
  });

  it("grants admin to ADMIN_EMAILS members", () => {
    expect(resolveRole("a@x.com", { adminEmails: parseAdminEmails("a@x.com") })).toBe("admin");
  });

  it("defaults to member otherwise", () => {
    expect(resolveRole("a@x.com", {})).toBe("member");
    expect(resolveRole("", { isManager: true })).toBe("admin");
  });
});
