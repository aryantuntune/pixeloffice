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
  /** False when the greytHR session expired/was wiped and a reconnect is needed. */
  greythrConnected?: boolean;
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

  // Proactive reconnect banner: shown when the status poll detects that the
  // greytHR session has expired, so the user reconnects in one click BEFORE
  // ever clicking a dead check-in/out. Hidden while connected.
  const reconnectBanner = document.createElement("div");
  reconnectBanner.className = "attendance-reconnect-banner";
  reconnectBanner.hidden = true;

  const reconnectBannerText = document.createElement("span");
  reconnectBannerText.className = "attendance-reconnect-banner-text";
  reconnectBannerText.textContent = "greytHR session expired.";

  const reconnectBannerBtn = document.createElement("button");
  reconnectBannerBtn.type = "button";
  reconnectBannerBtn.className = "attendance-reconnect-banner-btn";
  reconnectBannerBtn.textContent = "Reconnect";

  reconnectBanner.append(reconnectBannerText, reconnectBannerBtn);

  root.append(header, statusRow, times, elapsed, reconnectBanner, actions, feedback);
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

  // Reconnect modal (opened when greytHR's session has expired). Lets the user
  // re-enter ONLY their greytHR password and stay in the office — no logout.
  const reconnectOverlay = document.createElement("div");
  reconnectOverlay.className = "attendance-modal-overlay attendance-reconnect-overlay";
  reconnectOverlay.hidden = true;

  const reconnectModal = document.createElement("div");
  reconnectModal.className = "attendance-modal attendance-reconnect-modal";
  reconnectModal.setAttribute("role", "dialog");
  reconnectModal.setAttribute("aria-modal", "true");
  reconnectModal.setAttribute("aria-label", "Reconnect greytHR");

  const reconnectTitle = document.createElement("div");
  reconnectTitle.className = "attendance-modal-title";
  reconnectTitle.textContent = "Reconnect greytHR";

  const reconnectDesc = document.createElement("div");
  reconnectDesc.className = "attendance-reconnect-desc";
  reconnectDesc.textContent =
    "Your greytHR session expired. Enter your greytHR password to reconnect — you'll stay in the office.";

  const reconnectForm = document.createElement("form");
  reconnectForm.className = "attendance-reconnect-form";

  const reconnectInput = document.createElement("input");
  reconnectInput.type = "password";
  reconnectInput.className = "attendance-reconnect-input";
  reconnectInput.placeholder = "greytHR password";
  reconnectInput.autocomplete = "current-password";
  reconnectInput.setAttribute("aria-label", "greytHR password");

  const reconnectError = document.createElement("div");
  reconnectError.className = "attendance-reconnect-error";
  reconnectError.setAttribute("aria-live", "polite");

  const reconnectButtons = document.createElement("div");
  reconnectButtons.className = "attendance-reconnect-buttons";

  const reconnectSubmit = document.createElement("button");
  reconnectSubmit.type = "submit";
  reconnectSubmit.className = "attendance-btn attendance-reconnect-submit";
  reconnectSubmit.textContent = "Reconnect";

  const reconnectCancel = document.createElement("button");
  reconnectCancel.type = "button";
  reconnectCancel.className = "attendance-modal-cancel attendance-reconnect-cancel";
  reconnectCancel.textContent = "Cancel";

  reconnectButtons.append(reconnectSubmit, reconnectCancel);
  reconnectForm.append(reconnectInput, reconnectError, reconnectButtons);
  reconnectModal.append(reconnectTitle, reconnectDesc, reconnectForm);
  reconnectOverlay.appendChild(reconnectModal);
  container.appendChild(reconnectOverlay);

  let current: AttendanceStatus = "NOT_CHECKED_IN";
  let busy = false;
  let destroyed = false;
  let feedbackTimer: number | undefined;
  // Checkout misclick guard: the button must be "armed" by a first click before
  // a second click commits, so a stray click never checks the user out.
  let checkoutArmed = false;
  let armTimer: number | undefined;
  // The action to retry after a successful reconnect (set when a swipe fails
  // because the greytHR session had expired).
  let pendingAction: { kind: "check-in" | "check-out"; attLocation?: number } | null = null;
  let reconnectBusy = false;
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
    // Check-out is a two-step confirm to prevent misclicks: the first click arms
    // it ("Confirm check out"), the second commits. Only meaningful while checked
    // in; disarm whenever the button can't act.
    if (current !== "CHECKED_IN" && checkoutArmed) {
      checkoutArmed = false;
      if (armTimer !== undefined) {
        window.clearTimeout(armTimer);
        armTimer = undefined;
      }
    }
    checkOutBtn.textContent = checkoutArmed ? "Confirm check out" : "Check out";
    checkOutBtn.classList.toggle("is-armed", checkoutArmed);
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

  /** Arm/disarm the check-out confirmation. Auto-disarms after a short window. */
  function setCheckoutArmed(armed: boolean): void {
    checkoutArmed = armed;
    if (armTimer !== undefined) {
      window.clearTimeout(armTimer);
      armTimer = undefined;
    }
    if (armed) {
      armTimer = window.setTimeout(() => {
        if (!destroyed) {
          checkoutArmed = false;
          render();
        }
      }, 4000);
    }
    render();
  }

  /** True when an HR failure reason indicates the greytHR session is gone. */
  function looksLikeSessionLoss(reason: string): boolean {
    return /sign in with greythr|session expired|sign in again/i.test(reason);
  }

  function closeReconnect(): void {
    reconnectOverlay.hidden = true;
    reconnectInput.value = "";
    reconnectError.textContent = "";
  }

  /** Open the reconnect modal (only meaningful when we hold an office token). */
  function openReconnect(reason?: string): void {
    if (!readStoredToken()) {
      // No office JWT (dev path without greytHR login) — nothing to reconnect.
      if (reason) showFeedback(reason, "error");
      return;
    }
    reconnectError.textContent = "";
    reconnectOverlay.hidden = false;
    window.setTimeout(() => reconnectInput.focus(), 0);
  }

  async function submitReconnect(): Promise<void> {
    if (reconnectBusy || destroyed) return;
    const password = reconnectInput.value;
    if (!password) {
      reconnectError.textContent = "Password is required.";
      reconnectInput.focus();
      return;
    }
    reconnectBusy = true;
    reconnectSubmit.disabled = true;
    reconnectError.textContent = "";
    try {
      const res = await fetchFn(`${base}/api/auth/greythr/reconnect`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ password }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (res.ok && data?.ok) {
        closeReconnect();
        showFeedback("Reconnected to greytHR.", "ok");
        await refresh();
        // Resume the action the user originally clicked, now that we have a session.
        if (pendingAction) {
          const next = pendingAction;
          pendingAction = null;
          void act(next.kind, next.attLocation);
        }
      } else {
        reconnectError.textContent =
          data?.error ?? "Reconnect failed. Check your password and try again.";
      }
    } catch {
      reconnectError.textContent = "Could not reach the server. Try again.";
    } finally {
      reconnectBusy = false;
      reconnectSubmit.disabled = false;
    }
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
      // Surface (or clear) the proactive reconnect banner from the live signal.
      // Only present for greytHR identities; undefined leaves the banner hidden.
      if (data.greythrConnected === false) {
        reconnectBanner.hidden = false;
      } else {
        reconnectBanner.hidden = true;
        // A live session means any stale pending action is no longer blocked.
        if (data.greythrConnected === true && reconnectOverlay.hidden) pendingAction = null;
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
        const reason = data?.reason ?? "HR action failed. Try again later.";
        // If the greytHR session expired, offer in-place reconnect (and retry the
        // same action afterward) instead of forcing a full office logout/login.
        if (looksLikeSessionLoss(reason) && readStoredToken()) {
          pendingAction = { kind, attLocation };
          showFeedback("greytHR session expired — reconnect to continue.", "error");
          openReconnect();
        } else {
          showFeedback(reason, "error");
        }
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

  checkInBtn.addEventListener("click", () => {
    if (checkoutArmed) setCheckoutArmed(false);
    startCheckIn();
  });
  checkOutBtn.addEventListener("click", () => {
    if (busy || destroyed || current !== "CHECKED_IN") return;
    // First click arms; second click within the window commits.
    if (!checkoutArmed) {
      setCheckoutArmed(true);
      return;
    }
    setCheckoutArmed(false);
    void act("check-out");
  });
  modalCancel.addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });
  reconnectForm.addEventListener("submit", (e) => {
    e.preventDefault();
    void submitReconnect();
  });
  reconnectBannerBtn.addEventListener("click", () => openReconnect());
  reconnectCancel.addEventListener("click", () => {
    pendingAction = null;
    closeReconnect();
  });
  reconnectOverlay.addEventListener("click", (e) => {
    if (e.target === reconnectOverlay) {
      pendingAction = null;
      closeReconnect();
    }
  });
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    if (!reconnectOverlay.hidden) {
      pendingAction = null;
      closeReconnect();
    } else if (!overlay.hidden) {
      closeModal();
    } else if (checkoutArmed) {
      setCheckoutArmed(false);
    }
  };
  window.addEventListener("keydown", onKeydown);

  render();
  void refresh();
  if (pollMs > 0) {
    pollTimer = window.setInterval(() => {
      if (!destroyed && !busy && overlay.hidden && reconnectOverlay.hidden) void refresh();
    }, pollMs);
  }

  return {
    refresh,
    destroy(): void {
      destroyed = true;
      if (feedbackTimer) window.clearTimeout(feedbackTimer);
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      if (armTimer !== undefined) window.clearTimeout(armTimer);
      window.removeEventListener("keydown", onKeydown);
      stopTicker();
      overlay.remove();
      reconnectOverlay.remove();
      root.remove();
    },
  };
}
