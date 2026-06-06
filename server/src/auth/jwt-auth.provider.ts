// ---------------------------------------------------------------------------
// JWT-backed AuthProvider for the Colyseus room.
//
// Implements the SAME `AuthProvider` interface the room already uses, so the
// room's onJoin/onAuth code does not change shape. Behavior:
//   - If JoinOptions carries a `token`, verify it with the JwtService and build
//     the identity from the verified claims (sub/name) + the dev-style profile
//     fields (department/avatarId) the client still chooses on the login screen.
//   - If there is no token and AUTH_REQUIRED is NOT set, fall back to the dev
//     provider (zero-config path: name/department/avatar, no JWT).
//   - If AUTH_REQUIRED is set and there is no valid token, reject the join.
//
// This keeps the office working with no env (dev), and enforces real auth when
// the operator opts in via AUTH_REQUIRED=true.
// ---------------------------------------------------------------------------

import {
  AVATAR_IDS,
  DEPARTMENTS,
  type AvatarId,
  type Department,
} from "@pixeloffice/shared";
import type { AuthenticatedUser, AuthProvider } from "./auth-provider";
import type { JwtService } from "./jwt.service";

/** JoinOptions as this provider reads them (token is an additive field). */
interface TokenJoinOptions {
  token?: unknown;
  name?: unknown;
  department?: unknown;
  avatarId?: unknown;
}

const MAX_NAME = 24;

function isDepartment(v: unknown): v is Department {
  return typeof v === "string" && (DEPARTMENTS as readonly string[]).includes(v);
}
function isAvatarId(v: unknown): v is AvatarId {
  return typeof v === "string" && (AVATAR_IDS as readonly string[]).includes(v);
}

export interface JwtAuthProviderOptions {
  jwt: JwtService;
  /** The dev provider to fall back to when no token is present and auth is off. */
  fallback: AuthProvider;
  /** When true, a valid token is mandatory (no dev fallback). */
  authRequired: boolean;
  /** Default department for token users who did not pick one. */
  defaultDepartment: Department;
}

export class JwtAuthProvider implements AuthProvider {
  constructor(private readonly opts: JwtAuthProviderOptions) {}

  async authenticate(options: unknown): Promise<AuthenticatedUser> {
    const o = (options ?? {}) as TokenJoinOptions;
    const hasToken = typeof o.token === "string" && o.token.length > 0;

    if (hasToken) {
      const claims = this.opts.jwt.verify(o.token as string); // throws on bad token
      const name =
        typeof o.name === "string" && o.name.trim().length > 0
          ? o.name.trim().slice(0, MAX_NAME)
          : (claims.name || claims.email).slice(0, MAX_NAME);
      const department = isDepartment(o.department)
        ? o.department
        : this.opts.defaultDepartment;
      const avatarId = isAvatarId(o.avatarId) ? o.avatarId : AVATAR_IDS[0];
      return { userId: claims.sub, name, department, avatarId };
    }

    if (this.opts.authRequired) {
      throw new Error("Authentication required: missing token");
    }

    // Zero-config dev path: validate the plain profile (no JWT).
    return this.opts.fallback.authenticate(options);
  }
}
