import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { JwtService } from "./jwt.service";
import {
  bearerToken,
  createAdminGuard,
  requireAuth,
  requireRole,
} from "./middleware";

function jwtSvc() {
  return new JwtService({ secret: "mw-secret", warn: () => {} });
}

function mockReq(authHeader?: string): Request {
  return { headers: authHeader ? { authorization: authHeader } : {} } as Request;
}

function mockRes() {
  const res = {
    locals: {},
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe("bearerToken", () => {
  it("extracts a Bearer token", () => {
    expect(bearerToken(mockReq("Bearer abc.def"))).toBe("abc.def");
  });
  it("returns null with no/!bearer header", () => {
    expect(bearerToken(mockReq())).toBeNull();
    expect(bearerToken(mockReq("Basic xyz"))).toBeNull();
  });
});

describe("requireAuth", () => {
  it("401 when no token", () => {
    const res = mockRes();
    const next = vi.fn();
    requireAuth(jwtSvc())(mockReq(), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes and attaches session for a valid token", () => {
    const jwt = jwtSvc();
    const token = jwt.sign({ sub: "u", email: "e@x.com", name: "N", role: "member" });
    const res = mockRes();
    const next = vi.fn();
    requireAuth(jwt)(mockReq(`Bearer ${token}`), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect((res.locals as { session?: { sub: string } }).session?.sub).toBe("u");
  });
});

describe("requireRole", () => {
  it("403 when role mismatches", () => {
    const jwt = jwtSvc();
    const token = jwt.sign({ sub: "u", email: "e@x.com", name: "N", role: "member" });
    const res = mockRes();
    const next = vi.fn();
    requireRole(jwt, "admin")(mockReq(`Bearer ${token}`), res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes for the right role", () => {
    const jwt = jwtSvc();
    const token = jwt.sign({ sub: "u", email: "e@x.com", name: "N", role: "admin" });
    const res = mockRes();
    const next = vi.fn();
    requireRole(jwt, "admin")(mockReq(`Bearer ${token}`), res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("createAdminGuard", () => {
  it("is a no-op when authRequired is false", () => {
    const res = mockRes();
    const next = vi.fn();
    createAdminGuard(jwtSvc(), false)(mockReq(), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it("enforces admin when authRequired is true", () => {
    const res = mockRes();
    const next = vi.fn();
    createAdminGuard(jwtSvc(), true)(mockReq(), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
