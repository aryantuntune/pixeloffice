// ---------------------------------------------------------------------------
// Proximity call UI + controller. This is the seam between the PURE proximity
// rule (shared), the WebRTC plumbing (CallManager), the store (positions), and
// the DOM. It renders three things:
//   - the proximity prompt: when within 2 tiles of a peer, two buttons pop up
//     ("Speak" = audio call, "Video" = video call) per the product spec.
//   - the incoming-call card: Accept / Reject when a peer calls you.
//   - the active-call panel: remote video/audio tile + mute + hang up.
//
// Human agency (Constitution): mic + camera are OFF by default. A call only
// starts on an explicit click AND the peer's explicit Accept. Leaving the
// 2-tile proximity auto-mutes the mic and ends the call (spec 1b). Nothing here
// moves an avatar or auto-connects anyone.
//
// It is a render-from-state component: the orchestration (proximity recompute,
// signaling) lives here as this feature's client controller, NOT in the Phaser
// scene or in main.ts (which only forwards messages).
// ---------------------------------------------------------------------------

import {
  PROXIMITY_TILES,
  chebyshev,
  peersWithin,
  type PlayerSnapshot,
  type RtcCallC2S,
  type RtcCallS2C,
  type RtcSignalC2S,
  type RtcSignalS2C,
  type RtcCallKind,
} from "@pixeloffice/shared";
import type { Store } from "./state";
import { CallManager } from "../rtc/call-manager";

/** Per-peer call lifecycle as the UI sees it. */
type CallPhase = "idle" | "outgoing" | "incoming" | "active";
interface CallState {
  peerId: string;
  peerName: string;
  kind: RtcCallKind;
  phase: CallPhase;
}

export interface ProximityCallDeps {
  store: Store;
  getSelfId: () => string;
  sendCall(payload: RtcCallC2S): void;
  sendSignal(payload: RtcSignalC2S): void;
  toast?(message: string): void;
}

export interface ProximityCallHandle {
  /** Feed an inbound S2C.RTC_CALL (request/accept/reject/cancel/hangup). */
  handleCall(payload: RtcCallS2C): void;
  /** Feed an inbound S2C.RTC_SIGNAL (SDP/ICE). */
  handleSignal(payload: RtcSignalS2C): void;
  /** A peer left the floor/office — tear down any call with them. */
  handlePeerGone(sessionId: string): void;
  destroy(): void;
}

export function mountProximityCall(
  parent: HTMLElement,
  deps: ProximityCallDeps,
): ProximityCallHandle {
  // At most ONE active/pending call at a time (spec: approach "someone").
  // Tracked by peer so glare/role logic stays simple.
  let call: CallState | null = null;
  // The nearest in-range peer when idle (drives the proximity prompt buttons).
  let nearest: { id: string; name: string } | null = null;
  // Remembers the kind a peer requested so we can answer with the right media.
  const requestedKind = new Map<string, RtcCallKind>();

  // --- DOM -----------------------------------------------------------------
  const root = document.createElement("div");
  root.className = "prox-call";
  root.hidden = true;

  // Proximity prompt (idle, in range).
  const prompt = document.createElement("div");
  prompt.className = "prox-prompt";
  const promptName = document.createElement("span");
  promptName.className = "prox-prompt-name";
  const btnSpeak = document.createElement("button");
  btnSpeak.className = "prox-btn prox-btn-audio";
  btnSpeak.type = "button";
  btnSpeak.textContent = "🎤 Speak";
  const btnVideo = document.createElement("button");
  btnVideo.className = "prox-btn prox-btn-video";
  btnVideo.type = "button";
  btnVideo.textContent = "📹 Video call";
  prompt.append(promptName, btnSpeak, btnVideo);

  // Incoming-call card.
  const incoming = document.createElement("div");
  incoming.className = "prox-incoming";
  const incomingText = document.createElement("div");
  incomingText.className = "prox-incoming-text";
  const btnAccept = document.createElement("button");
  btnAccept.className = "prox-btn prox-btn-accept";
  btnAccept.type = "button";
  btnAccept.textContent = "Accept";
  const btnReject = document.createElement("button");
  btnReject.className = "prox-btn prox-btn-reject";
  btnReject.type = "button";
  btnReject.textContent = "Reject";
  const incomingBtns = document.createElement("div");
  incomingBtns.className = "prox-incoming-btns";
  incomingBtns.append(btnAccept, btnReject);
  incoming.append(incomingText, incomingBtns);

  // Active-call panel.
  const panel = document.createElement("div");
  panel.className = "prox-panel";
  const panelTitle = document.createElement("div");
  panelTitle.className = "prox-panel-title";
  const tiles = document.createElement("div");
  tiles.className = "prox-tiles";
  const remoteVideo = document.createElement("video");
  remoteVideo.className = "prox-video prox-remote";
  remoteVideo.autoplay = true;
  remoteVideo.playsInline = true;
  const localVideo = document.createElement("video");
  localVideo.className = "prox-video prox-local";
  localVideo.autoplay = true;
  localVideo.playsInline = true;
  localVideo.muted = true; // never play back our own mic (no echo)
  tiles.append(remoteVideo, localVideo);
  const controls = document.createElement("div");
  controls.className = "prox-controls";
  const btnMute = document.createElement("button");
  btnMute.className = "prox-btn prox-btn-mute";
  btnMute.type = "button";
  const btnHangup = document.createElement("button");
  btnHangup.className = "prox-btn prox-btn-hangup";
  btnHangup.type = "button";
  btnHangup.textContent = "✖ Hang up";
  // Outgoing "calling…" cancel reuses the panel footer.
  const callingLabel = document.createElement("span");
  callingLabel.className = "prox-calling";
  controls.append(callingLabel, btnMute, btnHangup);
  panel.append(panelTitle, tiles, controls);

  root.append(prompt, incoming, panel);
  parent.appendChild(root);

  // --- CallManager (WebRTC plumbing) --------------------------------------
  const manager = new CallManager({
    selfId: deps.getSelfId,
    sendSignal: (to, data) => deps.sendSignal({ to, data }),
    events: {
      onRemoteStream: (peerId, stream) => {
        if (call?.peerId === peerId) remoteVideo.srcObject = stream;
      },
      onLocalStream: (peerId, stream, kind) => {
        if (call?.peerId === peerId && kind === "video") localVideo.srcObject = stream;
      },
      onCallActive: (peerId, kind) => {
        if (!call || call.peerId !== peerId) return;
        call.phase = "active";
        call.kind = kind;
        // The user consented to this conversation (called or accepted), so
        // unmute on connect — "unmute and speak" (spec 1a). The Mute button
        // then lets them silence themselves at will.
        manager.setMicEnabled(peerId, true);
        render();
      },
      onCallEnded: (peerId) => {
        if (call?.peerId === peerId) {
          call = null;
          remoteVideo.srcObject = null;
          localVideo.srcObject = null;
          render();
        }
      },
      onMicState: () => render(),
      onError: (_peerId, message) => {
        deps.toast?.(message);
      },
    },
  });

  // --- user actions --------------------------------------------------------
  function placeCall(kind: RtcCallKind): void {
    if (!nearest || call) return;
    call = { peerId: nearest.id, peerName: nearest.name, kind, phase: "outgoing" };
    deps.sendCall({ to: nearest.id, kind, action: "request" });
    render();
  }
  btnSpeak.addEventListener("click", () => placeCall("audio"));
  btnVideo.addEventListener("click", () => placeCall("video"));

  btnAccept.addEventListener("click", () => {
    if (!call || call.phase !== "incoming") return;
    const { peerId, kind } = call;
    deps.sendCall({ to: peerId, kind, action: "accept" });
    // Both sides begin negotiation on accept; CallManager's polite/impolite
    // split decides who actually offers (glare-free).
    void manager.startCall(peerId, kind);
    render();
  });
  btnReject.addEventListener("click", () => {
    if (!call || call.phase !== "incoming") return;
    deps.sendCall({ to: call.peerId, kind: call.kind, action: "reject" });
    call = null;
    render();
  });
  btnMute.addEventListener("click", () => {
    if (!call || call.phase !== "active") return;
    const next = !manager.isMicEnabled(call.peerId);
    manager.setMicEnabled(call.peerId, next);
  });
  btnHangup.addEventListener("click", () => {
    if (!call) return;
    const action = call.phase === "outgoing" ? "cancel" : "hangup";
    deps.sendCall({ to: call.peerId, kind: call.kind, action });
    manager.endCall(call.peerId);
    if (action === "cancel") call = null; // endCall has nothing to end yet
    render();
  });

  // --- inbound relayed messages -------------------------------------------
  function handleCall(p: RtcCallS2C): void {
    switch (p.action) {
      case "request": {
        // Ignore a new request while already busy — auto-reject so the caller
        // is not left hanging.
        if (call) {
          deps.sendCall({ to: p.from, kind: p.kind, action: "reject" });
          return;
        }
        requestedKind.set(p.from, p.kind);
        call = { peerId: p.from, peerName: p.fromName, kind: p.kind, phase: "incoming" };
        deps.toast?.(`${p.fromName} is ${p.kind === "video" ? "video " : ""}calling…`);
        render();
        break;
      }
      case "accept": {
        if (call?.peerId === p.from && call.phase === "outgoing") {
          void manager.startCall(p.from, call.kind);
          // phase flips to "active" via onCallActive once media negotiates.
          render();
        }
        break;
      }
      case "reject": {
        if (call?.peerId === p.from && call.phase === "outgoing") {
          deps.toast?.(`${p.fromName} declined.`);
          call = null;
          render();
        }
        break;
      }
      case "cancel": {
        if (call?.peerId === p.from && call.phase === "incoming") {
          call = null;
          render();
        }
        break;
      }
      case "hangup": {
        if (call?.peerId === p.from) {
          manager.endCall(p.from);
          call = null;
          render();
        }
        break;
      }
    }
  }

  function handleSignal(p: RtcSignalS2C): void {
    const kind = call?.peerId === p.from ? call.kind : requestedKind.get(p.from) ?? "audio";
    void manager.handleSignal(p.from, p.data, kind);
  }

  function handlePeerGone(sessionId: string): void {
    requestedKind.delete(sessionId);
    if (call?.peerId === sessionId) {
      manager.endCall(sessionId);
      call = null;
      render();
    }
  }

  // --- proximity recompute (store-driven) ---------------------------------
  function selfAndOthers(): { self: PlayerSnapshot | undefined; others: PlayerSnapshot[] } {
    const state = deps.store.get();
    const self = deps.store.self();
    const others: PlayerSnapshot[] = [];
    for (const [, p] of state.players) others.push(p);
    return { self, others };
  }

  function recomputeProximity(): void {
    const { self, others } = selfAndOthers();
    if (!self) {
      nearest = null;
      render();
      return;
    }
    const inRange = new Set(peersWithin(self, others, PROXIMITY_TILES));

    // Spec 1b: if we have a call with a peer who is no longer in range, auto-mute
    // the mic immediately and end the call (out of talking distance).
    if (call && !inRange.has(call.peerId)) {
      manager.setMicEnabled(call.peerId, false);
      if (call.phase !== "incoming") {
        deps.sendCall({ to: call.peerId, kind: call.kind, action: "hangup" });
      } else {
        deps.sendCall({ to: call.peerId, kind: call.kind, action: "reject" });
      }
      manager.endCall(call.peerId);
      deps.toast?.(`Call with ${call.peerName} ended — out of range.`);
      call = null;
    }

    // Pick the single nearest in-range peer for the prompt buttons.
    nearest = null;
    let best = Infinity;
    for (const p of others) {
      if (!inRange.has(p.sessionId)) continue;
      const d = chebyshev(self.x, self.y, p.x, p.y);
      if (d < best) {
        best = d;
        nearest = { id: p.sessionId, name: p.name };
      }
    }
    render();
  }

  // --- render --------------------------------------------------------------
  function render(): void {
    const showPrompt = !call && !!nearest;
    const showIncoming = call?.phase === "incoming";
    const showPanel = call?.phase === "outgoing" || call?.phase === "active";

    prompt.hidden = !showPrompt;
    incoming.hidden = !showIncoming;
    panel.hidden = !showPanel;
    root.hidden = !(showPrompt || showIncoming || showPanel);

    if (showPrompt && nearest) {
      promptName.textContent = `Near ${nearest.name}`;
    }
    if (showIncoming && call) {
      incomingText.textContent = `${call.peerName} wants to ${
        call.kind === "video" ? "video call" : "talk"
      }`;
    }
    if (showPanel && call) {
      const isVideo = call.kind === "video";
      tiles.hidden = !isVideo; // audio-only call: no video tiles
      if (call.phase === "outgoing") {
        panelTitle.textContent = `Calling ${call.peerName}…`;
        callingLabel.textContent = "Ringing…";
        callingLabel.hidden = false;
        btnMute.hidden = true;
        btnHangup.textContent = "✖ Cancel";
      } else {
        panelTitle.textContent = `${isVideo ? "Video" : "Voice"} call · ${call.peerName}`;
        callingLabel.hidden = true;
        btnMute.hidden = false;
        const micOn = manager.isMicEnabled(call.peerId);
        btnMute.textContent = micOn ? "🎤 Mute" : "🔇 Unmute";
        btnMute.classList.toggle("is-muted", !micOn);
        btnHangup.textContent = "✖ Hang up";
      }
    }
  }

  const unsubscribe = deps.store.subscribe(() => recomputeProximity());
  recomputeProximity();

  return {
    handleCall,
    handleSignal,
    handlePeerGone,
    destroy() {
      unsubscribe();
      manager.endAll();
      root.remove();
    },
  };
}
