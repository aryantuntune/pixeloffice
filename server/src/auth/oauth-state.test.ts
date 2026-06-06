import { describe, expect, it } from "vitest";
import { createState, verifyState } from "./oauth-state";

const SECRET = "state-secret";

describe("OAuth state param", () => {
  it("round-trips a signed state, carrying the department", () => {
    const now = 1_000_000;
    const state = createState(SECRET, { department: "Design", now });
    const payload = verifyState(state, SECRET, { now });
    expect(payload).not.toBeNull();
    expect(payload!.department).toBe("Design");
    expect(payload!.iat).toBe(now);
    expect(payload!.nonce).toBeTruthy();
  });

  it("rejects a tampered body", () => {
    const state = createState(SECRET);
    const [body, sig] = state.split(".");
    const tampered = `${body}x.${sig}`;
    expect(verifyState(tampered, SECRET)).toBeNull();
  });

  it("rejects a wrong signature / wrong secret", () => {
    const state = createState(SECRET);
    expect(verifyState(state, "other-secret")).toBeNull();
  });

  it("rejects an expired state", () => {
    const iat = 1_000_000;
    const state = createState(SECRET, { now: iat });
    // 11 minutes later (TTL is 10m by default).
    expect(verifyState(state, SECRET, { now: iat + 11 * 60 * 1000 })).toBeNull();
  });

  it("accepts within the TTL window", () => {
    const iat = 1_000_000;
    const state = createState(SECRET, { now: iat });
    expect(verifyState(state, SECRET, { now: iat + 5 * 60 * 1000 })).not.toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyState(undefined, SECRET)).toBeNull();
    expect(verifyState("", SECRET)).toBeNull();
    expect(verifyState("noseparator", SECRET)).toBeNull();
    expect(verifyState(".onlysig", SECRET)).toBeNull();
  });
});
