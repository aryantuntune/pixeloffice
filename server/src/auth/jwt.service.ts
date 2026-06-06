// ---------------------------------------------------------------------------
// JWT session service.
//
// Signs and verifies OUR application tokens (the OAuth providers below exchange
// IdP codes for an IdP identity; we then mint a PixelOffice JWT so the rest of
// the system never depends on a specific IdP). Uses the `jsonwebtoken` package.
//
// Zero-config rule: when JWT_SECRET is unset we generate an ephemeral secret at
// boot and log a single warning. The office still works (tokens are valid for
// this process lifetime); production sets JWT_SECRET so tokens survive restarts.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import jwt, { type JwtPayload, type SignOptions } from "jsonwebtoken";

/**
 * The ONLY signature algorithm we sign and accept. Pinning this (a) prevents the
 * `alg:none` bypass, (b) prevents an attacker from selecting a different HMAC
 * variant (HS384/HS512) than the server intended, and (c) forecloses the classic
 * RS256->HS256 key-confusion attack should verification ever be pointed at an
 * asymmetric/public key. Symmetric HMAC keeps the zero-config ephemeral-secret
 * path working unchanged.
 */
const SIGNING_ALGORITHM = "HS256" as const;

export type Role = "admin" | "member";

/** The claims we put in (and read back from) our JWTs. */
export interface SessionClaims {
  sub: string; // stable user id (IdP subject or dev slug)
  email: string;
  name: string;
  role: Role;
}

/** What `verify()` returns: our claims plus standard registered claims. */
export interface VerifiedSession extends SessionClaims {
  iat: number;
  exp: number;
}

export interface JwtServiceOptions {
  /** HMAC secret. When omitted, an ephemeral secret is generated (dev mode). */
  secret?: string;
  /** Token lifetime. Accepts a `jsonwebtoken` expiresIn value (e.g. "12h"). */
  expiresIn?: SignOptions["expiresIn"];
  /** Issuer claim — also verified on the way back. */
  issuer?: string;
  /** Optional logger seam (defaults to console.warn) — keeps tests quiet. */
  warn?: (message: string) => void;
}

const DEFAULT_EXPIRES_IN: SignOptions["expiresIn"] = "12h";
const DEFAULT_ISSUER = "pixeloffice";

/**
 * Framework-independent JWT signer/verifier. Constructor-injected everywhere
 * (middleware, auth routes, the room's JwtAuthProvider) — no module singletons.
 */
export class JwtService {
  private readonly secret: string;
  private readonly expiresIn: SignOptions["expiresIn"];
  private readonly issuer: string;

  /** True when running on an ephemeral, process-local secret (dev mode). */
  readonly ephemeral: boolean;

  constructor(opts: JwtServiceOptions = {}) {
    const warn = opts.warn ?? ((m: string) => console.warn(m));
    if (opts.secret && opts.secret.length > 0) {
      this.secret = opts.secret;
      this.ephemeral = false;
    } else {
      // Dev fallback: a strong random secret for this process only.
      this.secret = randomBytes(48).toString("hex");
      this.ephemeral = true;
      warn(
        "[PixelOffice] JWT_SECRET not set — using an ephemeral secret. " +
          "Tokens will be invalidated on restart. Set JWT_SECRET in production.",
      );
    }
    this.expiresIn = opts.expiresIn ?? DEFAULT_EXPIRES_IN;
    this.issuer = opts.issuer ?? DEFAULT_ISSUER;
  }

  /** Sign a session token from our claims. */
  sign(claims: SessionClaims): string {
    const payload = {
      email: claims.email,
      name: claims.name,
      role: claims.role,
    };
    return jwt.sign(payload, this.secret, {
      algorithm: SIGNING_ALGORITHM,
      subject: claims.sub,
      issuer: this.issuer,
      expiresIn: this.expiresIn,
    });
  }

  /**
   * Verify a token. Throws on tamper / expiry / wrong issuer (the caller maps
   * the throw to a 401). Returns the normalized session on success.
   */
  verify(token: string): VerifiedSession {
    // Pin the accepted algorithm: the SERVER decides the algorithm, not the
    // token header. This rejects alg:none and any HMAC variant other than the
    // one we sign with, and prevents RS256->HS256 confusion.
    const decoded = jwt.verify(token, this.secret, {
      algorithms: [SIGNING_ALGORITHM],
      issuer: this.issuer,
    }) as JwtPayload;

    const sub = decoded.sub;
    const email = decoded.email;
    const name = decoded.name;
    const role = decoded.role;

    if (typeof sub !== "string" || sub.length === 0) {
      throw new Error("Invalid token: missing subject");
    }
    if (typeof email !== "string") {
      throw new Error("Invalid token: missing email");
    }
    if (role !== "admin" && role !== "member") {
      throw new Error("Invalid token: bad role");
    }

    return {
      sub,
      email,
      name: typeof name === "string" ? name : "",
      role,
      iat: typeof decoded.iat === "number" ? decoded.iat : 0,
      exp: typeof decoded.exp === "number" ? decoded.exp : 0,
    };
  }

  /** Verify without throwing — returns null on any failure. */
  tryVerify(token: string): VerifiedSession | null {
    try {
      return this.verify(token);
    } catch {
      return null;
    }
  }

  /**
   * Expose the signing secret so the OAuth `state` HMAC can reuse it (one
   * secret to manage). Not used for anything else — keep it internal to auth.
   */
  secretForState(): string {
    return this.secret;
  }
}

/** Read JWT_SECRET from the environment (undefined => ephemeral dev secret). */
export function jwtServiceFromEnv(env: NodeJS.ProcessEnv = process.env): JwtService {
  return new JwtService({
    secret: env.JWT_SECRET,
    expiresIn: (env.JWT_EXPIRES_IN ?? DEFAULT_EXPIRES_IN) as SignOptions["expiresIn"],
  });
}
