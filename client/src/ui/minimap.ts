// ---------------------------------------------------------------------------
// Corner minimap. A small canvas drawn from the static office map data (area
// rects tinted like the office, walls dark) with a live dot per player from the
// store (presence colors; self gets a white ring; NPCs are dimmer). Clicking a
// dot pans the CAMERA to that player (game.panToPlayer) — it NEVER moves any
// avatar (human-agency rule: camera panning is fine, teleporting is not).
//
// Cheap full redraw on every store change (the map is tiny, ~48x34 tiles).
// Collapsible; the collapsed state persists in localStorage. Reads the live
// "hide NPCs" setting via a getter so it stays in sync with the settings popover.
// No business logic — pure rendering + a pan callback.
// ---------------------------------------------------------------------------

import {
  PRESENCE_META,
  buildOfficeMap,
  type AreaType,
  type OfficeMap,
} from "@pixeloffice/shared";
import type { Store, UiState } from "./state";

const MAP: OfficeMap = buildOfficeMap();
const CANVAS_W = 176; // device-independent px (the CSS width)
const COLLAPSE_KEY = "pixeloffice.minimap.collapsed";

// Area fills — muted tints echoing the in-game floor palette. Display-only.
const AREA_FILL: Record<AreaType, string> = {
  RECEPTION: "#2a3340",
  DEPARTMENT: "#1f2935",
  MEETING_ROOM: "#26303d",
  COFFEE: "#33301f",
  LOUNGE: "#2c2233",
};
const WALL_FILL = "#0a0d12";
const BG_FILL = "#11151b";

export interface MinimapCallbacks {
  /** Pan the camera to a player (never moves the avatar). */
  onLocate(sessionId: string): void;
  /** Live "hide NPCs" toggle — when true, NPC dots are omitted. */
  isNpcHidden(): boolean;
}

export interface MinimapHandle {
  /** Redraw from the current store snapshot (call on every store change). */
  render(): void;
  destroy(): void;
}

interface DotHit {
  sessionId: string;
  px: number;
  py: number;
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}
function writeCollapsed(v: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
  } catch {
    /* private mode — collapse just won't persist */
  }
}

export function mountMinimap(parent: HTMLElement, store: Store, cb: MinimapCallbacks): MinimapHandle {
  const scale = CANVAS_W / MAP.width; // px per tile
  const canvasH = Math.round(MAP.height * scale);

  const wrap = document.createElement("div");
  wrap.className = "minimap";

  const header = document.createElement("div");
  header.className = "minimap-head";
  const title = document.createElement("span");
  title.className = "minimap-title";
  title.textContent = "Map";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "minimap-toggle";
  toggle.setAttribute("aria-label", "Collapse minimap");
  header.append(title, toggle);

  const canvas = document.createElement("canvas");
  canvas.className = "minimap-canvas";
  // Render at devicePixelRatio for crisp dots, but lay out at CSS px.
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  canvas.width = Math.round(CANVAS_W * dpr);
  canvas.height = Math.round(canvasH * dpr);
  canvas.style.width = `${CANVAS_W}px`;
  canvas.style.height = `${canvasH}px`;
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.scale(dpr, dpr);

  wrap.append(header, canvas);
  parent.appendChild(wrap);

  let collapsed = readCollapsed();
  let hits: DotHit[] = [];

  function applyCollapsed(): void {
    wrap.classList.toggle("collapsed", collapsed);
    toggle.textContent = collapsed ? "▸" : "▾";
    canvas.hidden = collapsed;
  }
  applyCollapsed();

  toggle.addEventListener("click", () => {
    collapsed = !collapsed;
    writeCollapsed(collapsed);
    applyCollapsed();
    if (!collapsed) render();
  });

  function drawMap(c: CanvasRenderingContext2D): void {
    c.fillStyle = BG_FILL;
    c.fillRect(0, 0, CANVAS_W, canvasH);
    // Area rects.
    for (const a of MAP.areas) {
      c.fillStyle = AREA_FILL[a.type] ?? "#1c2530";
      c.fillRect(a.x * scale, a.y * scale, a.w * scale, a.h * scale);
    }
    // Walls (dark) — drawn as small filled tiles.
    c.fillStyle = WALL_FILL;
    for (const w of MAP.walls) {
      c.fillRect(w.x * scale, w.y * scale, scale + 0.5, scale + 0.5);
    }
  }

  function drawDots(c: CanvasRenderingContext2D, state: UiState): void {
    hits = [];
    const hideNpcs = cb.isNpcHidden();
    // Draw self last so its ring sits on top.
    const players = [...state.players.values()];
    players.sort((a, b) => {
      const aSelf = a.sessionId === state.selfId ? 1 : 0;
      const bSelf = b.sessionId === state.selfId ? 1 : 0;
      return aSelf - bSelf;
    });
    for (const p of players) {
      if (p.isNpc && hideNpcs) continue;
      const px = (p.x + 0.5) * scale;
      const py = (p.y + 0.5) * scale;
      const isSelf = p.sessionId === state.selfId;
      const color = PRESENCE_META[p.presence].color;
      const r = isSelf ? 3.2 : 2.6;

      c.globalAlpha = p.isNpc ? 0.5 : 1;
      c.beginPath();
      c.arc(px, py, r, 0, Math.PI * 2);
      c.fillStyle = color;
      c.fill();
      if (isSelf) {
        c.globalAlpha = 1;
        c.lineWidth = 1.4;
        c.strokeStyle = "#ffffff";
        c.stroke();
      }
      c.globalAlpha = 1;

      hits.push({ sessionId: p.sessionId, px, py });
    }
  }

  function render(): void {
    if (collapsed || !ctx) return;
    drawMap(ctx);
    drawDots(ctx, store.get());
  }

  // Click → pan to the nearest dot within a small radius.
  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let best: DotHit | null = null;
    let bestD = 8 * 8; // 8px hit radius (squared)
    for (const h of hits) {
      const dx = h.px - x;
      const dy = h.py - y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = h;
      }
    }
    if (best) cb.onLocate(best.sessionId);
  });

  render();

  return {
    render,
    destroy(): void {
      wrap.remove();
    },
  };
}
