// ---------------------------------------------------------------------------
// Whiteboard controller (vanilla TS). Owns the per-department Excalidraw board:
// a full-screen overlay holding the Excalidraw React island (lazy-imported),
// plus the multiplayer sync. One board open at a time; opened by walking to a
// department's white table and pressing [E] (wired in main.ts).
//
// SYNC: Excalidraw stamps every element with a monotonic `version`. On local
// change we send only elements whose version advanced; on remote update we
// reconcile by version (last-writer-wins) and push the merged scene back into
// Excalidraw. Version bookkeeping also prevents echo loops (a remote element we
// just applied carries a version we already recorded, so our own onChange after
// updateScene re-sends nothing).
//
// No business logic beyond transport: the server stores boards + relays changes.
// ---------------------------------------------------------------------------

import type { Department } from "@pixeloffice/shared";
import type {
  WhiteboardElement,
  WhiteboardStateS2C,
  WhiteboardUpdateS2C,
  WhiteboardClearS2C,
} from "@pixeloffice/shared";
import type { BoardIsland } from "./whiteboard-excalidraw";

/** Trailing-throttle window for outgoing element batches (ms). */
const SEND_THROTTLE_MS = 150;

export interface WhiteboardDeps {
  /** Subscribe to a board (server replies with WHITEBOARD_STATE). */
  open(board: Department): void;
  /** Unsubscribe from a board. */
  close(board: Department): void;
  /** Push locally-changed elements to a board. */
  update(board: Department, elements: WhiteboardElement[]): void;
  /** Wipe a board for everyone. */
  clear(board: Department): void;
  /** Lock avatar keyboard movement while the board overlay is open. */
  onOpenChange?(open: boolean): void;
}

export interface WhiteboardHandle {
  /** Open (or switch to) a department board overlay. */
  open(board: Department): void;
  handleState(payload: WhiteboardStateS2C): void;
  handleUpdate(payload: WhiteboardUpdateS2C): void;
  handleClear(payload: WhiteboardClearS2C): void;
  destroy(): void;
}

function isNewer(next: WhiteboardElement, prev: WhiteboardElement): boolean {
  if (next.version !== prev.version) return next.version > prev.version;
  return (next.versionNonce ?? 0) > (prev.versionNonce ?? 0);
}

export function mountWhiteboard(parent: HTMLElement, deps: WhiteboardDeps): WhiteboardHandle {
  let overlay: HTMLDivElement | null = null;
  let titleEl: HTMLSpanElement | null = null;
  let canvasHost: HTMLDivElement | null = null;

  let island: BoardIsland | null = null;
  let currentBoard: Department | null = null;
  // Generation counter so an async island mount that resolves after the user
  // closed/switched boards can detect it is stale and self-destruct.
  let openSeq = 0;

  // Latest known element per id, and the version we last sent/applied per id.
  const merged = new Map<string, WhiteboardElement>();
  const lastVersion = new Map<string, number>();

  // Outgoing throttle: accumulate changed elements, flush on a trailing timer.
  const pending = new Map<string, WhiteboardElement>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function ensureOverlay(): void {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "wb-overlay";
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "9000",
      display: "none",
      flexDirection: "column",
      background: "#0e1116",
      // #hud-root is `pointer-events: none` (only an allow-list of controls
      // re-enables clicks). Excalidraw's toolbar/panels are buttons/inputs so
      // they'd work, but the drawing <canvas> is not — it would inherit `none`
      // and silently swallow every stroke. Own our events for the whole subtree.
      pointerEvents: "auto",
    } satisfies Partial<CSSStyleDeclaration>);

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      alignItems: "center",
      gap: "12px",
      padding: "8px 12px",
      background: "#161b22",
      borderBottom: "1px solid #2a2f37",
      color: "#e6edf3",
      font: "600 14px/1.2 system-ui, sans-serif",
      flex: "0 0 auto",
    } satisfies Partial<CSSStyleDeclaration>);

    titleEl = document.createElement("span");
    titleEl.style.flex = "1";

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "Clear board";
    styleBtn(clearBtn);
    clearBtn.addEventListener("click", () => {
      if (!currentBoard) return;
      if (!confirm("Clear this whiteboard for everyone on the team?")) return;
      deps.clear(currentBoard);
      applyClearLocally();
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "Close (done)";
    styleBtn(closeBtn, true);
    closeBtn.addEventListener("click", () => close());

    header.append(titleEl, clearBtn, closeBtn);

    canvasHost = document.createElement("div");
    Object.assign(canvasHost.style, {
      flex: "1 1 auto",
      position: "relative",
      minHeight: "0",
    } satisfies Partial<CSSStyleDeclaration>);

    overlay.append(header, canvasHost);
    parent.appendChild(overlay);
  }

  function styleBtn(btn: HTMLButtonElement, primary = false): void {
    Object.assign(btn.style, {
      padding: "6px 12px",
      borderRadius: "8px",
      border: primary ? "1px solid #2e6fd8" : "1px solid #3a4150",
      background: primary ? "#2e6fd8" : "#222831",
      color: "#e6edf3",
      cursor: "pointer",
      font: "600 13px/1 system-ui, sans-serif",
    } satisfies Partial<CSSStyleDeclaration>);
  }

  function open(board: Department): void {
    if (currentBoard === board) return;
    if (currentBoard) closeQuietly();

    ensureOverlay();
    currentBoard = board;
    const seq = ++openSeq;
    merged.clear();
    lastVersion.clear();
    pending.clear();
    if (titleEl) titleEl.textContent = `${board} Whiteboard`;
    if (overlay) overlay.style.display = "flex";
    deps.onOpenChange?.(true);

    // Subscribe now so WHITEBOARD_STATE starts coming (it may arrive before the
    // island finishes loading — handleState buffers into `merged` regardless).
    deps.open(board);

    void (async () => {
      const mod = await import("./whiteboard-excalidraw");
      // Stale: the user closed or switched boards while React loaded.
      if (seq !== openSeq || !canvasHost) return;
      island = mod.createBoardIsland(canvasHost, {
        initialElements: [...merged.values()],
        onChange: onLocalChange,
      });
      // Apply any state/updates that arrived before the island mounted.
      if (merged.size > 0) island.updateScene([...merged.values()]);
    })();
  }

  function onLocalChange(elements: WhiteboardElement[]): void {
    if (!currentBoard) return;
    for (const el of elements) {
      const seen = lastVersion.get(el.id);
      if (seen !== undefined && seen === el.version) continue; // unchanged
      lastVersion.set(el.id, el.version);
      merged.set(el.id, el);
      pending.set(el.id, el);
    }
    if (pending.size > 0) scheduleFlush();
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (!currentBoard || pending.size === 0) return;
      const batch = [...pending.values()];
      pending.clear();
      deps.update(currentBoard, batch);
    }, SEND_THROTTLE_MS);
  }

  function reconcileIn(elements: WhiteboardElement[]): void {
    for (const el of elements) {
      const prev = merged.get(el.id);
      if (!prev || isNewer(el, prev)) {
        merged.set(el.id, el);
        // Record the version so the island's onChange (fired by updateScene
        // below) does not bounce this element back to the server.
        lastVersion.set(el.id, el.version);
      }
    }
  }

  function applyClearLocally(): void {
    merged.clear();
    lastVersion.clear();
    pending.clear();
    island?.updateScene([]);
  }

  function handleState(payload: WhiteboardStateS2C): void {
    if (payload.board !== currentBoard) return;
    merged.clear();
    lastVersion.clear();
    for (const el of payload.elements) {
      merged.set(el.id, el);
      lastVersion.set(el.id, el.version);
    }
    island?.updateScene([...merged.values()]);
  }

  function handleUpdate(payload: WhiteboardUpdateS2C): void {
    if (payload.board !== currentBoard) return;
    reconcileIn(payload.elements);
    island?.updateScene([...merged.values()]);
  }

  function handleClear(payload: WhiteboardClearS2C): void {
    if (payload.board !== currentBoard) return;
    applyClearLocally();
  }

  /** Tear down the island + overlay state without sending close (used on switch). */
  function closeQuietly(): void {
    openSeq++;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    island?.destroy();
    island = null;
    merged.clear();
    lastVersion.clear();
    pending.clear();
    if (overlay) overlay.style.display = "none";
  }

  function close(): void {
    if (!currentBoard) return;
    const board = currentBoard;
    closeQuietly();
    currentBoard = null;
    deps.close(board);
    deps.onOpenChange?.(false);
  }

  function destroy(): void {
    closeQuietly();
    currentBoard = null;
    overlay?.remove();
    overlay = null;
    titleEl = null;
    canvasHost = null;
  }

  return { open, handleState, handleUpdate, handleClear, destroy };
}
