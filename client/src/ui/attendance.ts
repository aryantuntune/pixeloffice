// ---------------------------------------------------------------------------
// Attendance HUD widget (GreytHR integration, presentation only).
//
// Self-contained: mountAttendance(container, opts) renders a small card showing
// the user's current attendance status with explicit "Check in" / "Check out"
// buttons. It contains NO business logic — it only POSTs the user's explicit
// click and renders the server's response (plan: no third-party logic in UI
// components; human agency: attendance is always an explicit click).
//
// OPTIONAL INTEGRATION (plan Principle 4): if GET /api/hr/status 404s or errors
// (HR integration absent / server without the HR routes mounted), the widget
// hides itself entirely. The office keeps working with no HR present.
// ---------------------------------------------------------------------------

import { readStoredToken } from "./login";

/** Attach the OAuth bearer token when one exists so HR actions/status work under
 *  AUTH_REQUIRED (requireAuth rejects token-less requests with 401). On the dev
 *  path no token exists and the header is omitted. Mirrors admin.ts. */
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
}

type AttendanceStatus = "NOT_CHECKED_IN" | "CHECKED_IN" | "CHECKED_OUT";

interface StatusResponse {
  status: AttendanceStatus;
  lastActionAtMs: number | null;
  /** Epoch ms the user last checked in (greytHR-accepted swipe time on the real
   *  path; mock clock on dev). Absent when the user has never checked in. */
  lastCheckInMs?: number;
  /** Epoch ms the user last checked out. Absent when never checked out. */
  lastCheckOutMs?: number;
  /** greytHR ESS portal deep link; present only when the real integration is on. */
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

// Local-time clock formatter (e.g. "9:42 AM") for the check-in/out lines. Built
// once; the browser's locale/timezone decide 12h vs 24h. Falls back to a raw
// locale string if the runtime lacks the formatter for some reason.
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

function formatTime(epochMs: number): string {
  try {
    return TIME_FORMAT.format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toLocaleTimeString();
  }
}

/** True when an epoch-ms timestamp falls on the current local day. */
function isToday(epochMs: number): boolean {
  const d = new Date(epochMs);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/** Human-readable duration, e.g. "1h 23m 45s". */
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
  /** Re-query the server status (e.g. on reconnect). */
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

  // Root starts hidden; revealed only after a successful status fetch.
  const root = document.createElement("div");
  root.className = "hud-panel attendance-widget";
  root.hidden = true;

  const title = document.createElement("div");
  title.className = "hud-panel-title";
  title.textContent = "Attendance";

  // "Open greytHR" deep link. Hidden until the server reports a portalUrl (i.e.
  // the real GreytHR integration is configured); stays hidden on the mock path.
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

  // Check-in / check-out times ("Checked in at 9:42 AM"). Each line is hidden
  // until the server reports the corresponding timestamp. Minimal inline
  // fallback styling keeps the widget compact and readable before any theme
  // loads; the CSS artist can theme the `.attendance-time` class freely.
  const times = document.createElement("div");
  times.className = "attendance-times";

  const checkInTime = document.createElement("div");
  checkInTime.className = "attendance-time attendance-time-in";
  checkInTime.hidden = true;

  const checkOutTime = document.createElement("div");
  checkOutTime.className = "attendance-time attendance-time-out";
  checkOutTime.hidden = true;

  times.append(checkInTime, checkOutTime);

  // Elapsed (live while checked in) / worked total (after check-out).
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

  let current: AttendanceStatus = "NOT_CHECKED_IN";
  let busy = false;
  let destroyed = false;
  let feedbackTimer: number | undefined;
  let lastCheckInMs: number | undefined;
  let lastCheckOutMs: number | undefined;
  let elapsedTimer: number | undefined;

  function stopTicker(): void {
    if (elapsedTimer !== undefined) {
      window.clearInterval(elapsedTimer);
      elapsedTimer = undefined;
    }
  }

  /** Render the elapsed/worked line; tick every second while checked in. */
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

  function render(): void {
    statusText.textContent = STATUS_LABEL[current];
    dot.style.background = STATUS_COLOR[current];
    // Daily logic: once you check in today, check-in is disabled; once you check
    // out today, check-out is disabled. Both reset on the next day.
    const checkedInToday = lastCheckInMs != null && isToday(lastCheckInMs);
    const checkedOutToday = lastCheckOutMs != null && isToday(lastCheckOutMs);
    checkInBtn.disabled = busy || checkedInToday;
    checkOutBtn.disabled = busy || !checkedInToday || checkedOutToday;
  }

  /** Show/hide the check-in/out time lines from the server's timestamps. */
  function renderTimes(checkInMs?: number, checkOutMs?: number): void {
    if (typeof checkInMs === "number") {
      checkInTime.textContent = formatTime(checkInMs);
      checkInTime.hidden = false;
    } else {
      checkInTime.textContent = "";
      checkInTime.hidden = true;
    }
    if (typeof checkOutMs === "number") {
      checkOutTime.textContent = formatTime(checkOutMs);
      checkOutTime.hidden = false;
    } else {
      checkOutTime.textContent = "";
      checkOutTime.hidden = true;
    }
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
        // HR integration absent (or session unknown) -> hide; office unaffected.
        stopTicker();
        root.hidden = true;
        return;
      }
      const data = (await res.json()) as StatusResponse;
      current = data.status;
      // Surface WHEN the user checked in/out (hidden when the server omits them).
      lastCheckInMs = data.lastCheckInMs;
      lastCheckOutMs = data.lastCheckOutMs;
      renderTimes(lastCheckInMs, lastCheckOutMs);
      renderElapsed();
      // Reveal the portal deep link only when the server supplies one.
      if (data.portalUrl) {
        portalLink.href = data.portalUrl;
        portalLink.hidden = false;
      } else {
        portalLink.removeAttribute("href");
        portalLink.hidden = true;
      }
      root.hidden = false;
      render();
    } catch {
      // Network error / no HR routes -> stay hidden.
      root.hidden = true;
    }
  }

  async function act(kind: "check-in" | "check-out"): Promise<void> {
    if (busy || destroyed) return;
    const sessionId = opts.getSessionId();
    if (!sessionId) return;
    busy = true;
    render();
    try {
      const res = await fetchFn(`${base}/api/hr/${kind}`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ sessionId }),
      });
      const data = (await res.json().catch(() => null)) as ActionResponse | null;
      if (res.ok && data?.ok) {
        current = data.status;
        // Optimistically record the time so the button disables immediately;
        // refresh() reconciles with greytHR's accepted swipe time.
        if (kind === "check-in") lastCheckInMs = Date.now();
        else lastCheckOutMs = Date.now();
        showFeedback(kind === "check-in" ? "Checked in." : "Checked out.", "ok");
        // Re-query so the newly recorded check-in/out time line appears (the
        // action response intentionally carries only ok/status/reason).
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

  checkInBtn.addEventListener("click", () => void act("check-in"));
  checkOutBtn.addEventListener("click", () => void act("check-out"));

  render();
  void refresh();

  return {
    refresh,
    destroy(): void {
      destroyed = true;
      if (feedbackTimer) window.clearTimeout(feedbackTimer);
      stopTicker();
      root.remove();
    },
  };
}
