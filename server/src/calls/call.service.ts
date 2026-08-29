import type { RtcCallKind, CallEndReason, CallAnswer } from "@pixeloffice/shared";

export interface CallSession {
  id: string;
  kind: RtcCallKind;
  /** Joined members. */
  participants: Set<string>;
  /** invitee sessionId -> inviter sessionId (pending rings). */
  invites: Map<string, string>;
  /** `${floorId}\u0000${roomName}` when this is an open meeting-room call, else null. */
  roomKey: string | null;
}

export interface CallEffect {
  /** Send S2C.CALL_RING to `to` for `callId`, originated by `from`. */
  ring: Array<{ to: string; callId: string; from: string }>;
  /** callIds whose roster changed: push S2C.CALL_STATE to participants + pending. */
  updated: string[];
  /** Send S2C.CALL_ENDED. */
  ended: Array<{ to: string; callId: string; reason: CallEndReason }>;
  /** Send S2C.TOAST (the room renders the text, resolving `about` to a name). */
  notice: Array<{ to: string; kind: "declined" | "full" | "unavailable"; about?: string }>;
  /** roomKeys whose bound call appeared/disappeared: refresh S2C.ROOM_CALL for occupants. */
  rooms: string[];
}

export interface CallServiceDeps {
  /** Hard participant cap. LiveKit configured => 12, P2P mesh => 4. */
  maxParticipants?: number;
  /** Injected for deterministic tests; defaults to a monotonic counter + random suffix. */
  newId?: () => string;
}

function emptyEffect(): CallEffect {
  return { ring: [], updated: [], ended: [], notice: [], rooms: [] };
}

function mergeEffects(a: CallEffect, b: CallEffect): CallEffect {
  const updatedSet = new Set([...a.updated, ...b.updated]);
  const roomsSet = new Set([...a.rooms, ...b.rooms]);
  return {
    ring: [...a.ring, ...b.ring],
    updated: Array.from(updatedSet),
    ended: [...a.ended, ...b.ended],
    notice: [...a.notice, ...b.notice],
    rooms: Array.from(roomsSet),
  };
}

export class CallService {
  private readonly maxParticipants: number;
  private readonly newIdFn: () => string;
  private readonly calls = new Map<string, CallSession>();
  private idCounter = 0;

  constructor(deps?: CallServiceDeps) {
    this.maxParticipants = deps?.maxParticipants ?? 4;
    this.newIdFn = deps?.newId ?? (() => `call_${++this.idCounter}_${Math.random().toString(36).slice(2, 8)}`);
  }

  get(callId: string): CallSession | undefined {
    return this.calls.get(callId);
  }

  callOf(session: string): CallSession | undefined {
    for (const call of this.calls.values()) {
      if (call.participants.has(session)) {
        return call;
      }
    }
    return undefined;
  }

  sharesCall(a: string, b: string): boolean {
    if (!a || !b || a === b) return false;
    for (const call of this.calls.values()) {
      if (call.participants.has(a) && call.participants.has(b)) {
        return true;
      }
    }
    return false;
  }

  roomCall(roomKey: string): CallSession | undefined {
    if (!roomKey) return undefined;
    for (const call of this.calls.values()) {
      if (call.roomKey === roomKey) {
        return call;
      }
    }
    return undefined;
  }

  invite(from: string, to: string, kind: RtcCallKind): CallEffect {
    if (!from || !to || from === to) return emptyEffect();

    const existingCall = this.callOf(from);
    if (existingCall) {
      if (existingCall.participants.has(to) || existingCall.invites.has(to)) {
        return emptyEffect();
      }
      if (existingCall.participants.size + existingCall.invites.size >= this.maxParticipants) {
        return { ...emptyEffect(), notice: [{ to: from, kind: "full" }] };
      }
      existingCall.invites.set(to, from);
      return {
        ...emptyEffect(),
        ring: [{ to, callId: existingCall.id, from }],
        updated: [existingCall.id],
      };
    }

    if (this.maxParticipants < 2) {
      return { ...emptyEffect(), notice: [{ to: from, kind: "full" }] };
    }

    const newCall: CallSession = {
      id: this.newIdFn(),
      kind,
      participants: new Set([from]),
      invites: new Map([[to, from]]),
      roomKey: null,
    };
    this.calls.set(newCall.id, newCall);

    return {
      ...emptyEffect(),
      ring: [{ to, callId: newCall.id, from }],
      updated: [newCall.id],
    };
  }

  answer(session: string, callId: string, answer: CallAnswer): CallEffect {
    const call = this.calls.get(callId);
    if (!call || !call.invites.has(session)) {
      return emptyEffect();
    }

    if (answer === "reject") {
      const inviter = call.invites.get(session)!;
      call.invites.delete(session);
      let effect: CallEffect = {
        ...emptyEffect(),
        ended: [{ to: session, callId, reason: "rejected" }],
        notice: [{ to: inviter, kind: "declined", about: session }],
      };
      if (call.participants.size > 0 || call.invites.size > 0) {
        effect.updated.push(callId);
      }
      const teardown = this.checkTeardown(call);
      return mergeEffects(effect, teardown);
    }

    if (answer === "switch") {
      let effect = emptyEffect();
      const currentCall = this.callOf(session);
      if (currentCall) {
        effect = mergeEffects(effect, this.leave(session, currentCall.id));
      }
      call.invites.delete(session);
      call.participants.add(session);
      return mergeEffects(effect, { ...emptyEffect(), updated: [callId] });
    }

    if (answer === "merge") {
      const currentCall = this.callOf(session);
      if (!currentCall) {
        // Not in another call -> accept normally
        call.invites.delete(session);
        call.participants.add(session);
        return { ...emptyEffect(), updated: [callId] };
      }

      if (currentCall.participants.size + call.participants.size > this.maxParticipants) {
        // Fall back to switch + notice full
        const switchEffect = this.answer(session, callId, "switch");
        return mergeEffects(switchEffect, {
          ...emptyEffect(),
          notice: [{ to: session, kind: "full" }],
        });
      }

      // Merge call into currentCall
      call.invites.delete(session);
      for (const p of call.participants) {
        currentCall.participants.add(p);
      }
      for (const [inv, from] of call.invites) {
        if (currentCall.participants.size + currentCall.invites.size < this.maxParticipants) {
          currentCall.invites.set(inv, from);
        }
      }

      this.calls.delete(call.id);
      const rooms = call.roomKey ? [call.roomKey] : [];

      return {
        ...emptyEffect(),
        updated: [currentCall.id],
        rooms,
      };
    }

    // answer === "accept"
    const currentCall = this.callOf(session);
    if (currentCall) {
      return this.answer(session, callId, "switch");
    }

    call.invites.delete(session);
    call.participants.add(session);
    return {
      ...emptyEffect(),
      updated: [callId],
    };
  }

  join(session: string, callId: string): CallEffect {
    const call = this.calls.get(callId);
    if (!call || call.roomKey === null) {
      return { ...emptyEffect(), notice: [{ to: session, kind: "unavailable" }] };
    }

    if (call.participants.size >= this.maxParticipants) {
      return { ...emptyEffect(), notice: [{ to: session, kind: "full" }] };
    }

    let effect = emptyEffect();
    const currentCall = this.callOf(session);
    if (currentCall) {
      effect = mergeEffects(effect, this.leave(session, currentCall.id));
    }

    call.invites.delete(session);
    call.participants.add(session);

    return mergeEffects(effect, {
      ...emptyEffect(),
      updated: [callId],
      rooms: call.roomKey ? [call.roomKey] : [],
    });
  }

  startRoomCall(session: string, roomKey: string, kind: RtcCallKind, occupants: string[]): CallEffect {
    if (this.roomCall(roomKey)) {
      return { ...emptyEffect(), notice: [{ to: session, kind: "unavailable" }] };
    }

    const targets = occupants.filter((id) => id !== session);
    if (targets.length === 0) {
      return { ...emptyEffect(), notice: [{ to: session, kind: "unavailable" }] };
    }

    let effect = emptyEffect();
    const currentCall = this.callOf(session);
    if (currentCall) {
      effect = mergeEffects(effect, this.leave(session, currentCall.id));
    }

    const newCall: CallSession = {
      id: this.newIdFn(),
      kind,
      participants: new Set([session]),
      invites: new Map(),
      roomKey,
    };

    const allowedTargets = targets.slice(0, this.maxParticipants - 1);
    for (const target of allowedTargets) {
      newCall.invites.set(target, session);
    }
    this.calls.set(newCall.id, newCall);

    const roomEffect: CallEffect = {
      ...emptyEffect(),
      ring: allowedTargets.map((to) => ({ to, callId: newCall.id, from: session })),
      updated: [newCall.id],
      rooms: [roomKey],
      notice: targets.length > allowedTargets.length ? [{ to: session, kind: "full" }] : [],
    };

    return mergeEffects(effect, roomEffect);
  }

  leave(session: string, callId: string): CallEffect {
    const call = this.calls.get(callId);
    if (!call) return emptyEffect();

    const wasParticipant = call.participants.has(session);
    const wasInvited = call.invites.has(session);
    if (!wasParticipant && !wasInvited) return emptyEffect();

    call.participants.delete(session);
    call.invites.delete(session);

    let effect: CallEffect = {
      ...emptyEffect(),
      ended: [{ to: session, callId, reason: "left" }],
    };

    if (call.participants.size > 0 || call.invites.size > 0) {
      effect.updated.push(callId);
    }

    const teardown = this.checkTeardown(call);
    return mergeEffects(effect, teardown);
  }

  disconnect(session: string): CallEffect {
    let combined = emptyEffect();

    // 1. Leave current call if participating
    const currentCall = this.callOf(session);
    if (currentCall) {
      combined = mergeEffects(combined, this.leave(session, currentCall.id));
    }

    // 2. Remove any pending invites where session was invited or inviter
    for (const call of Array.from(this.calls.values())) {
      let changed = false;
      if (call.invites.has(session)) {
        call.invites.delete(session);
        changed = true;
      }
      for (const [invitee, inviter] of Array.from(call.invites.entries())) {
        if (inviter === session) {
          call.invites.delete(invitee);
          combined.ended.push({ to: invitee, callId: call.id, reason: "cancelled" });
          changed = true;
        }
      }
      if (changed) {
        if (call.participants.size > 0 || call.invites.size > 0) {
          combined.updated.push(call.id);
        }
        combined = mergeEffects(combined, this.checkTeardown(call));
      }
    }

    // Departed session should not receive messages
    return {
      ring: combined.ring.filter((r) => r.to !== session),
      updated: combined.updated,
      ended: combined.ended.filter((e) => e.to !== session),
      notice: combined.notice.filter((n) => n.to !== session),
      rooms: combined.rooms,
    };
  }

  private checkTeardown(call: CallSession): CallEffect {
    // Teardown rule:
    // 1. If 0 participants: destroy call, cancel any remaining invites.
    // 2. If 1 participant and 0 invites: notify last participant with "empty" and destroy call.
    if (call.participants.size === 0 || (call.participants.size === 1 && call.invites.size === 0)) {
      const effect = emptyEffect();
      if (call.participants.size === 1) {
        const [lastParticipant] = call.participants;
        effect.ended.push({ to: lastParticipant, callId: call.id, reason: "empty" });
      }
      for (const invitee of call.invites.keys()) {
        effect.ended.push({ to: invitee, callId: call.id, reason: "cancelled" });
      }
      if (call.roomKey) {
        effect.rooms.push(call.roomKey);
      }
      this.calls.delete(call.id);
      return effect;
    }
    return emptyEffect();
  }
}
