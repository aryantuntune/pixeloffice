// ---------------------------------------------------------------------------
// Google Calendar refresh-token store (per stable user identity).
//
// The Calendar integration needs a SEPARATE offline grant from sign-in: the
// GoogleOAuthProvider sign-in requests `access_type=online` and discards tokens,
// so the calendar connect flow performs its own incremental authorization
// (`access_type=offline` + `prompt=consent`) and persists the resulting refresh
// token here, keyed by the stable `identity.userId`.
//
// Framework-free: no Express, no Colyseus, no Google SDK — a plain interface +
// an in-memory default. The interface is the seam a production deployment swaps
// for an ENCRYPTED-AT-REST database store (refresh tokens are long-lived bearer
// secrets and MUST be encrypted at rest in production — the in-memory impl is
// dev-only and loses tokens on restart).
//
// PRIVACY: we store ONLY the OAuth refresh token (and an optional scope/email
// hint for diagnostics). We never store calendar event bodies, titles, or
// attendee lists here — those are read transiently and only what the presence
// product displays (no-surveillance constitution).
// ---------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** The persisted record for one connected user's calendar grant. */
export interface GoogleTokenRecord {
  /** Long-lived OAuth refresh token (offline grant). The only required field. */
  refreshToken: string;
  /** Space-delimited scopes the grant carries (diagnostics only). */
  scope?: string;
  /** Best-effort account email the grant belongs to (diagnostics only). */
  email?: string;
  /** When the record was saved (epoch ms). */
  connectedAtMs?: number;
}

export interface GoogleTokenStore {
  /** Persist (or overwrite) the calendar grant for a stable user identity. */
  save(userId: string, record: GoogleTokenRecord): void | Promise<void>;
  /** The stored record for a user, or null when not connected. */
  get(userId: string): GoogleTokenRecord | null | Promise<GoogleTokenRecord | null>;
  /** Remove a user's grant (disconnect). */
  delete(userId: string): void | Promise<void>;
  /** All currently-connected user identities (drives the poll loop). */
  connectedUserIds(): string[] | Promise<string[]>;
}

/**
 * In-memory token store (DEV DEFAULT). Tokens live only for the process
 * lifetime. In production, replace with an encrypted-at-rest DB-backed store
 * implementing the same interface (refresh tokens are bearer secrets).
 */
export class InMemoryGoogleTokenStore implements GoogleTokenStore {
  private readonly records = new Map<string, GoogleTokenRecord>();

  save(userId: string, record: GoogleTokenRecord): void {
    this.records.set(userId, {
      ...record,
      connectedAtMs: record.connectedAtMs ?? Date.now(),
    });
  }

  get(userId: string): GoogleTokenRecord | null {
    return this.records.get(userId) ?? null;
  }

  delete(userId: string): void {
    this.records.delete(userId);
  }

  connectedUserIds(): string[] {
    return [...this.records.keys()];
  }
}

interface TokenCodec {
  encode(record: GoogleTokenRecord): string;
  decode(raw: string): GoogleTokenRecord | null;
}

class JsonTokenCodec implements TokenCodec {
  encode(record: GoogleTokenRecord): string {
    return JSON.stringify(record);
  }

  decode(raw: string): GoogleTokenRecord | null {
    return parseTokenRecord(raw);
  }
}

class AesGcmTokenCodec implements TokenCodec {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash("sha256").update(secret).digest();
  }

  encode(record: GoogleTokenRecord): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(record), "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `v1:${Buffer.concat([iv, tag, encrypted]).toString("base64")}`;
  }

  decode(raw: string): GoogleTokenRecord | null {
    if (!raw.startsWith("v1:")) return parseTokenRecord(raw);
    try {
      const buf = Buffer.from(raw.slice(3), "base64");
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const encrypted = buf.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]).toString("utf8");
      return parseTokenRecord(plain);
    } catch {
      return null;
    }
  }
}

function parseTokenRecord(raw: string): GoogleTokenRecord | null {
  try {
    const parsed = JSON.parse(raw) as GoogleTokenRecord;
    if (typeof parsed.refreshToken !== "string" || parsed.refreshToken.length === 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

interface RedisLikeGoogleTokenStore {
  client: {
    set(key: string, value: string): Promise<unknown>;
    get(key: string): Promise<string | null>;
    del(key: string): Promise<unknown>;
    sadd(key: string, value: string): Promise<unknown>;
    srem(key: string, value: string): Promise<unknown>;
    smembers(key: string): Promise<string[]>;
  };
}

const REDIS_CONNECTED_USERS_KEY = "pixeloffice:google-calendar:users";
const REDIS_TOKEN_PREFIX = "pixeloffice:google-calendar:token:";

function tokenKey(userId: string): string {
  return `${REDIS_TOKEN_PREFIX}${Buffer.from(userId, "utf8").toString("base64url")}`;
}

/**
 * Redis-backed token store. Used when REDIS_URL is healthy so Google Calendar
 * sync survives server restarts while the zero-config path remains in-memory.
 */
export class RedisGoogleTokenStore implements GoogleTokenStore {
  private readonly codec: TokenCodec;

  constructor(
    private readonly redis: RedisLikeGoogleTokenStore,
    encryptionSecret?: string,
  ) {
    this.codec = encryptionSecret?.trim()
      ? new AesGcmTokenCodec(encryptionSecret.trim())
      : new JsonTokenCodec();
  }

  async save(userId: string, record: GoogleTokenRecord): Promise<void> {
    await this.redis.client.set(
      tokenKey(userId),
      this.codec.encode({
        ...record,
        connectedAtMs: record.connectedAtMs ?? Date.now(),
      }),
    );
    await this.redis.client.sadd(REDIS_CONNECTED_USERS_KEY, userId);
  }

  async get(userId: string): Promise<GoogleTokenRecord | null> {
    const raw = await this.redis.client.get(tokenKey(userId));
    if (!raw) return null;
    return this.codec.decode(raw);
  }

  async delete(userId: string): Promise<void> {
    await this.redis.client.del(tokenKey(userId));
    await this.redis.client.srem(REDIS_CONNECTED_USERS_KEY, userId);
  }

  async connectedUserIds(): Promise<string[]> {
    return this.redis.client.smembers(REDIS_CONNECTED_USERS_KEY);
  }
}
