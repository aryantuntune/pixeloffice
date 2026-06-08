// Attendance HUD widget: shows live greytHR status and records explicit
// check-in / check-out. Presentation only — it POSTs the user's click and
// renders the server's response. Self-hides when the HR integration is absent.

import { readStoredToken } from "./login";

/** Add the OAuth bearer token when one exists (omitted on the dev path). */
function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  const token = readStoredToken();
  return token ? { ...base, Authorization: `Bearer ${token}` } : { ...base };
}

export interface MountAttendanceOptions {
  /** Base URL of the server REST API, e.g. "http://localhost:2567". */
  fetchBase: string;
  /** Returns the live Colyseus sessionId (resolved server-side to the user). */
  getSessionId(): string;
  /** Injectable fetch for tests; defaults to window.fetch. */
  fetchFn?: typeof fetch;
  /** Status poll interval in ms (0 disables). Defaults to 20000. */
  pollMs?: number;
}

type AttendanceStatus = "NOT_CHECKED_IN" | "CHECKED_IN" | "CHECKED_OUT";

interface AttendanceLocation {
  id: number;
  description: string;
}

interface StatusResponse {
  status: AttendanceStatus;
  lastActionAtMs: number | null;
  lastCheckInMs?: number;
  lastCheckOutMs?: number;
  workLocation?: string;
  shiftName?: string;
  allowLocationSelection?: boolean;
  locations?: AttendanceLocation[];
  workLocationId?: number;
  portalUrl?: string;
}

interface ActionResponse {
  ok: boolean;
  status: AttendanceStatus;
  reason?: string;
}

const STATUS_LABEL: Record<AttendanceStatus, string> = {
  NOT_CHECKED_IN: "Not checked in",
  CHECKED_IN: "Checked in",
  CHECKED_OUT: "Checked out",
};

const STATUS_COLOR: Record<AttendanceStatus, string> = {
  NOT_CHECKED_IN: "#9aa3ad",
  CHECKED_IN: "#3ecf6e",
  CHECKED_OUT: "#e8a13c",
};

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** Format an epoch ms as a local clock time, e.g. "9:45 AM". */
function formatTime(epochMs: number): string {
  try {
    return TIME_FORMAT.format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toLocaleTimeString();
  }
}

/** Format a duration, e.g. "1h 23m 45s". */
function formatDuration(ms: number, withSeconds: boolean): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSec = Math.floor(safe / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  if (withSeconds) parts.push(`${s}s`);
  return parts.join(" ");
}

export interface AttendanceWidgetHandle {
  /** Re-query the server status. */
  refresh(): Promise<void>;
  /** Remove the widget from the DOM. */
  destroy(): void;
}

export function mountAttendance(
  container: HTMLElement,
  opts: MountAttendanceOptions,
): AttendanceWidgetHandle {
  const fetchFn = opts.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = opts.fetchBase.replace(/\/+$/, "");
  const pollMs = opts.pollMs ?? 20000;

  // Remove any widget/overlay left by a prior mount (HMR / reconnect) so modals
  // and overlays never stack.
  container
    .querySelectorAll(".attendance-widget, .attendance-modal-overlay")
    .forEach((el) => el.remove());

  const root = document.createElement("div");
  root.className = "hud-panel attendance-widget";
  root.hidden = true;

  const title = document.createElement("div");
  title.className = "hud-panel-title";
  title.textContent = "Attendance";

  const portalLink = document.createElement("a");
  portalLink.className = "attendance-portal-link";
  portalLink.textContent = "Open greytHR ↗";
  portalLink.target = "_blank";
  portalLink.rel = "noopener noreferrer";
  portalLink.hidden = true;

  const header = document.createElement("div");
  header.className = "attendance-header";
  header.append(title, portalLink);

  const statusRow = document.createElement("div");
  statusRow.className = "attendance-status";

  const dot = document.createElement("span");
  dot.className = "attendance-dot";

  const statusText = document.createElement("span");
  statusText.className = "attendance-status-text";

  statusRow.append(dot, statusText);

  const times = document.createElement("div");
  times.className = "attendance-times";

  const checkInTime = document.createElement("div");
  checkInTime.className = "attendance-time attendance-time-in";
  checkInTime.hidden = true;

  const checkOutTime = document.createElement("div");
  checkOutTime.className = "attendance-time attendance-time-out";
  checkOutTime.hidden = true;

  times.append(checkInTime, checkOutTime);

  const elapsed = document.createElement("div");
  elapsed.className = "attendance-elapsed";
  elapsed.hidden = true;
  elapsed.setAttribute("aria-live", "off");

  const actions = document.createElement("div");
  actions.className = "attendance-actions";

  const checkInBtn = document.createElement("button");
  checkInBtn.type = "button";
  checkInBtn.className = "attendance-btn attendance-check-in";
  checkInBtn.textContent = "Check in";

  const checkOutBtn = document.createElement("button");
  checkOutBtn.type = "button";
  checkOutBtn.className = "attendance-btn attendance-check-out";
  checkOutBtn.textContent = "Check out";

  actions.append(checkInBtn, checkOutBtn);

  const feedback = document.createElement("div");
  feedback.className = "attendance-feedback";
  feedback.setAttribute("aria-live", "polite");

  root.append(header, statusRow, times, elapsed, actions, feedback);
  container.appendChild(root);

  // Location modal (opened on check-in when greytHR offers a choice).
  const overlay = document.createElement("div");
  overlay.className = "attendance-modal-overlay";
  overlay.hidden = true;

  const modal = document.createElement("div");
  modal.className = "attendance-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "Select work location");

  const modalTitle = document.createElement("div");
  modalTitle.className = "attendance-modal-title";
  modalTitle.textContent = "Where are you working?";

  const modalList = document.createElement("div");
  modalList.className = "attendance-modal-list";

  const modalCancel = document.createElement("button");
  modalCancel.type = "button";
  modalCancel.className = "attendance-modal-cancel";
  modalCancel.textContent = "Cancel";

  modal.append(modalTitle, modalList, modalCancel);
  overlay.appendChild(modal);
  container.appendChild(overlay);

  let current: AttendanceStatus = "NOT_CHECKED_IN";
  let busy = false;
  let destroyed = false;
  let feedbackTimer: number | undefined;
  let lastCheckInMs: number | undefined;
  let lastCheckOutMs: number | undefined;
  let workLocation: string | undefined;
  let locations: AttendanceLocation[] = [];
  let allowLocationSelection = false;
  let workLocationId: number | undefined;
  let elapsedTimer: number | undefined;
  let pollTimer: number | undefined;

  function stopTicker(): void {
    if (elapsedTimer !== undefined) {
      window.clearInterval(elapsedTimer);
      elapsedTimer = undefined;
    }
  }

  /** Render the elapsed (while checked in) / worked (after check-out) line. */
  function renderElapsed(): void {
    if (current === "CHECKED_IN" && typeof lastCheckInMs === "number") {
      const since = lastCheckInMs;
      elapsed.textContent = `Elapsed: ${formatDuration(Date.now() - since, true)}`;
      elapsed.hidden = false;
      if (elapsedTimer === undefined) {
        elapsedTimer = window.setInterval(() => {
          if (destroyed || current !== "CHECKED_IN") return;
          elapsed.textContent = `Elapsed: ${formatDuration(Date.now() - since, true)}`;
        }, 1000);
      }
    } else if (
      current === "CHECKED_OUT" &&
      typeof lastCheckInMs === "number" &&
      typeof lastCheckOutMs === "number" &&
      lastCheckOutMs > lastCheckInMs
    ) {
      stopTicker();
      elapsed.textContent = `Worked: ${formatDuration(lastCheckOutMs - lastCheckInMs, false)}`;
      elapsed.hidden = false;
    } else {
      stopTicker();
      elapsed.textContent = "";
      elapsed.hidden = true;
    }
  }

  /** Render the status line and toggle the action buttons off the live status. */
  function render(): void {
    statusText.textContent = workLocation
      ? `${STATUS_LABEL[current]} · ${workLocation}`
      : STATUS_LABEL[current];
    dot.style.background = STATUS_COLOR[current];
    checkInBtn.disabled = busy || current === "CHECKED_IN";
    checkOutBtn.disabled = busy || current !== "CHECKED_IN";
  }

  /** Show the check-in/out time lines (greytHR's clock, formatted locally). */
  function renderTimes(checkInMs?: number, checkOutMs?: number): void {
    const inText = typeof checkInMs === "number" ? formatTime(checkInMs) : undefined;
    const outText = typeof checkOutMs === "number" ? formatTime(checkOutMs) : undefined;
    checkInTime.textContent = inText ?? "";
    checkInTime.hidden = !inText;
    checkOutTime.textContent = outText ?? "";
    checkOutTime.hidden = !outText;
    times.hidden = checkInTime.hidden && checkOutTime.hidden;
  }

  function showFeedback(message: string, kind: "ok" | "error"): void {
    feedback.textContent = message;
    feedback.dataset.kind = kind;
    if (feedbackTimer) window.clearTimeout(feedbackTimer);
    feedbackTimer = window.setTimeout(() => {
      if (!destroyed) feedback.textContent = "";
    }, 4000);
  }

  function closeModal(): void {
    overlay.hidden = true;
    modalList.replaceChildren();
  }

  /** Open the location modal; resolves the chosen work-location id on confirm. */
  function openLocationModal(): void {
    if (current === "CHECKED_IN" || locations.length === 0) return;
    modalList.replaceChildren();
    const preferredId =
      workLocationId ?? locations.find((l) => /office/i.test(l.description))?.id ?? locations[0]?.id;
    for (const loc of locations) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "attendance-loc-option";
      if (loc.id === preferredId) btn.classList.add("is-preferred");
      btn.textContent = loc.description;
      btn.addEventListener("click", () => {
        closeModal();
        void act("check-in", loc.id);
      });
      modalList.appendChild(btn);
    }
    overlay.hidden = false;
    const focusTarget =
      modalList.querySelector<HTMLButtonElement>(".is-preferred") ??
      (modalList.firstElementChild as HTMLButtonElement | null);
    focusTarget?.focus();
  }

  async function refresh(): Promise<void> {
    const sessionId = opts.getSessionId();
    if (!sessionId) {
      stopTicker();
      root.hidden = true;
      return;
    }
    try {
      const res = await fetchFn(
        `${base}/api/hr/status?sessionId=${encodeURIComponent(sessionId)}`,
        { headers: authHeaders() },
      );
      if (res.status === 404 || !res.ok) {
        stopTicker();
        root.hidden = true;
        return;
      }
      const data = (await res.json()) as StatusResponse;
      current = data.status;
      lastCheckInMs = data.lastCheckInMs;
      lastCheckOutMs = data.lastCheckOutMs;
      workLocation = data.workLocation;
      locations = Array.isArray(data.locations) ? data.locations : [];
      allowLocationSelection = data.allowLocationSelection === true;
      workLocationId = data.workLocationId;
      renderTimes(lastCheckInMs, lastCheckOutMs);
      renderElapsed();
      if (data.portalUrl) {
        portalLink.href = data.portalUrl;
        portalLink.hidden = false;
      } else {
        portalLink.removeAttribute("href");
        portalLink.hidden = true;
      }
      root.hidden = false;
      // Once signed in, no location is needed — never leave the modal open.
      if (current === "CHECKED_IN" && !overlay.hidden) closeModal();
      render();
    } catch {
      root.hidden = true;
    }
  }

  /** Submit a check-in/out; `attLocation` is the greytHR work-location id. */
  async function act(kind: "check-in" | "check-out", attLocation?: number): Promise<void> {
    if (busy || destroyed) return;
    const sessionId = opts.getSessionId();
    if (!sessionId) return;
    const body: Record<string, unknown> = { sessionId };
    if (kind === "check-in" && typeof attLocation === "number") body.attLocation = attLocation;
    busy = true;
    render();
    try {
      const res = await fetchFn(`${base}/api/hr/${kind}`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as ActionResponse | null;
      if (res.ok && data?.ok) {
        current = data.status;
        if (kind === "check-in") lastCheckInMs = Date.now();
        else lastCheckOutMs = Date.now();
        showFeedback(kind === "check-in" ? "Checked in." : "Checked out.", "ok");
        void refresh();
      } else {
        showFeedback(data?.reason ?? "HR action failed. Try again later.", "error");
      }
    } catch {
      showFeedback("HR unavailable. The office still works.", "error");
    } finally {
      busy = false;
      render();
    }
  }

  /** Check-in entry point: prompt for a location when greytHR offers a choice. */
  function startCheckIn(): void {
    if (busy || destroyed || current === "CHECKED_IN") return;
    if (allowLocationSelection && locations.length > 0) openLocationModal();
    else void act("check-in");
  }

  checkInBtn.addEventListener("click", startCheckIn);
  checkOutBtn.addEventListener("click", () => void act("check-out"));
  modalCancel.addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && !overlay.hidden) closeModal();
  };
  window.addEventListener("keydown", onKeydown);

  render();
  void refresh();
  if (pollMs > 0) {
    pollTimer = window.setInterval(() => {
      if (!destroyed && !busy && overlay.hidden) void refresh();
    }, pollMs);
  }

  return {
    refresh,
    destroy(): void {
      destroyed = true;
      if (feedbackTimer) window.clearTimeout(feedbackTimer);
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      window.removeEventListener("keydown", onKeydown);
      stopTicker();
      overlay.remove();
      root.remove();
    },
  };
}
