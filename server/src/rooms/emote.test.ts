// ---------------------------------------------------------------------------
// Emote handling tests.
//
// Booting a real Colyseus room (ws-transport + container singletons) for a unit
// test is impractical, so — per the same approach the rest of the room is
// covered indirectly — we test the EXTRACTED pure validation helper plus a tiny
// re-implementation of the handler's guard pipeline built from the SAME real
// primitives the room uses (`isValidEmote` + the real `TokenBucket` action
// bucket). This pins the three behaviors the contract calls for: bad emotes are
// dropped, valid ones broadcast {sessionId, emote} to everyone, and over-limit
// emotes are rate-limited away.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  C2S,
  EMOTES,
  S2C,
  type Emote,
  type EmoteBroadcastPayload,
} from "@pixeloffice/shared";
import { TokenBucket } from "../http/rate-limit";
import { isValidEmote } from "./office.room";

describe("isValidEmote", () => {
  it("defines the emote wire message types", () => {
    expect(C2S.EMOTE).toBe("emote");
    expect(S2C.EMOTE).toBe("emote");
  });

  it("accepts every defined emote token", () => {
    for (const e of EMOTES) {
      expect(isValidEmote(e)).toBe(true);
    }
  });

  it("rejects unknown / garbage values", () => {
    expect(isValidEmote("DANCE")).toBe(false);
    expect(isValidEmote("wave")).toBe(false); // case-sensitive
    expect(isValidEmote("")).toBe(false);
    expect(isValidEmote(undefined)).toBe(false);
    expect(isValidEmote(null)).toBe(false);
    expect(isValidEmote(42)).toBe(false);
    expect(isValidEmote({ emote: "WAVE" })).toBe(false);
  });
});

// Mirror of OfficeRoom.handleEmote's guard pipeline, wired from the real
// primitives. Returns the broadcast payload when allowed, else null (dropped).
function emoteHandler(bucket: TokenBucket, sessionId: string) {
  return (payload: unknown, now: number): EmoteBroadcastPayload | null => {
    if (!bucket.tryRemove(now)) return null; // rate-limit drop
    const emote = (payload as { emote?: unknown } | null | undefined)?.emote;
    if (!isValidEmote(emote)) return null; // validation drop
    return { sessionId, emote };
  };
}

describe("emote handler pipeline", () => {
  const RATE = 10;
  const WINDOW = 1000;

  it("broadcasts {sessionId, emote} for a valid emote", () => {
    const t0 = 1_000;
    const handle = emoteHandler(new TokenBucket(RATE, WINDOW, t0), "sessA");
    const out = handle({ emote: "WAVE" satisfies Emote }, t0);
    expect(out).toEqual({ sessionId: "sessA", emote: "WAVE" });
  });

  it("drops an invalid emote WITHOUT broadcasting", () => {
    const t0 = 1_000;
    const handle = emoteHandler(new TokenBucket(RATE, WINDOW, t0), "sessA");
    expect(handle({ emote: "DANCE" }, t0)).toBeNull();
    expect(handle({}, t0)).toBeNull();
    expect(handle(null, t0)).toBeNull();
  });

  it("rate-limits a flood: drops once the bucket is empty", () => {
    const t0 = 1_000;
    const bucket = new TokenBucket(RATE, WINDOW, t0);
    const handle = emoteHandler(bucket, "sessA");

    // Burst capacity (RATE) valid emotes succeed at the same instant.
    for (let i = 0; i < RATE; i++) {
      expect(handle({ emote: "HEART" satisfies Emote }, t0)).not.toBeNull();
    }
    // The next one within the same window is dropped (no refill yet).
    expect(handle({ emote: "HEART" }, t0)).toBeNull();

    // After a full window the bucket has refilled and emotes flow again.
    expect(handle({ emote: "HEART" }, t0 + WINDOW)).not.toBeNull();
  });
});
