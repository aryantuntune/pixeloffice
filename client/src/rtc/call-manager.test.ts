import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallManager } from "./call-manager";
import type { RtcCallKind } from "@pixeloffice/shared";

class FakeTrack {
  enabled = true;
  stop = vi.fn();
}

class FakeMediaStream {
  private readonly tracks: FakeTrack[];

  constructor(tracks: FakeTrack[] = [new FakeTrack()]) {
    this.tracks = tracks;
  }

  getTracks(): FakeTrack[] {
    return this.tracks;
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks;
  }

  addTrack(track: FakeTrack): void {
    this.tracks.push(track);
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  connectionState: RTCPeerConnectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: RTCPeerConnection["onicecandidate"] = null;
  ontrack: RTCPeerConnection["ontrack"] = null;
  onconnectionstatechange: RTCPeerConnection["onconnectionstatechange"] = null;

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  addTrack = vi.fn();
  close = vi.fn(() => {
    this.connectionState = "closed";
  });
  createOffer = vi.fn(async () => ({ type: "offer" as const, sdp: "offer" }));
  createAnswer = vi.fn(async () => ({ type: "answer" as const, sdp: "answer" }));
  setLocalDescription = vi.fn(async (desc: RTCSessionDescriptionInit) => {
    this.localDescription = desc;
  });
  setRemoteDescription = vi.fn(async () => {});
  addIceCandidate = vi.fn(async () => {});

  setState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.(new Event("connectionstatechange"));
  }
}

describe("CallManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakePeerConnection.instances = [];
    vi.stubGlobal("MediaStream", FakeMediaStream);
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => new FakeMediaStream()),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a call alive during a transient WebRTC disconnected state", async () => {
    const ended: string[] = [];
    const active: Array<{ peerId: string; kind: RtcCallKind }> = [];
    const manager = new CallManager({
      selfId: () => "a",
      sendSignal: vi.fn(),
      events: {
        onRemoteStream: vi.fn(),
        onLocalStream: vi.fn(),
        onCallEnded: (peerId) => ended.push(peerId),
        onCallActive: (peerId, kind) => active.push({ peerId, kind }),
        onMicState: vi.fn(),
        onError: vi.fn(),
      },
    });

    await manager.startCall("b", "audio");
    const pc = FakePeerConnection.instances[0]!;

    pc.setState("disconnected");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(manager.isInCall("b")).toBe(true);
    expect(ended).toEqual([]);

    pc.setState("connected");
    await vi.runOnlyPendingTimersAsync();

    expect(manager.isInCall("b")).toBe(true);
    expect(ended).toEqual([]);
    expect(active).toContainEqual({ peerId: "b", kind: "audio" });
  });

  it("handles video call with correct getUserMedia constraints", async () => {
    const manager = new CallManager({
      selfId: () => "a",
      sendSignal: vi.fn(),
      events: {
        onRemoteStream: vi.fn(),
        onLocalStream: vi.fn(),
        onCallEnded: vi.fn(),
        onCallActive: vi.fn(),
        onMicState: vi.fn(),
        onError: vi.fn(),
      },
    });

    const getUserMediaSpy = vi.spyOn(navigator.mediaDevices, "getUserMedia");

    await manager.startCall("c", "video");

    expect(getUserMediaSpy).toHaveBeenCalledWith({
      audio: true,
      video: true,
    });
  });
});
