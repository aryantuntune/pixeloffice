// ---------------------------------------------------------------------------
// Call Manager — browser-side media plumbing for conference/group calls.
//
// Topology:
// - When LiveKit is configured, ONE Room is created per callId ("call-<id>").
// - When LiveKit is unconfigured, a P2P WebRTC mesh is maintained with all peers
//   in the authoritative roster (reconciled via setPeers).
// ---------------------------------------------------------------------------

import type { RtcCallKind } from "@pixeloffice/shared";
import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const DISCONNECT_GRACE_MS = 5_000;

export interface CallManagerEvents {
  /** A remote media stream arrived for a peer (attach to a <video>/<audio>). */
  onRemoteStream(peerId: string, stream: MediaStream): void;
  /** A remote peer left the call or disconnected. */
  onRemoteGone(peerId: string): void;
  /** The local media stream is ready (self-preview for video). */
  onLocalStream(stream: MediaStream, kind: RtcCallKind): void;
  /** Media mute/camera state changed. */
  onMediaState(state: { mic: boolean; cam: boolean }): void;
  /** Non-fatal error surfaced to the UI (e.g. getUserMedia denied). */
  onError(message: string): void;
}

export interface CallManagerDeps {
  selfId: () => string;
  /** Relay an opaque signaling blob to a peer (main.ts -> conn.send RTC_SIGNAL). */
  sendSignal(to: string, data: unknown): void;
  events: CallManagerEvents;
}

interface PeerConnectionState {
  pc: RTCPeerConnection;
  remoteStream: MediaStream;
  pendingCandidates: RTCIceCandidateInit[];
  haveRemoteDescription: boolean;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

export class CallManager {
  private currentCallIdStr: string | null = null;
  private localStream: MediaStream | null = null;
  private readonly peers = new Map<string, PeerConnectionState>();

  private livekitRoom: Room | null = null;
  private readonly livekitStreams = new Map<string, MediaStream>();
  private livekitConfig: { enabled: boolean; url?: string } | null = null;
  private configPromise: Promise<{ enabled: boolean; url?: string }> | null = null;

  private micEnabled = true;
  private camEnabled = true;

  constructor(private readonly deps: CallManagerDeps) {}

  currentCallId(): string | null {
    return this.currentCallIdStr;
  }

  isMicEnabled(): boolean {
    return this.micEnabled;
  }

  isCamEnabled(): boolean {
    return this.camEnabled;
  }

  /** Acquire local media and arm the transport for this call. Idempotent per callId. */
  async join(callId: string, kind: RtcCallKind): Promise<void> {
    if (this.currentCallIdStr === callId) return;
    if (this.currentCallIdStr !== null) {
      this.leave();
    }

    this.currentCallIdStr = callId;
    // Load initial media preferences
    let micPref = true;
    let camPref = true;
    try {
      const storedMic = localStorage.getItem("pixeloffice.mic.enabled");
      if (storedMic !== null) {
        micPref = storedMic === "true";
      }
      const storedCam = localStorage.getItem("pixeloffice.camera.enabled");
      if (storedCam !== null) {
        camPref = storedCam === "true";
      }
    } catch {}

    this.micEnabled = micPref;
    this.camEnabled = kind === "video" && camPref;

    try {
      const lk = await this.getLiveKitConfig();
      if (lk.enabled && lk.url) {
        await this.joinLiveKit(callId, kind, lk.url);
        return;
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new DOMException(
          "Voice/video needs a secure connection (HTTPS or localhost).",
          "SecurityContextError",
        );
      }

      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: kind === "video" && camPref,
      });

      for (const t of this.localStream.getAudioTracks()) t.enabled = this.micEnabled;
      for (const t of this.localStream.getVideoTracks()) t.enabled = this.camEnabled;

      this.deps.events.onLocalStream(this.localStream, kind);
      this.deps.events.onMediaState({ mic: this.micEnabled, cam: this.camEnabled });
    } catch (err) {
      this.deps.events.onError(mediaError(err));
      this.leave();
    }
  }

  /** Mesh only: reconcile peer connections against the authoritative roster. No-op on LiveKit. */
  async setPeers(peers: string[]): Promise<void> {
    if (this.livekitRoom) return; // LiveKit manages roster through SFU
    if (!this.currentCallIdStr) return;

    const targetSet = new Set(peers);

    // Remove departed peers
    for (const [peerId, peer] of Array.from(this.peers.entries())) {
      if (!targetSet.has(peerId)) {
        if (peer.disconnectTimer) clearTimeout(peer.disconnectTimer);
        peer.pc.close();
        this.peers.delete(peerId);
        this.deps.events.onRemoteGone(peerId);
      }
    }

    // Add new peers
    for (const peerId of targetSet) {
      if (!this.peers.has(peerId)) {
        const peer = this.createPeerConnection(peerId);
        // Only impolite peer (lexicographically smaller sessionId) creates initial offer
        if (this.deps.selfId() < peerId) {
          try {
            const offer = await peer.pc.createOffer();
            await peer.pc.setLocalDescription(offer);
            this.deps.sendSignal(peerId, { sdp: peer.pc.localDescription });
          } catch (err) {
            // Non-fatal negotiation error
          }
        }
      }
    }
  }

  async handleSignal(from: string, data: unknown): Promise<void> {
    if (this.livekitRoom) return; // LiveKit manages own signaling
    if (!this.currentCallIdStr) return;

    const blob = data as {
      sdp?: RTCSessionDescriptionInit;
      candidate?: RTCIceCandidateInit;
    } | null;
    if (!blob) return;

    let peer = this.peers.get(from);
    if (!peer) {
      peer = this.createPeerConnection(from);
    }

    try {
      if (blob.sdp) {
        await peer.pc.setRemoteDescription(blob.sdp);
        peer.haveRemoteDescription = true;
        for (const c of peer.pendingCandidates.splice(0)) {
          try {
            await peer.pc.addIceCandidate(c);
          } catch {}
        }
        if (blob.sdp.type === "offer") {
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          this.deps.sendSignal(from, { sdp: peer.pc.localDescription });
        }
      } else if (blob.candidate) {
        if (peer.haveRemoteDescription) {
          await peer.pc.addIceCandidate(blob.candidate);
        } else {
          peer.pendingCandidates.push(blob.candidate);
        }
      }
    } catch (err) {
      // Non-fatal signaling error
    }
  }

  setMicEnabled(on: boolean): void {
    this.micEnabled = on;
    try {
      localStorage.setItem("pixeloffice.mic.enabled", String(on));
    } catch {}

    if (this.livekitRoom) {
      void this.livekitRoom.localParticipant.setMicrophoneEnabled(on);
    }
    if (this.localStream) {
      for (const t of this.localStream.getAudioTracks()) t.enabled = on;
    }
    this.deps.events.onMediaState({ mic: this.micEnabled, cam: this.camEnabled });
  }

  setCamEnabled(on: boolean): void {
    this.camEnabled = on;
    try {
      localStorage.setItem("pixeloffice.camera.enabled", String(on));
    } catch {}

    if (this.livekitRoom) {
      void this.livekitRoom.localParticipant.setCameraEnabled(on);
    }
    if (this.localStream) {
      for (const t of this.localStream.getVideoTracks()) t.enabled = on;
    }
    this.deps.events.onMediaState({ mic: this.micEnabled, cam: this.camEnabled });
  }

  leave(): void {
    this.currentCallIdStr = null;
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) t.stop();
      this.localStream = null;
    }

    for (const peer of this.peers.values()) {
      if (peer.disconnectTimer) clearTimeout(peer.disconnectTimer);
      peer.pc.close();
    }
    this.peers.clear();

    if (this.livekitRoom) {
      void this.livekitRoom.disconnect();
      this.livekitRoom = null;
    }
    this.livekitStreams.clear();
  }

  private createPeerConnection(peerId: string): PeerConnectionState {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const remoteStream = new MediaStream();
    const peer: PeerConnectionState = {
      pc,
      remoteStream,
      pendingCandidates: [],
      haveRemoteDescription: false,
      disconnectTimer: null,
    };
    this.peers.set(peerId, peer);

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        pc.addTrack(track, this.localStream);
      }
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        const candidate =
          typeof e.candidate.toJSON === "function"
            ? e.candidate.toJSON()
            : JSON.parse(JSON.stringify(e.candidate));
        this.deps.sendSignal(peerId, { candidate });
      }
    };

    pc.ontrack = (e) => {
      for (const track of e.streams[0]?.getTracks() ?? [e.track]) {
        remoteStream.addTrack(track);
      }
      this.deps.events.onRemoteStream(peerId, remoteStream);
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected") {
        if (peer.disconnectTimer) {
          clearTimeout(peer.disconnectTimer);
          peer.disconnectTimer = null;
        }
        return;
      }
      if (s === "disconnected") {
        if (peer.disconnectTimer) return;
        peer.disconnectTimer = setTimeout(() => {
          if (this.peers.get(peerId) === peer && pc.connectionState === "disconnected") {
            peer.pc.close();
            this.peers.delete(peerId);
            this.deps.events.onRemoteGone(peerId);
          }
        }, DISCONNECT_GRACE_MS);
        return;
      }
      if (s === "failed" || s === "closed") {
        if (this.peers.has(peerId)) {
          peer.pc.close();
          this.peers.delete(peerId);
          this.deps.events.onRemoteGone(peerId);
        }
      }
    };

    return peer;
  }

  private async getLiveKitConfig(): Promise<{ enabled: boolean; url?: string }> {
    if (this.livekitConfig) return this.livekitConfig;
    if (!this.configPromise) {
      this.configPromise = fetch("/api/livekit/config")
        .then((res) => (res.ok ? res.json() : { enabled: false }))
        .catch(() => ({ enabled: false }));
    }
    this.livekitConfig = await this.configPromise;
    return this.livekitConfig;
  }

  private async joinLiveKit(callId: string, kind: RtcCallKind, lkUrl: string): Promise<void> {
    const selfId = this.deps.selfId();
    const roomName = `call-${callId}`;

    const res = await fetch("/api/livekit/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: roomName, identity: selfId }),
    });

    if (!res.ok) throw new Error("Could not acquire LiveKit room token.");
    const { token, url } = (await res.json()) as { token: string; url: string };

    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
    });
    this.livekitRoom = room;

    room.on(
      RoomEvent.TrackSubscribed,
      (track, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        const pid = participant.identity;
        let stream = this.livekitStreams.get(pid);
        if (!stream) {
          stream = new MediaStream();
          this.livekitStreams.set(pid, stream);
        }
        if (track.mediaStreamTrack) {
          stream.addTrack(track.mediaStreamTrack);
          this.deps.events.onRemoteStream(pid, stream);
        }
      },
    );

    room.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
      const pid = participant.identity;
      const stream = this.livekitStreams.get(pid);
      if (stream && track.mediaStreamTrack) {
        stream.removeTrack(track.mediaStreamTrack);
      }
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      const pid = participant.identity;
      this.livekitStreams.delete(pid);
      this.deps.events.onRemoteGone(pid);
    });

    room.on(RoomEvent.Disconnected, () => {
      this.leave();
    });

    await room.connect(url || lkUrl, token);

    await room.localParticipant.setMicrophoneEnabled(this.micEnabled);
    if (kind === "video" && this.camEnabled) {
      await room.localParticipant.setCameraEnabled(true);
      const localVideoTrack = room.localParticipant.getTrackPublication(Track.Source.Camera)
        ?.track?.mediaStreamTrack;
      if (localVideoTrack) {
        const localStream = new MediaStream([localVideoTrack]);
        this.deps.events.onLocalStream(localStream, kind);
      }
    }

    this.deps.events.onMediaState({ mic: this.micEnabled, cam: this.camEnabled });
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
