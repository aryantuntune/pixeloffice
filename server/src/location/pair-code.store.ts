// ---------------------------------------------------------------------------
// Floor-sync PAIRING CODE store — ties a companion floor report to the EXACT
// user session that minted the code, regardless of IP.
//
// WHY THIS EXISTS: matching a companion's floor report to a session BY CLIENT IP
// is fragile — multiple clients behind one egress IP (NAT, a corporate VPN, or
// several browser tabs on localhost during dev) collide, so a user can show
// "Remote" even with floor sync ON until the right report lands. A short,
// human-typable pairing code, minted when the user enables floor sync and pasted
// into the companion (FLOOR_SYNC_PAIR_CODE -> body.pairCode), resolves a report
// to THAT session directly — IP-independent.
//
// CONSTITUTION-SAFE (AGENTS.md "presence, not surveillance"):
//   * Framework-free: no Colyseus, no HTTP, no clock reads beyond an injected
//     `now`. The room/route own the seams and pass `now` in (mirrors how the
//     room is the only clock reader for presence).
//   * PRIVACY — HARD RULE: a code maps ONLY to { sessionId, userId } in this
//     in-memory map with a TTL. It is NEVER logged or persisted, NEVER tied to
//     an IP or SSID, and is invalidated on disable / leave. No history is kept.
//   * OPT-IN unchanged: a resolved code only POINTS AT a session; whether the
//     report APPLIES is still gated by that session's floor-sync opt-in in the
//     room. A code for a not-opted-in user is a benign no-op there.
// ---------------------------------------------------------------------------

import { randomInt } from "node:crypto";

/** What a valid pairing code resolves to: the exact owning session + its user. */
export interface PairCodeEntry {
  sessionId: string;
  userId: string;
}

/** Default code lifetime: long enough to paste into the companion, short enough
 *  that a stale code does not linger. Refreshed whenever the user re-enables. */
export const DEFAULT_PAIR_CODE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Unambiguous alphabet (no 0/O, 1/I) so a human can read + type the code off
// the screen without confusion. 6 chars => ~30 bits, plenty for a transient
// per-session pairing token that is also opt-in gated downstream.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 6;

/**
 * In-memory pairing-code store. One code per session at a time (re-minting for a
 * session invalidates that session's previous code). Codes expire after a TTL;
 * `lookup` lazily prunes the entry it touches and `prune(now)` sweeps the rest.
 *
 * Not an interface/impl split because there is no second backend: a pairing code
 * is intentionally ephemeral and MUST NOT be persisted (privacy) — a process
 * restart simply re-mints on the next enable/join.
 */
export class PairCodeStore {
  /** code -> entry + absolute expiry. */
  private readonly byCode = new Map<string, { entry: PairCodeEntry; expiresAt: number }>();
  /** sessionId -> its current code (so a re-mint / invalidate is O(1)). */
  private readonly bySession = new Map<string, string>();

  constructor(private readonly ttlMs: number = DEFAULT_PAIR_CODE_TTL_MS) {}

  /**
   * Mint (or refresh) the pairing code for a session. Any previous code for the
   * SAME session is invalidated first, so a session always has exactly one live
   * code. Returns the new code. `now` is injected (no clock read here).
   */
  mint(sessionId: string, userId: string, now: number): string {
    // Drop this session's previous code (re-enable / reconnect refreshes it).
    this.invalidateSession(sessionId);
    const code = this.uniqueCode();
    this.byCode.set(code, { entry: { sessionId, userId }, expiresAt: now + this.ttlMs });
    this.bySession.set(sessionId, code);
    return code;
  }

  /**
   * Resolve a code to its owning session, or null when unknown / expired. An
   * expired entry is pruned on access (lazy expiry). `now` is injected.
   */
  lookup(code: string | undefined, now: number): PairCodeEntry | null {
    if (typeof code !== "string") return null;
    const normalized = code.trim().toUpperCase();
    if (normalized.length === 0) return null;
    const hit = this.byCode.get(normalized);
    if (!hit) return null;
    if (hit.expiresAt <= now) {
      this.byCode.delete(normalized);
      if (this.bySession.get(hit.entry.sessionId) === normalized) {
        this.bySession.delete(hit.entry.sessionId);
      }
      return null;
    }
    return { ...hit.entry };
  }

  /** Invalidate a session's code (on floor-sync DISABLE or on LEAVE). Idempotent. */
  invalidateSession(sessionId: string): void {
    const existing = this.bySession.get(sessionId);
    if (existing !== undefined) {
      this.byCode.delete(existing);
      this.bySession.delete(sessionId);
    }
  }

  /** Sweep every expired entry (called opportunistically, e.g. on the room tick). */
  prune(now: number): void {
    for (const [code, { entry, expiresAt }] of this.byCode) {
      if (expiresAt <= now) {
        this.byCode.delete(code);
        if (this.bySession.get(entry.sessionId) === code) {
          this.bySession.delete(entry.sessionId);
        }
      }
    }
  }

  /** Number of live (un-pruned) codes — for tests/diagnostics only. */
  size(): number {
    return this.byCode.size;
  }

  /** Generate a code not currently in use (retry on the rare collision). */
  private uniqueCode(): string {
    for (let attempt = 0; attempt < 64; attempt++) {
      const code = this.randomCode();
      if (!this.byCode.has(code)) return code;
    }
    // Astronomically unlikely; append entropy to guarantee uniqueness.
    return this.randomCode() + this.randomCode();
  }

  private randomCode(): string {
    let out = "";
    for (let i = 0; i < CODE_LEN; i++) {
      out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    return out;
  }
}
