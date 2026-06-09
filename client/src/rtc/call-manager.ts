// ---------------------------------------------------------------------------
// WebRTC call manager — the browser-side media plumbing for proximity calls.
//
// Pure transport/plumbing: it owns RTCPeerConnections + local mic/cam media and
// exchanges SDP/ICE through INJECTED signaling callbacks (it never imports the
// Connection or the protocol — main.ts wires those). It holds NO proximity or
// presence rules; the caller decides WHEN to start/stop a call (proximity is
// computed elsewhere from the store). This keeps media concerns isolated.
//
// Topology: P2P MESH. For Feature 1 (1:1 proximity calls) at most one call is
// active, but the manager is keyed by peer sessionId so it generalises. Media
// is peer-to-peer; the server only relays signaling.
//
// "Polite peer" glare handling: the peer with the lexicographically smaller
// sessionId is the IMPOLITE peer (creates the offer); the other is POLITE
// (answers). This deterministic role split avoids offer/answer collisions
// without extra negotiation state.
// ---------------------------------------------------------------------------

import type { RtcCallKind } from "@pixeloffice/shared";

/** Public STUN only — no TURN. Works on localhost + most same-LAN/NAT setups
 *  with zero infrastructure (Constitution: never break zero-config dev). Cross
 *  symmetric-NAT may fail without a TURN server, which can be added later. */
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export interface CallManagerEvents {
  /** A remote media stream arrived for a peer (attach to a <video>/<audio>). */
  onRemoteStream(peerId: string, stream: MediaStream): void;
  /** The local media stream is ready (self-preview for video). */
  onLocalStream(peerId: string, stream: MediaStream, kind: RtcCallKind): void;
  /** A call with this peer fully ended (connection closed / failed / hung up). */
  onCallEnded(peerId: string): void;
  /** The negotiated/asked media kind for a peer changed or was established. */
  onCallActive(peerId: string, kind: RtcCallKind): void;
  /** Mic enabled/disabled toggled for a peer's call (UI mute indicator). */
  onMicState(peerId: string, enabled: boolean): void;
  /** Non-fatal error surfaced to the UI (e.g. getUserMedia denied). */
  onError(peerId: string, message: string): void;
}

interface PeerCall {
  pc: RTCPeerConnection;
  kind: RtcCallKind;
  local: MediaStream | null;
  remote: MediaStream;
  /** Queued remote ICE candidates that arrived before the remote description. */
  pendingCandidates: RTCIceCandidateInit[];
  haveRemoteDescription: boolean;
}

export interface CallManagerDeps {
  selfId: () => string;
  /** Relay an opaque signaling blob to a peer (main.ts -> conn.send RTC_SIGNAL). */
  sendSignal(to: string, data: unknown): void;
  events: CallManagerEvents;
}

export class CallManager {
  private readonly calls = new Map<string, PeerCall>();

  constructor(private readonly deps: CallManagerDeps) {}

  /** True when a live (or negotiating) call exists with this peer. */
  isInCall(peerId: string): boolean {
    return this.calls.has(peerId);
  }

  /** sessionIds of every peer we currently hold a call with. */
  activePeers(): string[] {
    return [...this.calls.keys()];
  }

  /**
   * Begin (or upgrade) a call with a peer as the OFFERER. Called after the local
   * user clicked a call button AND the peer accepted, OR — for the impolite peer
   * — right when negotiation should start. Acquires local media first.
   */
  async startCall(peerId: string, kind: RtcCallKind): Promise<void> {
    try {
      const call = await this.ensureCall(peerId, kind);
      // Only the impolite peer (smaller id) makes the initial offer to avoid glare.
      if (this.isImpolite(peerId)) {
        const offer = await call.pc.createOffer();
        await call.pc.setLocalDescription(offer);
        this.deps.sendSignal(peerId, { sdp: call.pc.localDescription });
      }
      this.deps.events.onCallActive(peerId, kind);
    } catch (err) {
      this.deps.events.onError(peerId, mediaError(err));
      this.endCall(peerId);
    }
  }

  /**
   * Handle an inbound signaling blob relayed from a peer (SDP or ICE). For an
   * inbound OFFER with no existing call this lazily creates the answering side,
   * so the callee does not need to pre-arm anything beyond accepting.
   */
  async handleSignal(peerId: string, data: unknown, kindHint: RtcCallKind): Promise<void> {
    const blob = data as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } | null;
    if (!blob) return;
    try {
      if (blob.sdp) {
        const call = await this.ensureCall(peerId, kindHint);
        await call.pc.setRemoteDescription(blob.sdp);
        call.haveRemoteDescription = true;
        await this.flushCandidates(call);
        if (blob.sdp.type === "offer") {
          const answer = await call.pc.createAnswer();
          await call.pc.setLocalDescription(answer);
          this.deps.sendSignal(peerId, { sdp: call.pc.localDescription });
          this.deps.events.onCallActive(peerId, call.kind);
        }
      } else if (blob.candidate) {
        const call = this.calls.get(peerId);
        if (!call) return;
        if (call.haveRemoteDescription) {
          await call.pc.addIceCandidate(blob.candidate);
        } else {
          call.pendingCandidates.push(blob.candidate); // buffer until SDP set
        }
      }
    } catch (err) {
      this.deps.events.onError(peerId, mediaError(err));
    }
  }

  /** Enable/disable the local mic track for a peer's call. Returns the new state. */
  setMicEnabled(peerId: string, enabled: boolean): boolean {
    const call = this.calls.get(peerId);
    if (!call?.local) return false;
    for (const track of call.local.getAudioTracks()) track.enabled = enabled;
    this.deps.events.onMicState(peerId, enabled);
    return enabled;
  }

  /** Whether the local mic is currently transmitting for a peer's call. */
  isMicEnabled(peerId: string): boolean {
    const call = this.calls.get(peerId);
    if (!call?.local) return false;
    return call.local.getAudioTracks().some((t) => t.enabled);
  }

  /** Tear down the call with one peer (stops local media, closes the connection). */
  endCall(peerId: string): void {
    const call = this.calls.get(peerId);
    if (!call) return;
    this.calls.delete(peerId);
    for (const track of call.local?.getTracks() ?? []) track.stop();
    try {
      call.pc.onicecandidate = null;
      call.pc.ontrack = null;
      call.pc.onconnectionstatechange = null;
      call.pc.close();
    } catch {
      /* already closed */
    }
    this.deps.events.onCallEnded(peerId);
  }

  /** Tear down every active call (used on teardown / page unload). */
  endAll(): void {
    for (const peerId of [...this.calls.keys()]) this.endCall(peerId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Lexicographic role split so exactly one side offers (glare-free). */
  private isImpolite(peerId: string): boolean {
    return this.deps.selfId() < peerId;
  }

  /** Get or create the peer connection + local media for a call. */
  private async ensureCall(peerId: string, kind: RtcCallKind): Promise<PeerCall> {
    const existing = this.calls.get(peerId);
    if (existing) return existing;

    // navigator.mediaDevices only exists in a secure context (HTTPS or
    // localhost). Over http://<lan-ip> it is undefined; fail with a clear,
    // actionable message instead of a cryptic property-access TypeError.
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new DOMException(
        "Voice/video needs a secure connection (HTTPS or localhost).",
        "SecurityContextError"
      );
    }

    const local = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: kind === "video",
    });
    // Mic starts MUTED by default (human agency: never transmit until the user
    // unmutes). The UI's "Speak"/unmute control flips this on.
    for (const t of local.getAudioTracks()) t.enabled = false;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const remote = new MediaStream();
    const call: PeerCall = {
      pc,
      kind,
      local,
      remote,
      pendingCandidates: [],
      haveRemoteDescription: false,
    };
    this.calls.set(peerId, call);

    for (const track of local.getTracks()) pc.addTrack(track, local);

    pc.onicecandidate = (e) => {
      if (e.candidate) this.deps.sendSignal(peerId, { candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      for (const track of e.streams[0]?.getTracks() ?? [e.track]) remote.addTrack(track);
      this.deps.events.onRemoteStream(peerId, remote);
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "failed" || s === "closed" || s === "disconnected") this.endCall(peerId);
    };

    this.deps.events.onLocalStream(peerId, local, kind);
    this.deps.events.onMicState(peerId, false);
    return call;
  }

  private async flushCandidates(call: PeerCall): Promise<void> {
    const queued = call.pendingCandidates.splice(0);
    for (const c of queued) {
      try {
        await call.pc.addIceCandidate(c);
      } catch {
        /* ignore a stale candidate */
      }
    }
  }
}

function mediaError(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === "SecurityContextError") {
    return "Voice/video needs HTTPS (or localhost). Open the office over an https:// URL to enable calls.";
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone/camera permission denied.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone/camera found.";
  }
  return err instanceof Error ? err.message : "Call failed.";
}
