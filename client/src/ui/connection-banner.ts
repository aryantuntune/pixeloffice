// ---------------------------------------------------------------------------
// Connection banner — a tiny presentation component (no business logic).
//
// It renders the high-level ConnectionState from the net layer: a "Reconnecting…"
// strip while the socket is down (driven by Connection's backoff loop) and a
// brief "Back online" confirmation once the re-join succeeds. The integrator
// wires it via `conn.onState(banner.setState)` in main.ts.
//
// Pure DOM + CSS classes; styling lives in styles.css (.conn-banner family).
// ---------------------------------------------------------------------------

import type { ConnectionState } from "../net/connection";

export interface ConnectionBanner {
  /** Drive the banner from a ConnectionState (pass directly to conn.onState). */
  setState(state: ConnectionState): void;
  /** Remove the banner from the DOM. */
  destroy(): void;
}

const BACK_ONLINE_MS = 2500;

export function mountConnectionBanner(root: HTMLElement): ConnectionBanner {
  const el = document.createElement("div");
  el.className = "conn-banner conn-banner--hidden";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");

  const dot = document.createElement("span");
  dot.className = "conn-banner__dot";
  const label = document.createElement("span");
  label.className = "conn-banner__label";

  el.append(dot, label);
  root.appendChild(el);

  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let last: ConnectionState | null = null;

  function clearTimer(): void {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function apply(state: ConnectionState): void {
    el.classList.remove(
      "conn-banner--reconnecting",
      "conn-banner--online",
      "conn-banner--offline",
      "conn-banner--hidden",
    );

    switch (state) {
      case "reconnecting":
        el.classList.add("conn-banner--reconnecting");
        label.textContent = "Reconnecting…";
        break;
      case "offline":
        el.classList.add("conn-banner--offline");
        label.textContent = "Disconnected";
        break;
      case "online":
        // Only celebrate "Back online" if we were previously in trouble.
        if (last === "reconnecting" || last === "offline") {
          el.classList.add("conn-banner--online");
          label.textContent = "Back online";
          hideTimer = setTimeout(() => {
            el.classList.add("conn-banner--hidden");
            hideTimer = null;
          }, BACK_ONLINE_MS);
        } else {
          el.classList.add("conn-banner--hidden");
        }
        break;
      case "connecting":
      default:
        el.classList.add("conn-banner--hidden");
        break;
    }
  }

  return {
    setState(state: ConnectionState): void {
      if (state === last) return;
      clearTimer();
      apply(state);
      last = state;
    },
    destroy(): void {
      clearTimer();
      el.remove();
    },
  };
}
