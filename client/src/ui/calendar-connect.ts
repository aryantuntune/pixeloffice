// ---------------------------------------------------------------------------
// "Sign in with Google to sync Workspace" HUD widget (Google Calendar
// integration, presentation
// only). Self-contained: mountCalendarConnect(container, opts) renders a small
// row letting the user connect/disconnect their Google Calendar so their real
// meetings drive their presence (and surface a Join Meet link).
//
// It contains NO business logic — connecting is a full-page navigation to the
// server's OAuth entry point (an explicit human click; never auto-initiated),
// and the connected/disconnected state mirrors what the server reports.
//
// OPTIONAL INTEGRATION (plan Principle 4): if GET /api/auth/google/calendar/status
// 404s (Google not configured / routes not mounted), the widget renders NOTHING
// and the office keeps working unchanged. Integrations are optional.
// ---------------------------------------------------------------------------

import { readStoredToken } from "./login";

/** Attach the OAuth bearer token when one exists so status/disconnect work under
 *  AUTH_REQUIRED (requireAuth rejects token-less requests). On the dev path no
 *  token exists and the header is omitted. Mirrors attendance.ts / admin.ts. */
function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  const token = readStoredToken();
  return token ? { ...base, Authorization: `Bearer ${token}` } : { ...base };
}

export interface MountCalendarConnectOptions {
  /** Base URL of the server REST API, e.g. "http://localhost:2567". */
  fetchBase: string;
  /** Returns the live Colyseus sessionId (resolved server-side to the user). */
  getSessionId(): string;
  /** Injectable fetch for tests; defaults to window.fetch. */
  fetchFn?: typeof fetch;
}

/** Server status payload. `connected` drives the rendered state; extra fields are
 *  ignored so the server can extend the response without breaking the widget. */
interface CalendarStatusResponse {
  connected: boolean;
}

export interface CalendarConnectHandle {
  /** Re-query the server status (e.g. on reconnect). */
  refresh(): Promise<void>;
  /** Remove the widget from the DOM. */
  destroy(): void;
}

export function mountCalendarConnect(
  container: HTMLElement,
  opts: MountCalendarConnectOptions,
): CalendarConnectHandle {
  const fetchFn = opts.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = opts.fetchBase.replace(/\/+$/, "");

  // Root starts hidden; revealed only after a successful (non-404) status fetch.
  const root = document.createElement("div");
  root.className = "calendar-connect";
  root.hidden = true;

  const row = document.createElement("div");
  row.className = "calendar-connect-row";

  const icon = document.createElement("span");
  icon.className = "calendar-connect-icon";
  icon.textContent = "📆";

  const label = document.createElement("span");
  label.className = "calendar-connect-label";

  // Primary action button. In the disconnected state it reads "Sign in" and
  // does a full-page redirect to the server's calendar OAuth entry point; in the
  // connected state it is hidden in favour of the disconnect link.
  const connectBtn = document.createElement("button");
  connectBtn.type = "button";
  connectBtn.className = "calendar-connect-btn";
  connectBtn.textContent = "Sign in";

  // Subtle disconnect affordance, shown only when connected.
  const disconnectBtn = document.createElement("button");
  disconnectBtn.type = "button";
  disconnectBtn.className = "calendar-disconnect-btn";
  disconnectBtn.textContent = "Disconnect";
  disconnectBtn.hidden = true;

  row.append(icon, label, connectBtn, disconnectBtn);
  root.append(row);
  container.appendChild(root);

  let connected = false;
  let busy = false;
  let destroyed = false;

  function render(): void {
    if (connected) {
      label.textContent = "Google Workspace synced";
      label.classList.add("is-connected");
      connectBtn.hidden = true;
      disconnectBtn.hidden = false;
      disconnectBtn.disabled = busy;
    } else {
      label.textContent = "Sign in with Google to sync Workspace";
      label.classList.remove("is-connected");
      connectBtn.hidden = false;
      connectBtn.disabled = busy;
      disconnectBtn.hidden = true;
    }
  }

  async function refresh(): Promise<void> {
    const sessionId = opts.getSessionId();
    if (!sessionId) {
      root.hidden = true;
      return;
    }
    try {
      const res = await fetchFn(
        `${base}/api/auth/google/calendar/status?sessionId=${encodeURIComponent(sessionId)}`,
        { headers: authHeaders() },
      );
      // 404 => Google not configured / routes absent: render NOTHING.
      if (res.status === 404 || !res.ok) {
        root.hidden = true;
        return;
      }
      const data = (await res.json()) as CalendarStatusResponse;
      connected = Boolean(data.connected);
      root.hidden = false;
      render();
    } catch {
      // Network error / no routes -> stay hidden; office unaffected.
      root.hidden = true;
    }
  }

  // Connect = explicit human action: a full-page, same-tab navigation to the
  // server's OAuth entry point (it redirects back with #calendar=connected).
  connectBtn.addEventListener("click", () => {
    if (busy || destroyed) return;
    const sessionId = opts.getSessionId();
    if (!sessionId) return;
    location.assign(
      `${base}/api/auth/google/calendar/connect?sessionId=${encodeURIComponent(sessionId)}`,
    );
  });

  disconnectBtn.addEventListener("click", () => void disconnect());

  async function disconnect(): Promise<void> {
    if (busy || destroyed) return;
    const sessionId = opts.getSessionId();
    if (!sessionId) return;
    busy = true;
    render();
    try {
      const res = await fetchFn(`${base}/api/auth/google/calendar/disconnect`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ sessionId }),
      });
      if (res.ok) {
        connected = false;
      }
    } catch {
      // Leave the state as-is on failure; the office keeps working regardless.
    } finally {
      busy = false;
      if (!destroyed) render();
    }
  }

  void refresh();

  return {
    refresh,
    destroy(): void {
      destroyed = true;
      root.remove();
    },
  };
}
