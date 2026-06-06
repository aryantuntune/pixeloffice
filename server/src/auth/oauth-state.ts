// ---------------------------------------------------------------------------
// OAuth `state` parameter: signed + short-lived (CSRF protection).
//
// We encode a small JSON payload (a nonce, the chosen department, an issued-at
// timestamp) and append an HMAC signature keyed by JWT_SECRET (or the JWT
// service's ephemeral secret). On callback we recompute the HMAC (constant-time
// compare) and reject expired or tampered state. Pure crypto, no network.
// ---------------------------------------------------------------------------

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SEP = ".";

export interface StatePayload {
  /** Random nonce to make each state unique. */
  nonce: string;
  /** Department the user picked on the login screen (carried through OAuth). */
  department?: string;
  /** Issued-at epoch ms. */
  iat: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(body: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(body).digest());
}

/** Create a signed state string. */
export function createState(
  secret: string,
  opts: { department?: string; now?: number } = {},
): string {
  const payload: StatePayload = {
    nonce: randomBytes(12).toString("base64url"),
    department: opts.department,
    iat: opts.now ?? Date.now(),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = sign(body, secret);
  return `${body}${SEP}${sig}`;
}

/**
 * Verify a signed state. Returns the payload on success, or null when the
 * signature is invalid, the format is wrong, or it has expired.
 */
export function verifyState(
  state: string | undefined | null,
  secret: string,
  opts: { ttlMs?: number; now?: number } = {},
): StatePayload | null {
  if (typeof state !== "string") return null;
  const idx = state.indexOf(SEP);
  if (idx <= 0) return null;
  const body = state.slice(0, idx);
  const sig = state.slice(idx + 1);

  const expected = sign(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
  } catch {
    return null;
  }
  if (typeof payload.iat !== "number") return null;

  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now();
  if (now - payload.iat > ttl || now < payload.iat - 1000) return null;

  return payload;
}
