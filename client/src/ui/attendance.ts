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

  const statusRow = document.createElement("div");
  statusRow.className = "attendance-status";

  const dot = document.createElement("span");
  dot.className = "attendance-dot";

  const statusText = document.createElement("span");
  statusText.className = "attendance-status-text";

  statusRow.append(dot, statusText);

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

  root.append(title, statusRow, actions, feedback);
  container.appendChild(root);

  let current: AttendanceStatus = "NOT_CHECKED_IN";
  let busy = false;
  let destroyed = false;
  let feedbackTimer: number | undefined;

  function render(): void {
    statusText.textContent = STATUS_LABEL[current];
    dot.style.background = STATUS_COLOR[current];
    // Both actions remain available (re-check-in is allowed) but the "current"
    // one is de-emphasized. Disable while a request is in flight.
    checkInBtn.disabled = busy;
    checkOutBtn.disabled = busy || current === "NOT_CHECKED_IN";
    checkInBtn.classList.toggle("is-current", current === "CHECKED_IN");
    checkOutBtn.classList.toggle("is-current", current === "CHECKED_OUT");
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
      root.hidden = true;
      return;
    }
    try {
      const res = await fetchFn(
        `${base}/api/hr/status?sessionId=${encodeURIComponent(sessionId)}`,
      );
      if (res.status === 404 || !res.ok) {
        // HR integration absent (or session unknown) -> hide; office unaffected.
        root.hidden = true;
        return;
      }
      const data = (await res.json()) as StatusResponse;
      current = data.status;
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const data = (await res.json().catch(() => null)) as ActionResponse | null;
      if (res.ok && data?.ok) {
        current = data.status;
        showFeedback(kind === "check-in" ? "Checked in." : "Checked out.", "ok");
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
      root.remove();
    },
  };
}
