// ---------------------------------------------------------------------------
// The DOM HUD overlay. Renders entirely from the Store (server-pushed facts):
// top bar (logo, current area, status pill + dropdown, Join Meeting button),
// right roster grouped by presence, "Happening now" events panel, and the
// bottom-left chat input. It NEVER computes presence — it displays pushed state.
// User actions (set status, join/leave event, join meeting, chat) are explicit
// and forwarded through callbacks (human-agency rule: no auto-actions).
// ---------------------------------------------------------------------------

import {
  type MeetingInfo,
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
import { mountGameOverlay, type GameOverlayHandle } from "./games";

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

/**
 * Build the OPT-IN physical-location pill for a player, or `null` when the player
 * has not enabled floor sync (absent `place` => render nothing — never a "Remote"
 * default; that would be surveillance-by-omission). `floorLabel` is appended for
 * an OFFICE tag when known (e.g. "📍 Office · Floor 2"). Display-only: it mirrors
 * the server-pushed tag and never derives presence from it (orthogonal).
 */
function placePill(place: PlayerSnapshot["place"], floorLabel?: string): HTMLElement | null {
  if (place !== "OFFICE" && place !== "REMOTE") return null;
  const pill = document.createElement("span");
  pill.className = "place-pill";
  pill.dataset.place = place;
  if (place === "OFFICE") {
    pill.textContent = floorLabel ? `📍 Office · ${floorLabel}` : "📍 Office";
    pill.title = "Synced to your office network (you can turn this off in Settings)";
  } else {
    pill.textContent = "🏠 Remote";
    pill.title = "Working remotely";
  }
  return pill;
}

function timeLeftLabel(endTime: number): string {
  const ms = endTime - Date.now();
  if (ms <= 0) return "ending…";
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  if (mins > 0) return `${mins}m ${secs}s left`;
  return `${secs}s left`;
}

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

function timeLabel(epochMs: number): string {
  return TIME_FMT.format(new Date(epochMs));
}

function durationLabel(startTime: number, endTime: number): string {
  const mins = Math.max(1, Math.round((endTime - startTime) / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
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
  onLeaveGame(gameId: string): void;
  onGameInput(gameId: string, input: any): void;
  /**
   * Pool only: (re)join a game with an explicit mode. Used by the pool entry
   * chooser to switch a freshly-joined GROUP seat into a SOLO-vs-AI game (the
   * overlay leaves the group seat, then rejoins with mode:"ai"). Forwarded to
   * C2S.JOIN_GAME with the mode. Other games never call this. Optional/back-compat.
   */
  onJoinGame?(gameId: string, mode: "ai" | "group"): void;
  onLocate?(sessionId: string): void;
  onOpenProfile?(sessionId: string): void;
  isNpcHidden?(): boolean;
  /**
   * Optional: pan the CAMERA toward the nearest elevator/portal on the current
   * floor (a hint affordance, NOT a teleport — human-agency rule: it must never
   * move the player's avatar). The floor indicator's "locate elevator" button
   * calls this. No-op / button hidden if the integrator does not wire it.
   */
  onLocateElevator?(): void;
}

export interface HudHandle {
  /** Render once from the current store snapshot (called on every change). */
  render(): void;
  /** Briefly flash a roster row (used by Locate so the user sees who they
   *  panned to). No-op if the row is not currently rendered. */
  flashRow(sessionId: string): void;
  /** The DOM node hosting the chat input — emote buttons dock beside it. */
  chatBar(): HTMLElement;
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

  // --- Game Prompt ---------------------------------------------------------
  const promptEl = document.createElement("div");
  promptEl.className = "hud-interact-prompt";
  promptEl.style.display = "none";
  layer.appendChild(promptEl);

  // --- Game Overlay Container ----------------------------------------------
  const gameOverlayContainer = document.createElement("div");
  gameOverlayContainer.className = "hud-game-overlay-container";
  layer.appendChild(gameOverlayContainer);

  // --- Top bar -------------------------------------------------------------
  const topBar = document.createElement("div");
  topBar.className = "hud-topbar";

  const logo = document.createElement("div");
  logo.className = "hud-logo";
  logo.textContent = "PixelOffice";

  const areaName = document.createElement("div");
  areaName.className = "hud-area";

  // --- Floor indicator / switcher ------------------------------------------
  // Display-only: shows the building's floors (from welcome.building) with the
  // current floor highlighted (self.floorId). It is NOT a teleport — the user
  // changes floors by walking their avatar into an elevator (human-agency rule).
  // The optional "locate elevator" button only nudges the CAMERA. The whole
  // widget self-hides when the server is pre-multifloor (no building / one floor).
  const floorWidget = document.createElement("div");
  floorWidget.className = "hud-floor";
  floorWidget.hidden = true;

  const floorButton = document.createElement("button");
  floorButton.type = "button";
  floorButton.className = "hud-floor-btn";
  floorButton.setAttribute("aria-haspopup", "true");
  floorButton.setAttribute("aria-expanded", "false");

  const floorMenu = document.createElement("div");
  floorMenu.className = "hud-floor-menu";
  floorMenu.hidden = true;

  floorButton.addEventListener("click", () => {
    const open = floorMenu.hidden;
    floorMenu.hidden = !open;
    floorButton.setAttribute("aria-expanded", open ? "true" : "false");
  });
  const onFloorDocClick = (e: MouseEvent): void => {
    if (!floorWidget.contains(e.target as Node)) {
      floorMenu.hidden = true;
      floorButton.setAttribute("aria-expanded", "false");
    }
  };
  document.addEventListener("click", onFloorDocClick);
  floorWidget.append(floorButton, floorMenu);

  // --- Self location pill (OPT-IN floor sync) ------------------------------
  // A compact, dismissible Office/Remote indicator for SELF, docked beside the
  // floor indicator. Hidden when the user has not enabled floor sync (absent
  // place). Display-only; the toggle lives in Settings (honest + revocable).
  const selfPlace = document.createElement("div");
  selfPlace.className = "hud-self-place";
  selfPlace.hidden = true;

  // Status pill + dropdown
  const statusWrap = document.createElement("div");
  statusWrap.className = "hud-status";
  const statusPill = document.createElement("button");
  statusPill.type = "button";
  statusPill.className = "hud-status-pill";
  const statusMenu = document.createElement("div");
  statusMenu.className = "hud-status-menu";
  statusMenu.hidden = true;
  const statusNote = document.createElement("div");
  statusNote.className = "hud-status-note";
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
  statusMenu.appendChild(statusNote);
  statusPill.addEventListener("click", () => {
    statusMenu.hidden = !statusMenu.hidden;
  });
  const onDocClick = (e: MouseEvent): void => {
    if (!statusWrap.contains(e.target as Node)) statusMenu.hidden = true;
  };
  document.addEventListener("click", onDocClick);
  statusWrap.append(statusPill, statusMenu);

  // Join Meeting button (only visible when invited; agency rule). Clicking it
  // seats the avatar in the in-office meeting room (existing behavior).
  const meetingBtn = document.createElement("button");
  meetingBtn.type = "button";
  meetingBtn.className = "hud-meeting-btn";
  meetingBtn.hidden = true;

  // "Open Meet" anchor — a DISTINCT, explicit affordance that opens the external
  // Google Meet call in a new tab. Shown only when the meeting payload carries a
  // meetLink. Separate from the room-join button: one seats your avatar, this one
  // opens the call. Both are explicit clicks (human-agency rule; never auto-open).
  const meetLinkAnchor = document.createElement("a");
  meetLinkAnchor.className = "hud-meet-link";
  meetLinkAnchor.target = "_blank";
  meetLinkAnchor.rel = "noopener noreferrer";
  meetLinkAnchor.textContent = "🎥 Open Meet";
  meetLinkAnchor.hidden = true;

  topBar.append(logo, areaName, floorWidget, selfPlace, statusWrap, meetingBtn, meetLinkAnchor);

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

  const meetingsPanel = document.createElement("div");
  meetingsPanel.className = "hud-panel hud-meetings";
  const meetingsTitle = document.createElement("h2");
  meetingsTitle.className = "hud-panel-title";
  meetingsTitle.textContent = "Meetings";
  const meetingsBody = document.createElement("div");
  meetingsBody.className = "hud-panel-body";
  meetingsPanel.append(meetingsTitle, meetingsBody);

  const eventsPanel = document.createElement("div");
  eventsPanel.className = "hud-panel hud-events";
  const eventsTitle = document.createElement("h2");
  eventsTitle.className = "hud-panel-title";
  eventsTitle.textContent = "Happening now";
  const eventsBody = document.createElement("div");
  eventsBody.className = "hud-panel-body";
  eventsPanel.append(eventsTitle, eventsBody);

  // --- Lounge games launcher -----------------------------------------------
  // A robust SECONDARY entry point to the lounge games (the PRIMARY one is the
  // walk-up [E] prompt). It sends the same JOIN_GAME the prompt does, so a
  // single proximity/coordinate regression can never make the games
  // unreachable. The server seats the player regardless of avatar position;
  // pool opens its vs-friend / vs-Bot chooser exactly like a walk-up join.
  const gamesPanel = document.createElement("div");
  gamesPanel.className = "hud-panel hud-games-launcher";
  const gamesTitle = document.createElement("h2");
  gamesTitle.className = "hud-panel-title";
  gamesTitle.textContent = "Lounge games";
  const gamesBody = document.createElement("div");
  gamesBody.className = "hud-panel-body hud-games-grid";
  const LOUNGE_GAMES: { gameId: string; label: string; emoji: string }[] = [
    { gameId: "lounge:pool", label: "Pool", emoji: "🎱" },
    { gameId: "lounge:ping-pong", label: "Table Tennis", emoji: "🏓" },
    { gameId: "lounge:connect-four", label: "Connect Four", emoji: "🔴" },
    { gameId: "lounge:tic-tac-toe", label: "Tic-Tac-Toe", emoji: "⭕" },
  ];
  for (const g of LOUNGE_GAMES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "hud-game-launch-btn";
    b.innerHTML = `<span class="hud-game-emoji">${g.emoji}</span><span>${g.label}</span>`;
    b.title = `Play ${g.label}`;
    b.addEventListener("click", () => cb.onJoinGame?.(g.gameId, "group"));
    gamesBody.appendChild(b);
  }
  gamesPanel.append(gamesTitle, gamesBody);

  sidebar.append(rosterPanel, meetingsPanel, gamesPanel, eventsPanel);

  // --- Narrow-viewport sidebar drawer toggle -------------------------------
  // On phone/narrow widths the fixed 264px sidebar would cover the canvas, the
  // top-left controls and the chat bar. There, CSS turns the sidebar into an
  // off-canvas drawer that defaults to collapsed; this FAB (shown only at narrow
  // widths via CSS) slides it in/out so the play area + chat stay usable. The
  // button is harmless/hidden on desktop. No business logic — pure UI affordance.
  const sidebarToggle = document.createElement("button");
  sidebarToggle.type = "button";
  sidebarToggle.className = "hud-sidebar-toggle";
  sidebarToggle.setAttribute("aria-controls", "hud-sidebar");
  sidebarToggle.setAttribute("aria-expanded", "false");
  sidebarToggle.setAttribute("aria-label", "Toggle team & events panel");
  sidebarToggle.textContent = "👥";
  sidebar.id = "hud-sidebar";
  sidebar.classList.add("collapsed");
  sidebarToggle.addEventListener("click", () => {
    const open = sidebar.classList.toggle("collapsed") === false;
    sidebarToggle.setAttribute("aria-expanded", open ? "true" : "false");
  });

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

  layer.append(topBar, sidebar, sidebarToggle, chatBar);

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
    if (self?.source === "CALENDAR") {
      statusNote.hidden = false;
      statusNote.textContent = "Calendar meeting is controlling your status. Manual choices apply after it ends.";
    } else if (self?.source === "EVENT") {
      statusNote.hidden = false;
      statusNote.textContent = "This status comes from an event you joined.";
    } else {
      statusNote.hidden = true;
      statusNote.textContent = "";
    }
  }

  function renderMeetingDetails(m: MeetingInfo | null): void {
    meetingsBody.innerHTML = "";
    if (!m) {
      const empty = document.createElement("div");
      empty.className = "hud-empty";
      empty.textContent = "No active meeting.";
      meetingsBody.appendChild(empty);
      return;
    }

    const card = document.createElement("div");
    card.className = "meeting-card";
    const title = document.createElement("div");
    title.className = "meeting-title";
    title.textContent = m.title;
    const details = document.createElement("div");
    details.className = "meeting-details";
    details.append(
      detailRow("Start", timeLabel(m.startTime)),
      detailRow("Duration", durationLabel(m.startTime, m.endTime)),
      detailRow("Room", m.roomName),
      detailRow("Invitees", m.participantIds.length === 0 ? "Everyone" : `${m.participantIds.length}`),
    );
    card.append(title, details);
    meetingsBody.appendChild(card);
  }

  function detailRow(label: string, value: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "meeting-detail";
    const k = document.createElement("span");
    k.textContent = label;
    const v = document.createElement("strong");
    v.textContent = value;
    row.append(k, v);
    return row;
  }

  function renderMeeting(state: UiState): void {
    const m = state.myMeeting;
    if (!m) {
      meetingBtn.hidden = true;
      meetingBtn.onclick = null;
      meetLinkAnchor.hidden = true;
      meetLinkAnchor.removeAttribute("href");
      return;
    }

    // Optional Meet link (server populates MeetingInfo.meetLink from the calendar
    // event's hangoutLink). Coded optimistically with optional access so this
    // compiles before the shared `meetLink?: string` field lands. Render the
    // external-call anchor only when a usable link is present.
    const meetLink = (m as { meetLink?: string }).meetLink;
    if (meetLink) {
      meetLinkAnchor.href = meetLink;
      meetLinkAnchor.hidden = false;
    } else {
      meetLinkAnchor.removeAttribute("href");
      meetLinkAnchor.hidden = true;
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

  /** Short floor badge ("G" for ground, else the index) for compact labels. */
  function floorBadgeText(index: number): string {
    return index <= 0 ? "G" : String(index);
  }

  /** Resolve a floor's display name from the building summary (or a fallback). */
  function floorNameFor(state: UiState, floorId: string): string {
    const f = state.building?.floors.find((fl) => fl.id === floorId);
    if (f) return f.name;
    if (floorId === "ground") return "Ground Floor";
    return floorId;
  }

  function renderFloorWidget(state: UiState): void {
    const building = state.building;
    const currentId = store.selfFloorId();
    const floors = building?.floors ? [...building.floors].sort((a, b) => a.index - b.index) : [];

    // Hide the whole widget on a single-floor / pre-multifloor server — there is
    // nothing meaningful to show or switch between.
    if (floors.length <= 1) {
      floorWidget.hidden = true;
      floorMenu.hidden = true;
      return;
    }
    floorWidget.hidden = false;

    const current = floors.find((f) => f.id === currentId);
    const currentIndex = current?.index ?? 0;

    floorButton.innerHTML = "";
    const icon = document.createElement("span");
    icon.className = "hud-floor-icon";
    icon.textContent = "🏢";
    const badge = document.createElement("span");
    badge.className = "hud-floor-badge";
    badge.textContent = floorBadgeText(currentIndex);
    const label = document.createElement("span");
    label.className = "hud-floor-label";
    label.textContent = current?.name ?? floorNameFor(state, currentId);
    const caret = document.createElement("span");
    caret.className = "hud-caret";
    caret.textContent = "▾";
    floorButton.append(icon, badge, label, caret);
    floorButton.setAttribute(
      "aria-label",
      `Current floor: ${current?.name ?? currentId}. Walk into an elevator to change floors.`,
    );

    // The menu lists every floor (top floor first so it reads like a lift panel),
    // marking the current one. Rows are DISPLAY ONLY — they never move the avatar.
    floorMenu.innerHTML = "";
    for (const f of [...floors].reverse()) {
      const row = document.createElement("div");
      row.className = "hud-floor-item";
      if (f.id === currentId) row.classList.add("current");
      const fb = document.createElement("span");
      fb.className = "hud-floor-badge";
      fb.textContent = floorBadgeText(f.index);
      const fn = document.createElement("span");
      fn.className = "hud-floor-item-name";
      fn.textContent = f.name;
      row.append(fb, fn);
      if (f.id === currentId) {
        const here = document.createElement("span");
        here.className = "hud-floor-here";
        here.textContent = "You are here";
        row.appendChild(here);
      }
      floorMenu.appendChild(row);
    }

    const note = document.createElement("div");
    note.className = "hud-floor-note";
    note.textContent = "Walk into an elevator to change floors.";
    floorMenu.appendChild(note);

    // Optional camera-only "locate elevator" affordance (never moves the avatar).
    if (cb.onLocateElevator) {
      const locateBtn = document.createElement("button");
      locateBtn.type = "button";
      locateBtn.className = "hud-floor-locate";
      locateBtn.textContent = "🧭 Find the elevator";
      locateBtn.addEventListener("click", () => {
        floorMenu.hidden = true;
        floorButton.setAttribute("aria-expanded", "false");
        cb.onLocateElevator?.();
      });
      floorMenu.appendChild(locateBtn);
    }
  }

  /** Render the SELF Office/Remote indicator in the top bar (hidden if absent). */
  function renderSelfPlace(state: UiState): void {
    const self = store.self();
    const place = self?.place;
    if (place !== "OFFICE" && place !== "REMOTE") {
      selfPlace.hidden = true;
      selfPlace.innerHTML = "";
      return;
    }
    // Resolve "Floor N" from self's floor for an OFFICE tag.
    const floorLabel =
      place === "OFFICE" ? floorNameFor(state, store.selfFloorId()) : undefined;
    const pill = placePill(place, floorLabel);
    selfPlace.innerHTML = "";
    if (pill) {
      selfPlace.appendChild(pill);
      selfPlace.hidden = false;
    } else {
      selfPlace.hidden = true;
    }
  }

  function renderRoster(state: UiState): void {
    rosterBody.innerHTML = "";
    const hideNpcs = cb.isNpcHidden?.() ?? false;
    // Filter ambient NPCs out of the roster when "hide bots" is on (display-only;
    // the player still exists server-side — we just don't list them).
    const players = [...state.players.values()].filter((p) => !(p.isNpc && hideNpcs));
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
        row.dataset.session = p.sessionId;
        // Mark ambient NPCs so the stylesheet can dim them (display-only; NPCs
        // render identically in-game). Backward-compatible: humans have no flag.
        if (p.isNpc) row.dataset.npc = "true";
        // Clicking the row (anywhere but the ⓘ) locates the player: pans the
        // CAMERA to them (never moves an avatar — human-agency rule).
        row.addEventListener("click", () => cb.onLocate?.(p.sessionId));
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
        // Per-row floor label — shown only in a multifloor building, and only
        // when the player is on a DIFFERENT floor than the viewer (the server
        // floor-scopes the roster, so usually everyone shares one floor; this is
        // a robust readout for any cross-floor entries). Display-only.
        const pFloor = p.floorId ?? "ground";
        const selfFloor = store.selfFloorId();
        const floorCount = state.building?.floors.length ?? 0;
        if (floorCount > 1 && pFloor !== selfFloor) {
          const floorTag = document.createElement("span");
          floorTag.className = "roster-floor";
          const idx =
            state.building?.floors.find((f) => f.id === pFloor)?.index ?? 0;
          floorTag.textContent = `· ${floorBadgeText(idx)}`;
          floorTag.title = floorNameFor(state, pFloor);
          sub.append(floorTag);
        }
        // OPT-IN physical-location pill (Office/Remote). Absent => render nothing.
        // For an OFFICE tag, label the player's floor when the building is known.
        const floorCountForPlace = state.building?.floors.length ?? 0;
        const placeFloorLabel =
          p.place === "OFFICE" && floorCountForPlace > 1
            ? floorNameFor(state, pFloor)
            : undefined;
        const pill = placePill(p.place, placeFloorLabel);
        if (pill) sub.append(pill);
        info.append(nameEl, sub);
        // ⓘ affordance opens the profile card (distinct from row-click = locate).
        const infoBtn = document.createElement("button");
        infoBtn.type = "button";
        infoBtn.className = "roster-info-btn";
        infoBtn.textContent = "ⓘ";
        infoBtn.setAttribute("aria-label", `Open ${p.name}'s profile`);
        infoBtn.addEventListener("click", (e) => {
          e.stopPropagation(); // don't also trigger the row's locate handler
          cb.onOpenProfile?.(p.sessionId);
        });
        row.append(dot, info, infoBtn);
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

  let gameOverlay: GameOverlayHandle | null = null;

  function renderGameOverlay(state: UiState): void {
    const activeId = state.activeGameId;
    if (!activeId) {
      if (gameOverlay) {
        gameOverlay.destroy();
        gameOverlay = null;
        cb.onChatFocus?.(false);
      }
      return;
    }

    const game = state.activeGames.get(activeId);
    if (!game) return;

    if (!gameOverlay) {
      cb.onChatFocus?.(true);
      gameOverlay = mountGameOverlay(gameOverlayContainer, store, cb);
    }
    gameOverlay.render(game);
  }

  function render(): void {
    const state = store.get();
    const self = store.self();
    areaName.textContent = state.selfArea || "Hallway";
    renderFloorWidget(state);
    renderSelfPlace(state);
    renderStatusPill(self);
    renderMeeting(state);
    renderMeetingDetails(state.myMeeting);
    renderRoster(state);
    renderEvents(state);

    if (state.interactPrompt) {
      promptEl.textContent = state.interactPrompt;
      promptEl.style.display = "block";
    } else {
      promptEl.style.display = "none";
    }

    renderGameOverlay(state);
  }

  // Re-render once per second so event "time left" countdowns tick down.
  const timerId = window.setInterval(render, 1000);

  render();
  return {
    render,
    flashRow(sessionId: string): void {
      const row = rosterBody.querySelector<HTMLElement>(
        `.roster-row[data-session="${CSS.escape(sessionId)}"]`,
      );
      if (!row) return;
      row.classList.remove("locate-flash");
      void row.offsetWidth; // restart the animation
      row.classList.add("locate-flash");
      window.setTimeout(() => row.classList.remove("locate-flash"), 1200);
    },
    chatBar(): HTMLElement {
      return chatBar;
    },
    destroy(): void {
      window.clearInterval(timerId);
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("click", onFloorDocClick);
      if (gameOverlay) {
        gameOverlay.destroy();
        gameOverlay = null;
      }
      layer.remove();
    },
  };
}
