import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallManager } from "./call-manager";

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

  getVideoTracks(): FakeTrack[] {
    return this.tracks;
  }

  addTrack(track: FakeTrack): void {
    this.tracks.push(track);
  }

  removeTrack(track: FakeTrack): void {
    const idx = this.tracks.indexOf(track);
    if (idx >= 0) this.tracks.splice(idx, 1);
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
    vi.stubGlobal("MediaStream", FakeMediaStream as unknown as typeof MediaStream);
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection as unknown as typeof RTCPeerConnection);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => new FakeMediaStream()),
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ enabled: false }) })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a peer alive during a transient WebRTC disconnected state", async () => {
    const gone: string[] = [];
    const manager = new CallManager({
      selfId: () => "a",
      sendSignal: vi.fn(),
      events: {
        onRemoteStream: vi.fn(),
        onRemoteGone: (peerId) => gone.push(peerId),
        onLocalStream: vi.fn(),
        onMediaState: vi.fn(),
        onError: vi.fn(),
      },
    });

    await manager.join("c1", "audio");
    await manager.setPeers(["b"]);

    const pc = FakePeerConnection.instances[0]!;
    expect(pc).toBeDefined();

    pc.setState("disconnected");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(gone).toEqual([]);
    expect(pc.close).not.toHaveBeenCalled();

    pc.setState("connected");
    await vi.runOnlyPendingTimersAsync();

    expect(gone).toEqual([]);
    expect(pc.close).not.toHaveBeenCalled();
  });

  it("handles video call with correct getUserMedia constraints", async () => {
    const manager = new CallManager({
      selfId: () => "a",
      sendSignal: vi.fn(),
      events: {
        onRemoteStream: vi.fn(),
        onRemoteGone: vi.fn(),
        onLocalStream: vi.fn(),
        onMediaState: vi.fn(),
        onError: vi.fn(),
      },
    });

    const getUserMediaSpy = vi.spyOn(navigator.mediaDevices, "getUserMedia");

    await manager.join("c2", "video");

    expect(getUserMediaSpy).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: true,
    });
  });

  it("reconciles peers: closes departed peers and emits onRemoteGone", async () => {
    const gone: string[] = [];
    const manager = new CallManager({
      selfId: () => "a",
      sendSignal: vi.fn(),
      events: {
        onRemoteStream: vi.fn(),
        onRemoteGone: (peerId) => gone.push(peerId),
        onLocalStream: vi.fn(),
        onMediaState: vi.fn(),
        onError: vi.fn(),
      },
    });

    await manager.join("c1", "audio");
    await manager.setPeers(["b", "c"]);

    expect(FakePeerConnection.instances.length).toBe(2);
    const pcB = FakePeerConnection.instances[0]!;
    const pcC = FakePeerConnection.instances[1]!;

    // Reconcile: peer "b" left, "c" remains
    await manager.setPeers(["c"]);

    expect(pcB.close).toHaveBeenCalled();
    expect(pcC.close).not.toHaveBeenCalled();
    expect(gone).toEqual(["b"]);
  });
});
