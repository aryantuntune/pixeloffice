// ---------------------------------------------------------------------------
// Authentication boundary.
//
// The plan FORBIDS custom username/password auth. V1 ships with a dev provider
// that validates a JoinOptions profile; in production a GoogleOAuthProvider /
// MicrosoftOAuthProvider implements this exact same `AuthProvider` interface
// (the room never learns which one it is — dependency injection via container).
// ---------------------------------------------------------------------------

import {
  AVATAR_IDS,
  DEPARTMENTS,
  type AvatarId,
  type Department,
  type JoinOptions,
} from "@pixeloffice/shared";

/** The authenticated identity the room needs to spawn a player. */
export interface AuthenticatedUser {
  userId: string;
  name: string;
  department: Department;
  avatarId: AvatarId;
  /** Verified account email when the IdP provides one. Server-side only. */
  email?: string;
}

/**
 * Pluggable authentication. Production OAuth providers (Google / Microsoft)
 * implement this same contract; only the container wiring changes.
 */
export interface AuthProvider {
  /** Resolve an identity from opaque join options. Rejects invalid profiles. */
  authenticate(options: unknown): Promise<AuthenticatedUser>;
}

const MIN_NAME = 1;
const MAX_NAME = 24;

function isDepartment(value: unknown): value is Department {
  return typeof value === "string" && (DEPARTMENTS as readonly string[]).includes(value);
}

function isAvatarId(value: unknown): value is AvatarId {
  return typeof value === "string" && (AVATAR_IDS as readonly string[]).includes(value);
}

/**
 * Dev stand-in for OAuth. Validates and sanitizes a JoinOptions profile and
 * mints a stable-ish userId. No passwords, ever (plan rule).
 */
export class DevAuthProvider implements AuthProvider {
  async authenticate(options: unknown): Promise<AuthenticatedUser> {
    const opts = (options ?? {}) as Partial<JoinOptions>;

    const rawName = typeof opts.name === "string" ? opts.name.trim() : "";
    if (rawName.length < MIN_NAME || rawName.length > MAX_NAME) {
      throw new Error(`Invalid name: must be ${MIN_NAME}-${MAX_NAME} characters`);
    }
    const name = rawName;

    if (!isDepartment(opts.department)) {
      throw new Error("Invalid department");
    }
    if (!isAvatarId(opts.avatarId)) {
      throw new Error("Invalid avatarId");
    }

    // Dev userId derived from the chosen name (OAuth would use the IdP subject).
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "user";
    const userId = `dev:${slug}:${Math.random().toString(36).slice(2, 8)}`;

    return { userId, name, department: opts.department, avatarId: opts.avatarId };
  }
}
