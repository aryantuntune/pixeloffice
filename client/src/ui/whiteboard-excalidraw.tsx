// ---------------------------------------------------------------------------
// Excalidraw React island. The rest of the client is vanilla TS + Phaser; this
// is the ONLY React in the app and is dynamically imported by whiteboard.ts so
// React + Excalidraw load in a lazy chunk (never on first paint).
//
// It is a thin, render-from-state bridge: it mounts <Excalidraw>, reports local
// element changes up via onChange, and exposes updateScene() so the controller
// can push remote edits in. NO networking, presence, or business logic here —
// whiteboard.ts owns the sync + the protocol.
// ---------------------------------------------------------------------------

import { createRoot, type Root } from "react-dom/client";
import { Excalidraw, restoreElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { WhiteboardElement } from "@pixeloffice/shared";

// Pin Excalidraw's font/asset CDN to the installed version so the hand-drawn
// fonts resolve without bundling binaries (Constitution: no binary assets). On
// a fully offline LAN text falls back to a system font — still fully usable.
const EXCALIDRAW_VERSION = "0.18.0";
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}
if (typeof window !== "undefined" && !window.EXCALIDRAW_ASSET_PATH) {
  window.EXCALIDRAW_ASSET_PATH = `https://esm.sh/@excalidraw/excalidraw@${EXCALIDRAW_VERSION}/dist/prod/`;
}

// Minimal shape of the Excalidraw imperative API we use.
interface ExcalidrawApi {
  updateScene(scene: { elements: readonly unknown[] }): void;
}

export interface BoardIsland {
  /** Replace the scene's elements with the reconciled set (remote edits in). */
  updateScene(elements: WhiteboardElement[]): void;
  /** Unmount the React tree and free the canvas. */
  destroy(): void;
}

export interface BoardIslandOpts {
  initialElements: WhiteboardElement[];
  /** Fired on every local change with the FULL current element set. */
  onChange(elements: WhiteboardElement[]): void;
}

export function createBoardIsland(container: HTMLElement, opts: BoardIslandOpts): BoardIsland {
  let api: ExcalidrawApi | null = null;
  const root: Root = createRoot(container);

  root.render(
    <div style={{ width: "100%", height: "100%" }}>
      <Excalidraw
        initialData={{ elements: opts.initialElements as never, scrollToContent: true }}
        excalidrawAPI={(a) => {
          api = a as unknown as ExcalidrawApi;
        }}
        onChange={(elements) => opts.onChange(elements as unknown as WhiteboardElement[])}
      />
    </div>,
  );

  return {
    updateScene(elements) {
      // Excalidraw ignores externally-injected elements that haven't been
      // normalized. restoreElements() fills derived fields while PRESERVING
      // each element's `version` (so it doesn't trip our echo guard), making a
      // remote collaborator's drawings actually render. Empty stays empty.
      const restored = restoreElements(elements as never, null);
      api?.updateScene({ elements: restored });
    },
    destroy() {
      // Defer so React isn't asked to unmount synchronously during its own render.
      queueMicrotask(() => root.unmount());
    },
  };
}
