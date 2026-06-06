// ---------------------------------------------------------------------------
// Role-based access control: derive a user's role from configuration.
//
// A user is `admin` when their email (case-insensitively) appears in the
// ADMIN_EMAILS env list (comma-separated); otherwise `member`. Pure functions,
// no I/O — trivially testable.
// ---------------------------------------------------------------------------

import type { Role } from "./jwt.service";

/** Parse a comma-separated ADMIN_EMAILS string into a normalized email set. */
export function parseAdminEmails(raw: string | undefined | null): Set<string> {
  if (!raw) return new Set();
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const email = part.trim().toLowerCase();
    if (email.length > 0) out.add(email);
  }
  return out;
}

/** Derive the role for an email against a set of admin emails. */
export function roleForEmail(email: string, adminEmails: Set<string>): Role {
  return adminEmails.has(email.trim().toLowerCase()) ? "admin" : "member";
}

/** Convenience: derive the role straight from an env value. */
export function roleForEmailFromEnv(
  email: string,
  env: NodeJS.ProcessEnv = process.env,
): Role {
  return roleForEmail(email, parseAdminEmails(env.ADMIN_EMAILS));
}
