import { describe, it, expect, beforeEach } from "vitest";
import { CallService } from "./call.service";

describe("CallService", () => {
  let callIdCounter = 0;
  let service: CallService;

  beforeEach(() => {
    callIdCounter = 0;
    service = new CallService({
      maxParticipants: 4,
      newId: () => `c${++callIdCounter}`,
    });
  });

  it("creates a call on invite and rings the target", () => {
    const effect = service.invite("alice", "bob", "video");
    expect(effect.ring).toEqual([{ to: "bob", callId: "c1", from: "alice" }]);
    expect(effect.updated).toEqual(["c1"]);

    const call = service.get("c1");
    expect(call).toBeDefined();
    expect(call?.kind).toBe("video");
    expect(call?.participants.has("alice")).toBe(true);
    expect(call?.invites.get("bob")).toBe("alice");
  });

  it("handles accept and allows inviting a third participant", () => {
    service.invite("alice", "bob", "audio");
    const acceptEffect = service.answer("bob", "c1", "accept");
    expect(acceptEffect.updated).toEqual(["c1"]);

    const call = service.get("c1");
    expect(call?.participants.has("alice")).toBe(true);
    expect(call?.participants.has("bob")).toBe(true);
    expect(call?.invites.size).toBe(0);

    const thirdEffect = service.invite("alice", "carol", "audio");
    expect(thirdEffect.ring).toEqual([{ to: "carol", callId: "c1", from: "alice" }]);
    expect(thirdEffect.updated).toEqual(["c1"]);

    service.answer("carol", "c1", "accept");
    expect(call?.participants.size).toBe(3);
    expect(call?.participants.has("carol")).toBe(true);
  });

  it("merges two calls into one when recipient answers with merge", () => {
    // Alice calls Bob (c1) -> Bob accepts
    service.invite("alice", "bob", "audio");
    service.answer("bob", "c1", "accept");

    // Carol calls Bob (c2, Carol is participant, Bob is invited)
    const carolEffect = service.invite("carol", "bob", "audio");
    expect(carolEffect.ring).toEqual([{ to: "bob", callId: "c2", from: "carol" }]);

    // Bob answers c2 with "merge" -> folds into c1
    const mergeEffect = service.answer("bob", "c2", "merge");
    expect(mergeEffect.updated).toEqual(["c1"]);
    expect(service.get("c2")).toBeUndefined();
    expect(mergeEffect.ended.find((e) => e.callId === "c2")).toBeUndefined();

    const surviving = service.get("c1");
    expect(surviving?.participants.has("alice")).toBe(true);
    expect(surviving?.participants.has("bob")).toBe(true);
    expect(surviving?.participants.has("carol")).toBe(true);
  });

  it("switches calls when recipient answers with switch", () => {
    // Alice calls Bob (c1) -> Bob accepts
    service.invite("alice", "bob", "audio");
    service.answer("bob", "c1", "accept");

    // Carol calls Bob (c2)
    service.invite("carol", "bob", "audio");

    // Bob answers c2 with "switch" -> leaves c1 (alice gets empty), joins c2
    const switchEffect = service.answer("bob", "c2", "switch");
    expect(switchEffect.ended).toContainEqual({ to: "alice", callId: "c1", reason: "empty" });
    expect(switchEffect.updated).toContain("c2");

    expect(service.get("c1")).toBeUndefined();
    const c2 = service.get("c2");
    expect(c2?.participants.has("bob")).toBe(true);
    expect(c2?.participants.has("carol")).toBe(true);
  });

  it("enforces participant cap", () => {
    const cappedService = new CallService({
      maxParticipants: 2,
      newId: () => `c${++callIdCounter}`,
    });

    cappedService.invite("alice", "bob", "audio");
    cappedService.answer("bob", "c1", "accept");

    const fullEffect = cappedService.invite("alice", "carol", "audio");
    expect(fullEffect.notice).toEqual([{ to: "alice", kind: "full" }]);
    expect(fullEffect.ring).toEqual([]);
  });

  it("handles room call start, join, and teardown", () => {
    const roomKey = "f1\u0000Meeting Room A";
    const startEffect = service.startRoomCall("alice", roomKey, "audio", ["alice", "bob", "carol"]);

    expect(startEffect.ring).toEqual([
      { to: "bob", callId: "c1", from: "alice" },
      { to: "carol", callId: "c1", from: "alice" },
    ]);
    expect(startEffect.rooms).toEqual([roomKey]);
    expect(service.roomCall(roomKey)?.id).toBe("c1");

    // Joining open room call
    const joinEffect = service.join("dave", "c1");
    expect(joinEffect.updated).toEqual(["c1"]);
    expect(service.get("c1")?.participants.has("dave")).toBe(true);

    // Join non-room call should fail
    service.invite("x", "y", "audio");
    const badJoin = service.join("z", "c2");
    expect(badJoin.notice).toEqual([{ to: "z", kind: "unavailable" }]);

    // Teardown when all leave
    service.leave("alice", "c1");
    service.leave("dave", "c1");
    expect(service.roomCall(roomKey)).toBeUndefined();
  });

  it("verifies sharesCall gate correctly", () => {
    service.invite("alice", "bob", "audio");
    // Before Bob accepts:
    expect(service.sharesCall("alice", "bob")).toBe(false);

    service.answer("bob", "c1", "accept");
    // After Bob accepts:
    expect(service.sharesCall("alice", "bob")).toBe(true);
    expect(service.sharesCall("alice", "carol")).toBe(false);
  });

  it("disconnect destroys call and reports empty to remaining participant", () => {
    service.invite("alice", "bob", "audio");
    service.answer("bob", "c1", "accept");

    const dcEffect = service.disconnect("alice");
    expect(dcEffect.ended).toContainEqual({ to: "bob", callId: "c1", reason: "empty" });
    expect(service.get("c1")).toBeUndefined();
  });

  it("rejecting an invite notifies inviter and destroys empty call", () => {
    service.invite("alice", "bob", "audio");
    const rejectEffect = service.answer("bob", "c1", "reject");

    expect(rejectEffect.ended).toContainEqual({ to: "bob", callId: "c1", reason: "rejected" });
    expect(rejectEffect.ended).toContainEqual({ to: "alice", callId: "c1", reason: "empty" });
    expect(rejectEffect.notice).toEqual([{ to: "alice", kind: "declined", about: "bob" }]);
    expect(service.get("c1")).toBeUndefined();
  });
});
