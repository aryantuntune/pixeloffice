// ---------------------------------------------------------------------------
// Call panel — floating conference & 1:1 call dock (video tiles + ring card).
//
// Replaces the old 2-tile proximity prompt with global calling. Operates on
// server-owned CallStateS2C / CallRingS2C / CallEndedS2C payloads — no distance
// tracking, no proximity recompute.
// ---------------------------------------------------------------------------

import type {
  CallInviteC2S,
  CallAnswerC2S,
  CallLeaveC2S,
  RtcSignalC2S,
  CallRingS2C,
  CallStateS2C,
  CallEndedS2C,
  RtcSignalS2C,
} from "@pixeloffice/shared";
import { CallManager } from "../rtc/call-manager";
import { startRingtone, stopRingtone, playJoinTone, playLeaveTone } from "../rtc/call-audio";

export interface CallPanelDeps {
  getSelfId: () => string;
  sendInvite(p: CallInviteC2S): void;
  sendAnswer(p: CallAnswerC2S): void;
  sendLeave(p: CallLeaveC2S): void;
  sendSignal(p: RtcSignalC2S): void;
  toast?(message: string): void;
}

export interface CallPanelHandle {
  handleRing(p: CallRingS2C): void;
  handleState(p: CallStateS2C): void;
  handleEnded(p: CallEndedS2C): void;
  handleSignal(p: RtcSignalS2C): void;
  /** True while a call session is live — relabels the profile card's buttons. */
  isInCall(): boolean;
  destroy(): void;
}

interface PeerTile {
  tile: HTMLElement;
  video: HTMLVideoElement;
  caption: HTMLElement;
  stream: MediaStream | null;
}

export function mountCallPanel(parent: HTMLElement, deps: CallPanelDeps): CallPanelHandle {
  const root = document.createElement("div");
  root.className = "call-root";
  parent.appendChild(root);
  let ring: CallRingS2C | null = null;
  let call: CallStateS2C | null = null;
  const tiles = new Map<string, PeerTile>();
  let localStream: MediaStream | null = null;
  let isTheaterMode = false;
  let isSelfHidden = false;
  let panelPos: { x: number; y: number } | null = null;
  let customWidth: number | null = null;
  const manager = new CallManager({
    selfId: deps.getSelfId,
    sendSignal: (to, data) => deps.sendSignal({ to, data }),
    events: {
      onRemoteStream(peerId, stream) {
        let entry = tiles.get(peerId);
        if (!entry) {
          entry = createPeerTile(peerId);
          tiles.set(peerId, entry);
        }
        entry.stream = stream;
        if (entry.video.srcObject !== stream) {
          entry.video.srcObject = stream;
          void entry.video.play().catch(() => {});
        }
        render();
      },
      onRemoteGone(peerId) {
        const entry = tiles.get(peerId);
        if (entry) {
          entry.video.srcObject = null;
          entry.tile.remove();
          tiles.delete(peerId);
        }
        render();
      },
      onLocalStream(stream, _kind) {
        localStream = stream;
        render();
      },
      onMediaState(_state) {
        render();
      },
      onError(message) {
        deps.toast?.(message);
      },
    },
  });

  function createPeerTile(peerId: string): PeerTile {
    const tile = document.createElement("div");
    tile.className = "call-tile";
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    const caption = document.createElement("span");
    caption.className = "call-tile-name";
    caption.textContent = getPeerName(peerId);
    tile.append(video, caption);
    return { tile, video, caption, stream: null };
  }

  function getPeerName(peerId: string): string {
    if (!call) return "Participant";
    const found = call.participants.find((p) => p.sessionId === peerId);
    return found?.name ?? "Participant";
  }

  function render(): void {
    root.innerHTML = "";

    // 1. Inbound Ring Card
    if (ring) {
      const ringCard = document.createElement("div");
      ringCard.className = "call-ring";

      const info = document.createElement("div");
      info.className = "call-ring-info";

      const title = document.createElement("div");
      title.className = "call-ring-title";
      const extraCount = ring.participants.length > 1 ? ` · ${ring.participants.length} in call` : "";
      title.textContent = `${ring.fromName} is calling${extraCount}`;

      const subtitle = document.createElement("div");
      subtitle.className = "call-ring-sub";
      subtitle.textContent = ring.kind === "video" ? "📹 Video call" : "🎤 Voice call";

      info.append(title, subtitle);
      ringCard.appendChild(info);

      const btns = document.createElement("div");
      btns.className = "call-ring-btns";

      if (!call) {
        // Idle state: Accept / Reject
        const acceptBtn = document.createElement("button");
        acceptBtn.type = "button";
        acceptBtn.className = "call-btn call-btn-accept";
        acceptBtn.textContent = ring.kind === "video" ? "📹 Accept" : "🎤 Accept";
        acceptBtn.addEventListener("click", (e) => {
          e.preventDefault();
          const r = ring;
          if (r) {
            deps.sendAnswer({ callId: r.callId, answer: "accept" });
            ring = null;
            render();
          }
        });

        const rejectBtn = document.createElement("button");
        rejectBtn.type = "button";
        rejectBtn.className = "call-btn call-btn-reject";
        rejectBtn.textContent = "Reject";
        rejectBtn.addEventListener("click", (e) => {
          e.preventDefault();
          const r = ring;
          if (r) {
            deps.sendAnswer({ callId: r.callId, answer: "reject" });
            ring = null;
            render();
          }
        });

        btns.append(acceptBtn, rejectBtn);
      } else {
        // Already in call: Switch / Merge / Reject
        const switchBtn = document.createElement("button");
        switchBtn.type = "button";
        switchBtn.className = "call-btn call-btn-switch";
        switchBtn.textContent = "Switch";
        switchBtn.title = "Leave current call and take this one";
        switchBtn.addEventListener("click", (e) => {
          e.preventDefault();
          const r = ring;
          if (r) {
            deps.sendAnswer({ callId: r.callId, answer: "switch" });
            ring = null;
            render();
          }
        });

        const mergeBtn = document.createElement("button");
        mergeBtn.type = "button";
        mergeBtn.className = "call-btn call-btn-merge";
        mergeBtn.textContent = "Merge";
        mergeBtn.title = "Combine everyone into one call";
        mergeBtn.addEventListener("click", (e) => {
          e.preventDefault();
          const r = ring;
          if (r) {
            deps.sendAnswer({ callId: r.callId, answer: "merge" });
            ring = null;
            render();
          }
        });

        const rejectBtn = document.createElement("button");
        rejectBtn.type = "button";
        rejectBtn.className = "call-btn call-btn-reject";
        rejectBtn.textContent = "Reject";
        rejectBtn.addEventListener("click", (e) => {
          e.preventDefault();
          const r = ring;
          if (r) {
            deps.sendAnswer({ callId: r.callId, answer: "reject" });
            ring = null;
            render();
          }
        });

        btns.append(switchBtn, mergeBtn, rejectBtn);
      }

      ringCard.appendChild(btns);
      root.appendChild(ringCard);
    }

    // 2. Active Call Panel
    if (call) {
      const panel = document.createElement("div");
      panel.className = `call-panel ${isTheaterMode ? "is-theater" : ""}`;
      if (customWidth && !isTheaterMode) {
        panel.style.width = `${customWidth}px`;
        panel.style.maxWidth = "none";
      }

      const isOutgoing = call.participants.length === 1 && call.pending.length > 0;
      const header = document.createElement("div");
      header.className = "call-panel-header";

      const headerLeft = document.createElement("div");
      headerLeft.className = "call-panel-header-left";

      const title = document.createElement("div");
      title.className = "call-panel-title";
      if (isOutgoing) {
        title.textContent = `Calling ${call.pending[0].name}…`;
      } else {
        const kindLabel = call.kind === "video" ? "Video" : "Voice";
        title.textContent = `${kindLabel} call · ${call.participants.length} people`;
      }
      headerLeft.appendChild(title);

      if (!isOutgoing && call.pending.length > 0) {
        const pendingLine = document.createElement("div");
        pendingLine.className = "call-pending";
        pendingLine.textContent = `Ringing ${call.pending.map((p) => p.name).join(", ")}…`;
        headerLeft.appendChild(pendingLine);
      }

      const headerActions = document.createElement("div");
      headerActions.className = "call-panel-header-actions";

      if (call.kind === "video") {
        const selfToggleBtn = document.createElement("button");
        selfToggleBtn.type = "button";
        selfToggleBtn.className = `call-panel-tool-btn ${isSelfHidden ? "is-active" : ""}`;
        selfToggleBtn.title = isSelfHidden ? "Show my video" : "Hide my video";
        selfToggleBtn.textContent = isSelfHidden ? "👁️‍🗨️" : "👁";
        selfToggleBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          isSelfHidden = !isSelfHidden;
          render();
        });
        headerActions.appendChild(selfToggleBtn);
      }

      const theaterBtn = document.createElement("button");
      theaterBtn.type = "button";
      theaterBtn.className = `call-panel-tool-btn ${isTheaterMode ? "is-active" : ""}`;
      theaterBtn.title = isTheaterMode ? "Restore compact dock" : "Expand theater mode";
      theaterBtn.textContent = isTheaterMode ? "🗗" : "⛶";
      theaterBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        isTheaterMode = !isTheaterMode;
        render();
      });
      headerActions.appendChild(theaterBtn);

      header.append(headerLeft, headerActions);

      // Drag-to-move handling on header
      header.addEventListener("pointerdown", (e) => {
        const target = e.target as HTMLElement | null;
        if (target?.closest("button")) return;
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const rect = root.getBoundingClientRect();
        const startLeft = rect.left;
        const startTop = rect.top;

        const onPointerMove = (ev: PointerEvent) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          const maxX = Math.max(10, window.innerWidth - rect.width - 10);
          const maxY = Math.max(10, window.innerHeight - rect.height - 10);
          const newX = Math.min(Math.max(10, startLeft + dx), maxX);
          const newY = Math.min(Math.max(10, startTop + dy), maxY);
          panelPos = { x: newX, y: newY };
          root.style.left = `${newX}px`;
          root.style.top = `${newY}px`;
          root.style.bottom = "auto";
          root.style.transform = "none";
        };

        const onPointerUp = () => {
          window.removeEventListener("pointermove", onPointerMove);
          window.removeEventListener("pointerup", onPointerUp);
        };

        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
      });

      panel.appendChild(header);

      // Video tiles container
      const selfId = deps.getSelfId();
      const remotes = call.participants.filter((p) => p.sessionId !== selfId);
      const isGroup = remotes.length >= 2;
      const is1on1 = remotes.length === 1;
      const isAudio = call.kind === "audio";
      const grid = document.createElement("div");
      grid.className = `call-tiles ${isAudio ? "is-audio" : ""} ${isGroup ? "is-group" : is1on1 ? "is-1on1" : "is-solo"}`;
      for (const p of remotes) {
        let entry = tiles.get(p.sessionId);
        if (!entry) {
          entry = createPeerTile(p.sessionId);
          tiles.set(p.sessionId, entry);
        }
        entry.caption.textContent = p.name;
        grid.appendChild(entry.tile);
      }

      // Self view: stays as sleek floating PiP in both 1:1 and group video calls
      if (call.kind === "video" && !isSelfHidden) {
        const selfTile = document.createElement("div");
        selfTile.className = "call-tile call-tile-self";
        const selfVid = document.createElement("video");
        selfVid.muted = true;
        selfVid.autoplay = true;
        selfVid.playsInline = true;
        if (localStream && selfVid.srcObject !== localStream) {
          selfVid.srcObject = localStream;
          void selfVid.play().catch(() => {});
        }
        const selfCap = document.createElement("span");
        selfCap.className = "call-tile-name";
        selfCap.textContent = "You";
        selfTile.append(selfVid, selfCap);
        grid.appendChild(selfTile);
      }

      panel.appendChild(grid);

      // Controls dock
      const controls = document.createElement("div");
      controls.className = "call-controls";

      const micBtn = document.createElement("button");
      micBtn.type = "button";
      micBtn.className = `call-btn call-btn-mic ${manager.isMicEnabled() ? "" : "is-muted"}`;
      micBtn.textContent = manager.isMicEnabled() ? "🎤 Mute" : "🔇 Unmute";
      micBtn.addEventListener("click", (e) => {
        e.preventDefault();
        manager.setMicEnabled(!manager.isMicEnabled());
        render();
      });
      controls.appendChild(micBtn);

      if (call.kind === "video") {
        const camBtn = document.createElement("button");
        camBtn.type = "button";
        camBtn.className = `call-btn call-btn-cam ${manager.isCamEnabled() ? "" : "is-off"}`;
        camBtn.textContent = manager.isCamEnabled() ? "📹 Camera off" : "📹 Camera on";
        camBtn.addEventListener("click", (e) => {
          e.preventDefault();
          manager.setCamEnabled(!manager.isCamEnabled());
          render();
        });
        controls.appendChild(camBtn);
      }

      const leaveBtn = document.createElement("button");
      leaveBtn.type = "button";
      leaveBtn.className = "call-btn call-btn-hangup";
      leaveBtn.textContent = isOutgoing ? "✖ Cancel" : "✖ Leave";
      leaveBtn.addEventListener("click", (e) => {
        e.preventDefault();
        const cid = call?.callId;
        if (cid) {
          deps.sendLeave({ callId: cid });
        }
        stopRingtone();
        playLeaveTone();
        manager.leave();
        call = null;
        tiles.clear();
        localStream = null;
        render();
      });
      controls.appendChild(leaveBtn);

      panel.appendChild(controls);

      // Corner drag-to-resize handle
      const resizeHandle = document.createElement("div");
      resizeHandle.className = "call-resize-handle";
      resizeHandle.title = "Drag to resize";
      resizeHandle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startWidth = panel.getBoundingClientRect().width;

        const onPointerMove = (ev: PointerEvent) => {
          const dx = ev.clientX - startX;
          const maxWidth = Math.min(window.innerWidth - 40, 920);
          const newWidth = Math.min(Math.max(300, startWidth + dx), maxWidth);
          customWidth = newWidth;
          panel.style.width = `${newWidth}px`;
          panel.style.maxWidth = "none";
        };

        const onPointerUp = () => {
          window.removeEventListener("pointermove", onPointerMove);
          window.removeEventListener("pointerup", onPointerUp);
        };

        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
      });
      panel.appendChild(resizeHandle);

      // Restore preserved drag coordinates if moved
      if (panelPos) {
        root.style.left = `${panelPos.x}px`;
        root.style.top = `${panelPos.y}px`;
        root.style.bottom = "auto";
        root.style.transform = "none";
      }

      root.appendChild(panel);
    }
  }

  return {
    handleRing(p: CallRingS2C): void {
      ring = p;
      startRingtone();
      deps.toast?.(`${p.fromName} is ${p.kind === "video" ? "video " : ""}calling…`);
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification("PixelOffice", {
          body: `${p.fromName} is ${p.kind === "video" ? "video " : ""}calling…`,
        });
      }
      render();
    },

    handleState(p: CallStateS2C): void {
      const selfId = deps.getSelfId();
      const isParticipant = p.participants.some((x) => x.sessionId === selfId);

      if (!isParticipant) {
        // If we are NOT in participants (e.g. pending invitee awaiting accept,
        // or removed/left), we must not auto-join or clear ring cards.
        if (call?.callId === p.callId) {
          stopRingtone();
          playLeaveTone();
          manager.leave();
          call = null;
          tiles.clear();
          localStream = null;
          render();
        }
        return;
      }

      if (call?.callId !== p.callId) {
        stopRingtone();
        playJoinTone();
        manager.leave();
        void manager.join(p.callId, p.kind);
      }

      call = p;
      if (ring?.callId === p.callId) {
        ring = null;
        stopRingtone();
      }

      const remotePeers = p.participants
        .map((x) => x.sessionId)
        .filter((id) => id !== selfId);

      void manager.setPeers(remotePeers);

      // Drop cached tiles for peers that left
      const participantSet = new Set(remotePeers);
      for (const [peerId, entry] of Array.from(tiles.entries())) {
        if (!participantSet.has(peerId)) {
          entry.video.srcObject = null;
          entry.tile.remove();
          tiles.delete(peerId);
        }
      }

      render();
    },

    handleEnded(p: CallEndedS2C): void {
      stopRingtone();
      if (call?.callId === p.callId) {
        playLeaveTone();
        manager.leave();
        call = null;
        tiles.clear();
        localStream = null;
      }
      if (ring?.callId === p.callId) {
        ring = null;
      }

      if (p.reason === "rejected") {
        deps.toast?.("Call declined.");
      } else if (p.reason === "cancelled") {
        deps.toast?.("Call cancelled.");
      } else if (p.reason === "left" || p.reason === "empty") {
        deps.toast?.("Call ended.");
      }

      render();
    },

    handleSignal(p: RtcSignalS2C): void {
      void manager.handleSignal(p.from, p.data);
    },

    isInCall(): boolean {
      return call !== null;
    },

    destroy(): void {
      stopRingtone();
      manager.leave();
      tiles.clear();
      localStream = null;
      ring = null;
      call = null;
      root.remove();
    },
  };
}
