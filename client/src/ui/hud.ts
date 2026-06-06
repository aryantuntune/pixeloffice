// ---------------------------------------------------------------------------
// The DOM HUD overlay. Renders entirely from the Store (server-pushed facts):
// top bar (logo, current area, status pill + dropdown, Join Meeting button),
// right roster grouped by presence, "Happening now" events panel, and the
// bottom-left chat input. It NEVER computes presence — it displays pushed state.
// User actions (set status, join/leave event, join meeting, chat) are explicit
// and forwarded through callbacks (human-agency rule: no auto-actions).
// ---------------------------------------------------------------------------

import {
  PRESENCE_META,
  PresenceState,
  areaAt,
  buildOfficeMap,
  type PlayerSnapshot,
  type SetStatusPayload,
  type SocialEvent,
  type SocialEventType,
} from "@pixeloffice/shared";
import type { Store, UiState } from "./state";

const MAP = buildOfficeMap();
const CHAT_MAX = 140;

/** Roster grouping order requested by the contract. */
const GROUP_ORDER: PresenceState[] = [
  PresenceState.AVAILABLE,
  PresenceState.IN_MEETING,
  PresenceState.FOCUS,
  PresenceState.BREAK,
  PresenceState.AWAY,
  PresenceState.OFFLINE,
];

const GROUP_LABEL: Record<PresenceState, string> = {
  [PresenceState.AVAILABLE]: "Available",
  [PresenceState.IN_MEETING]: "In Meeting",
  [PresenceState.FOCUS]: "Focus",
  [PresenceState.BREAK]: "Break",
  [PresenceState.AWAY]: "Away",
  [PresenceState.OFFLINE]: "Offline",
};

/** Status options the user can pick (maps to C2S.SET_STATUS). */
const STATUS_OPTIONS: SetStatusPayload["state"][] = ["AVAILABLE", "FOCUS", "BREAK", "AWAY"];

const EVENT_EMOJI: Record<SocialEventType, string> = {
  COFFEE_BREAK: "☕",
  TEA_BREAK: "🫖",
  TEAM_GATHERING: "🎉",
  TOWN_HALL: "📣",
};

function areaNameFor(p: PlayerSnapshot): string {
  return areaAt(MAP, p.x, p.y)?.name ?? "Hallway";
}

function timeLeftLabel(endTime: number): string {
  const ms = endTime - Date.now();
  if (ms <= 0) return "ending…";
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  if (mins > 0) return `${mins}m ${secs}s left`;
  return `${secs}s left`;
}

export interface HudCallbacks {
  onSetStatus(state: SetStatusPayload["state"]): void;
  onJoinEvent(eventId: string): void;
  onLeaveEvent(eventId: string): void;
  onJoinMeeting(meetingId: string): void;
  onLeaveMeeting(meetingId: string): void;
  onSendChat(text: string): void;
  /** Notify wiring that the chat input focus changed (to gate game input). */
  onChatFocus?(focused: boolean): void;
}

export interface HudHandle {
  /** Render once from the current store snapshot (called on every change). */
  render(): void;
  /** Tear down: remove the HUD DOM + its timer/global listeners. MUST be called
   *  on reconnect/teardown or the 1s interval and document listener leak. */
  destroy(): void;
}

export function createHud(parent: HTMLElement, store: Store, cb: HudCallbacks): HudHandle {
  // Build into our OWN layer (created + owned here), never clearing the shared
  // overlay root — toasts, the connection banner, the admin console and the
  // attendance widget are siblings under the same root and must survive a HUD
  // rebuild on reconnect.
  const layer = document.createElement("div");
  layer.className = "hud-layer";
  parent.appendChild(layer);

  // --- Top bar -------------------------------------------------------------
  const topBar = document.createElement("div");
  topBar.className = "hud-topbar";

  const logo = document.createElement("div");
  logo.className = "hud-logo";
  logo.textContent = "PixelOffice";

  const areaName = document.createElement("div");
  areaName.className = "hud-area";

  // Status pill + dropdown
  const statusWrap = document.createElement("div");
  statusWrap.className = "hud-status";
  const statusPill = document.createElement("button");
  statusPill.type = "button";
  statusPill.className = "hud-status-pill";
  const statusMenu = document.createElement("div");
  statusMenu.className = "hud-status-menu";
  statusMenu.hidden = true;
  for (const s of STATUS_OPTIONS) {
    const meta = PRESENCE_META[PresenceState[s as keyof typeof PresenceState]];
    const item = document.createElement("button");
    item.type = "button";
    item.className = "hud-status-item";
    const dot = document.createElement("span");
    dot.className = "presence-dot";
    dot.style.background = meta.color;
    item.append(dot, document.createTextNode(`${meta.label}`));
    item.addEventListener("click", () => {
      statusMenu.hidden = true;
      cb.onSetStatus(s);
    });
    statusMenu.appendChild(item);
  }
  statusPill.addEventListener("click", () => {
    statusMenu.hidden = !statusMenu.hidden;
  });
  const onDocClick = (e: MouseEvent): void => {
    if (!statusWrap.contains(e.target as Node)) statusMenu.hidden = true;
  };
  document.addEventListener("click", onDocClick);
  statusWrap.append(statusPill, statusMenu);

  // Join Meeting button (only visible when invited; agency rule)
  const meetingBtn = document.createElement("button");
  meetingBtn.type = "button";
  meetingBtn.className = "hud-meeting-btn";
  meetingBtn.hidden = true;

  topBar.append(logo, areaName, statusWrap, meetingBtn);

  // --- Right sidebar -------------------------------------------------------
  const sidebar = document.createElement("div");
  sidebar.className = "hud-sidebar";

  const rosterPanel = document.createElement("div");
  rosterPanel.className = "hud-panel hud-roster";
  const rosterTitle = document.createElement("h2");
  rosterTitle.className = "hud-panel-title";
  rosterTitle.textContent = "Team";
  const rosterBody = document.createElement("div");
  rosterBody.className = "hud-panel-body";
  rosterPanel.append(rosterTitle, rosterBody);

  const eventsPanel = document.createElement("div");
  eventsPanel.className = "hud-panel hud-events";
  const eventsTitle = document.createElement("h2");
  eventsTitle.className = "hud-panel-title";
  eventsTitle.textContent = "Happening now";
  const eventsBody = document.createElement("div");
  eventsBody.className = "hud-panel-body";
  eventsPanel.append(eventsTitle, eventsBody);

  sidebar.append(rosterPanel, eventsPanel);

  // --- Bottom-left chat ----------------------------------------------------
  const chatBar = document.createElement("div");
  chatBar.className = "hud-chat";
  const chatInput = document.createElement("input");
  chatInput.className = "hud-chat-input";
  chatInput.type = "text";
  chatInput.maxLength = CHAT_MAX;
  chatInput.placeholder = "Say something… (Enter to send)";
  // While the chat input is focused the game must not receive keystrokes.
  chatInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      const text = chatInput.value.trim();
      if (text) cb.onSendChat(text.slice(0, CHAT_MAX));
      chatInput.value = "";
      // Hand control straight back to the game — keeping focus here left the
      // movement lock on, so the avatar appeared frozen after every message.
      chatInput.blur();
    } else if (e.key === "Escape") {
      chatInput.blur();
    }
  });
  chatInput.addEventListener("focus", () => cb.onChatFocus?.(true));
  chatInput.addEventListener("blur", () => cb.onChatFocus?.(false));
  chatBar.appendChild(chatInput);

  layer.append(topBar, sidebar, chatBar);

  // --- Rendering helpers ---------------------------------------------------

  function renderStatusPill(self: PlayerSnapshot | undefined): void {
    const state = self?.presence ?? PresenceState.AVAILABLE;
    const meta = PRESENCE_META[state];
    statusPill.style.setProperty("--pill-color", meta.color);
    statusPill.innerHTML = "";
    const dot = document.createElement("span");
    dot.className = "presence-dot";
    dot.style.background = meta.color;
    const label = document.createElement("span");
    label.textContent = `${meta.emoji ? meta.emoji + " " : ""}${meta.label}`;
    const caret = document.createElement("span");
    caret.className = "hud-caret";
    caret.textContent = "▾";
    statusPill.append(dot, label, caret);
  }

  function renderMeeting(state: UiState): void {
    const m = state.myMeeting;
    if (!m) {
      meetingBtn.hidden = true;
      meetingBtn.onclick = null;
      return;
    }
    meetingBtn.hidden = false;
    if (state.joinedMeeting) {
      meetingBtn.classList.remove("pulse");
      meetingBtn.classList.add("joined");
      meetingBtn.textContent = `📅 Leave ${m.title}`;
      meetingBtn.disabled = false;
      meetingBtn.onclick = () => cb.onLeaveMeeting(m.id);
    } else {
      meetingBtn.classList.add("pulse");
      meetingBtn.classList.remove("joined");
      meetingBtn.disabled = false;
      meetingBtn.textContent = `📅 Join ${m.title}`;
      meetingBtn.onclick = () => cb.onJoinMeeting(m.id);
    }
  }

  function renderRoster(state: UiState): void {
    rosterBody.innerHTML = "";
    const players = [...state.players.values()];
    // Self first within each group: handled by sorting self to the front overall.
    const grouped = new Map<PresenceState, PlayerSnapshot[]>();
    for (const s of GROUP_ORDER) grouped.set(s, []);
    for (const p of players) {
      const bucket = grouped.get(p.presence) ?? grouped.get(PresenceState.AVAILABLE)!;
      bucket.push(p);
    }

    for (const s of GROUP_ORDER) {
      const bucket = grouped.get(s)!;
      if (bucket.length === 0) continue;
      bucket.sort((a, b) => {
        if (a.sessionId === state.selfId) return -1;
        if (b.sessionId === state.selfId) return 1;
        return a.name.localeCompare(b.name);
      });

      const groupEl = document.createElement("div");
      groupEl.className = "roster-group";
      const head = document.createElement("div");
      head.className = "roster-group-head";
      const meta = PRESENCE_META[s];
      const gdot = document.createElement("span");
      gdot.className = "presence-dot";
      gdot.style.background = meta.color;
      head.append(gdot, document.createTextNode(`${GROUP_LABEL[s]} (${bucket.length})`));
      groupEl.appendChild(head);

      for (const p of bucket) {
        const row = document.createElement("div");
        row.className = "roster-row";
        // Mark ambient NPCs so the stylesheet can dim them (display-only; NPCs
        // render identically in-game). Backward-compatible: humans have no flag.
        if (p.isNpc) row.dataset.npc = "true";
        const dot = document.createElement("span");
        dot.className = "presence-dot";
        dot.style.background = PRESENCE_META[p.presence].color;
        const info = document.createElement("div");
        info.className = "roster-info";
        const nameEl = document.createElement("div");
        nameEl.className = "roster-name";
        nameEl.textContent = p.sessionId === state.selfId ? `${p.name} (you)` : p.name;
        const sub = document.createElement("div");
        sub.className = "roster-sub";
        const chip = document.createElement("span");
        chip.className = "dept-chip";
        chip.dataset.dept = p.department;
        chip.textContent = p.department;
        const area = document.createElement("span");
        area.className = "roster-area";
        area.textContent = areaNameFor(p);
        sub.append(chip, area);
        info.append(nameEl, sub);
        row.append(dot, info);
        groupEl.appendChild(row);
      }
      rosterBody.appendChild(groupEl);
    }

    if (players.length === 0) {
      const empty = document.createElement("div");
      empty.className = "hud-empty";
      empty.textContent = "No one here yet.";
      rosterBody.appendChild(empty);
    }
  }

  function renderEvents(state: UiState): void {
    eventsBody.innerHTML = "";
    const events = [...state.events.values()].sort((a, b) => a.startTime - b.startTime);
    if (events.length === 0) {
      const empty = document.createElement("div");
      empty.className = "hud-empty";
      empty.textContent = "No events right now.";
      eventsBody.appendChild(empty);
      return;
    }
    for (const ev of events) {
      eventsBody.appendChild(renderEventCard(ev, state.selfId));
    }
  }

  function renderEventCard(ev: SocialEvent, selfId: string): HTMLElement {
    const card = document.createElement("div");
    card.className = "event-card";
    card.dataset.type = ev.type;
    const head = document.createElement("div");
    head.className = "event-head";
    const emoji = document.createElement("span");
    emoji.className = "event-emoji";
    emoji.textContent = EVENT_EMOJI[ev.type] ?? "🎉";
    const titleEl = document.createElement("span");
    titleEl.className = "event-title";
    titleEl.textContent = ev.title;
    head.append(emoji, titleEl);

    const meta = document.createElement("div");
    meta.className = "event-meta";
    meta.textContent = `${ev.areaName} · ${timeLeftLabel(ev.endTime)} · ${ev.participantIds.length} joined`;

    // Thin time-remaining progress bar (display only; clamped to 0..1).
    const total = ev.endTime - ev.startTime;
    const remaining = ev.endTime - Date.now();
    const frac = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
    const progress = document.createElement("div");
    progress.className = "event-progress";
    const fill = document.createElement("i");
    fill.style.setProperty("--progress", `${(frac * 100).toFixed(1)}%`);
    progress.appendChild(fill);

    const joined = ev.participantIds.includes(selfId);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = joined ? "event-btn leave" : "event-btn join";
    btn.textContent = joined ? "Leave" : "Join";
    btn.addEventListener("click", () => {
      if (joined) cb.onLeaveEvent(ev.id);
      else cb.onJoinEvent(ev.id);
    });

    card.append(head, meta, progress, btn);
    return card;
  }

  function render(): void {
    const state = store.get();
    const self = store.self();
    areaName.textContent = state.selfArea || "Hallway";
    renderStatusPill(self);
    renderMeeting(state);
    renderRoster(state);
    renderEvents(state);
  }

  // Re-render once per second so event "time left" countdowns tick down.
  const timerId = window.setInterval(render, 1000);

  render();
  return {
    render,
    destroy(): void {
      window.clearInterval(timerId);
      document.removeEventListener("click", onDocClick);
      layer.remove();
    },
  };
}
