// ---------------------------------------------------------------------------
// Express auth middleware: requireAuth / requireRole + a guard factory.
//
// Tokens are read from the `Authorization: Bearer <jwt>` header. Verified
// claims are attached to `res.locals.session`. The guard factory lets the
// integrator wrap admin routes conditionally: when AUTH_REQUIRED is off the
// guard is a no-op (zero-config dev console stays open); when on, it enforces a
// valid admin JWT.
// ---------------------------------------------------------------------------

import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { JwtService, Role, VerifiedSession } from "./jwt.service";

/** Pull a Bearer token from the Authorization header. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/** Read the verified session attached by requireAuth (if any). */
export function sessionOf(res: Response): VerifiedSession | null {
  return (res.locals.session as VerifiedSession | undefined) ?? null;
}

/** Require a valid JWT. 401 on missing/invalid token. */
export function requireAuth(jwt: JwtService): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Missing bearer token" });
      return;
    }
    const session = jwt.tryVerify(token);
    if (!session) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }
    res.locals.session = session;
    next();
  };
}

/** Require a valid JWT carrying a specific role. 401 then 403. */
export function requireRole(jwt: JwtService, role: Role): RequestHandler {
  const auth = requireAuth(jwt);
  return (req: Request, res: Response, next: NextFunction): void => {
    auth(req, res, () => {
      const session = sessionOf(res);
      if (!session || session.role !== role) {
        res.status(403).json({ error: `Requires role: ${role}` });
        return;
      }
      next();
    });
  };
}

/**
 * Guard factory for the integrator. Returns a middleware that:
 *   - is a transparent no-op when `authRequired` is false (dev console open),
 *   - enforces requireRole('admin') when `authRequired` is true.
 * Wrap protected admin routes with `guard()` so the policy lives in one place.
 */
export function createAdminGuard(jwt: JwtService, authRequired: boolean): RequestHandler {
  if (!authRequired) {
    return (_req: Request, _res: Response, next: NextFunction): void => next();
  }
  return requireRole(jwt, "admin");
}
