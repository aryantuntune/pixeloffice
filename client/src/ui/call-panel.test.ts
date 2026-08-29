import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mountCallPanel } from "./call-panel";
import type { CallRingS2C, CallStateS2C, CallEndedS2C } from "@pixeloffice/shared";

class MockElement {
  tagName: string;
  className = "";
  textContent = "";
  children: MockElement[] = [];
  private _innerHTML = "";
  get innerHTML(): string {
    return this._innerHTML;
  }
  set innerHTML(val: string) {
    this._innerHTML = val;
    if (val === "") {
      this.children = [];
    }
  }
  classList = {
    contains: (cls: string) => this.className.split(" ").includes(cls),
    add: (cls: string) => {
      const set = new Set(this.className.split(" ").filter(Boolean));
      set.add(cls);
      this.className = Array.from(set).join(" ");
    },
    remove: (cls: string) => {
      const set = new Set(this.className.split(" ").filter(Boolean));
      set.delete(cls);
      this.className = Array.from(set).join(" ");
    },
  };
  attributes: Record<string, string> = {};
  eventListeners: Record<string, Array<(e: unknown) => void>> = {};

  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
  }

  appendChild<T extends MockElement>(child: T): T {
    this.children.push(child);
    return child;
  }

  append(...nodes: (MockElement | string)[]): void {
    for (const node of nodes) {
      if (typeof node === "string") {
        const textNode = new MockElement("span");
        textNode.textContent = node;
        this.children.push(textNode);
      } else {
        this.children.push(node);
      }
    }
  }

  remove(): void {
    // noop in mock
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  addEventListener(event: string, handler: (e: unknown) => void): void {
    if (!this.eventListeners[event]) this.eventListeners[event] = [];
    this.eventListeners[event].push(handler);
  }

  querySelector(selector: string): MockElement | null {
    if (selector.startsWith(".")) {
      const targetClass = selector.slice(1);
      for (const child of this.children) {
        if (child.classList.contains(targetClass)) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
    }
    return null;
  }
}

describe("CallPanel", () => {
  let root: MockElement;
  const sendInvite = vi.fn();
  const sendAnswer = vi.fn();
  const sendLeave = vi.fn();
  const sendSignal = vi.fn();
  const toast = vi.fn();

  beforeEach(() => {
    root = new MockElement("div");
    vi.stubGlobal("document", {
      createElement: (tag: string) => new MockElement(tag),
      body: new MockElement("body"),
    });
    vi.stubGlobal("MediaStream", class {
      getTracks() { return []; }
      getAudioTracks() { return []; }
      getVideoTracks() { return []; }
    });
    vi.stubGlobal("RTCPeerConnection", class {
      connectionState = "new";
      close = vi.fn();
      addTrack = vi.fn();
      createOffer = vi.fn(async () => ({ type: "offer", sdp: "offer" }));
      createAnswer = vi.fn(async () => ({ type: "answer", sdp: "answer" }));
      setLocalDescription = vi.fn(async () => {});
      setRemoteDescription = vi.fn(async () => {});
      addIceCandidate = vi.fn(async () => {});
    });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [],
          getAudioTracks: () => [],
          getVideoTracks: () => [],
        })),
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ enabled: false }) })));
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows Accept and Reject buttons when receiving a ring", () => {
    const handle = mountCallPanel(root as unknown as HTMLElement, {
      getSelfId: () => "self-123",
      sendInvite,
      sendAnswer,
      sendLeave,
      sendSignal,
      toast,
    });

    const ringPayload: CallRingS2C = {
      callId: "call-1",
      from: "caller-456",
      fromName: "Alice",
      kind: "video",
      participants: [{ sessionId: "caller-456", name: "Alice" }],
    };

    handle.handleRing(ringPayload);

    const ringCard = root.querySelector(".call-ring");
    expect(ringCard).not.toBeNull();

    const acceptBtn = root.querySelector(".call-btn-accept");
    const rejectBtn = root.querySelector(".call-btn-reject");
    expect(acceptBtn).not.toBeNull();
    expect(rejectBtn).not.toBeNull();

    handle.destroy();
  });

  it("does NOT auto-accept or dismiss ring when receiving a pending CALL_STATE", () => {
    const handle = mountCallPanel(root as unknown as HTMLElement, {
      getSelfId: () => "self-123",
      sendInvite,
      sendAnswer,
      sendLeave,
      sendSignal,
      toast,
    });

    const ringPayload: CallRingS2C = {
      callId: "call-1",
      from: "caller-456",
      fromName: "Alice",
      kind: "video",
      participants: [{ sessionId: "caller-456", name: "Alice" }],
    };

    handle.handleRing(ringPayload);

    // Caller receives CALL_STATE, callee also gets it with self in pending
    const pendingStatePayload: CallStateS2C = {
      callId: "call-1",
      kind: "video",
      participants: [{ sessionId: "caller-456", name: "Alice" }],
      pending: [{ sessionId: "self-123", name: "Bob" }],
    };

    handle.handleState(pendingStatePayload);

    // Ring card MUST stay visible on callee
    const ringCard = root.querySelector(".call-ring");
    expect(ringCard).not.toBeNull();
    expect(handle.isInCall()).toBe(false);

    handle.destroy();
  });

  it("activates call panel with is-1on1 layout when user is in participants", () => {
    const handle = mountCallPanel(root as unknown as HTMLElement, {
      getSelfId: () => "self-123",
      sendInvite,
      sendAnswer,
      sendLeave,
      sendSignal,
      toast,
    });

    const activeStatePayload: CallStateS2C = {
      callId: "call-1",
      kind: "video",
      participants: [
        { sessionId: "caller-456", name: "Alice" },
        { sessionId: "self-123", name: "Bob" },
      ],
      pending: [],
    };

    handle.handleState(activeStatePayload);

    expect(handle.isInCall()).toBe(true);
    const panel = root.querySelector(".call-panel");
    expect(panel).not.toBeNull();

    const tiles = root.querySelector(".call-tiles");
    expect(tiles?.classList.contains("is-1on1")).toBe(true);
    expect(tiles?.querySelector(".call-tile-self")).not.toBeNull();

    handle.destroy();
  });

  it("renders group call layout with remote grid and floating self-view PiP", () => {
    const handle = mountCallPanel(root as unknown as HTMLElement, {
      getSelfId: () => "self-123",
      sendInvite,
      sendAnswer,
      sendLeave,
      sendSignal,
      toast,
    });

    const groupStatePayload: CallStateS2C = {
      callId: "call-group",
      kind: "video",
      participants: [
        { sessionId: "caller-456", name: "Alice" },
        { sessionId: "user-789", name: "Charlie" },
        { sessionId: "self-123", name: "Bob" },
      ],
      pending: [],
    };

    handle.handleState(groupStatePayload);

    expect(handle.isInCall()).toBe(true);
    const tiles = root.querySelector(".call-tiles");
    expect(tiles?.classList.contains("is-group")).toBe(true);
    expect(tiles?.querySelector(".call-tile-self")).not.toBeNull();

    handle.destroy();
  });

  it("cleans up when call ends", () => {
    const handle = mountCallPanel(root as unknown as HTMLElement, {
      getSelfId: () => "self-123",
      sendInvite,
      sendAnswer,
      sendLeave,
      sendSignal,
      toast,
    });

    handle.handleState({
      callId: "call-1",
      kind: "video",
      participants: [
        { sessionId: "caller-456", name: "Alice" },
        { sessionId: "self-123", name: "Bob" },
      ],
      pending: [],
    });

    expect(handle.isInCall()).toBe(true);

    const endedPayload: CallEndedS2C = {
      callId: "call-1",
      reason: "left",
    };
    handle.handleEnded(endedPayload);

    expect(handle.isInCall()).toBe(false);
    expect(root.querySelector(".call-panel")).toBeNull();

    handle.destroy();
  });
});
