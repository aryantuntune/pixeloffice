// ---------------------------------------------------------------------------
// Map Studio — in-browser, admin multi-floor map authoring tool.
//
// PURE TOOL. It edits a Building's geometry and pushes it live through the
// /api/maps REST endpoints. It contains NO game/presence/network-protocol logic
// (no Colyseus, no movement, no avatars). It only:
//   1. loads the active building     GET  /api/maps/active
//   2. lets an admin paint each floor's tiles (Floor/Wall/Desk/zones/Portal/Spawn)
//   3. validates locally + serializes to BuildingJSON (the EXACT parseBuilding
//      format from MULTIFLOOR-CONTRACT.md)
//   4. saves                          POST /api/maps           (handles 400 details)
//   5. activates                      POST /api/maps/:id/activate
//
// Human agency: the studio NEVER moves a live player. Activating a map only
// affects NEW joins ("Live — rejoin to see changes"); a live hot-swap is out of
// scope (documented in the footer message).
//
// SELF-CONTAINED: imports only @pixeloffice/shared (domain types) and
// serverHttpBase() from ../net/connection (pure transport-base helper). It does
// NOT import sibling ui/* files (owned concurrently by the UI redesigner) and
// does NOT touch game/, styles.css, or main.ts. The CSS is injected once from
// ./map-studio.css.
//
// INTEGRATION (for whoever wires main.ts — do NOT edit main.ts yourself):
//
//   import { createMapStudio } from "./ui/map-studio";
//   const studio = createMapStudio(document.body);   // returns { open, close, destroy }
//   // then trigger it from an admin entry point, e.g. a button:
//   //   const btn = document.createElement("button");
//   //   btn.textContent = "🗺 Map Studio";
//   //   btn.onclick = () => studio.open();
//   //   someAdminToolbar.appendChild(btn);
//
// createMapStudio also auto-mounts its own floating "🗺 Map Studio" trigger
// button (bottom-left) when called with no existing trigger, so the minimal
// integration is just `createMapStudio(document.body)` — the button appears and
// opens the studio. Pass { mountTrigger: false } to suppress it and call open()
// yourself.
//
// Keyboard: number keys 1-9/0 pick tools; Esc closes.
// ---------------------------------------------------------------------------

import {
  DEPARTMENTS,
  type AreaType,
  type BuildingJSON,
  type FloorJSON,
  type BuildingValidationError,
  type Department,
  type Desk,
  type Furniture,
  type FurnitureKind,
  type Portal,
  type TilePos,
  type Area,
} from "@pixeloffice/shared";
import { serverHttpBase } from "../net/connection";
// The styles live in ./map-studio.css (kept in sync with the string below) and
// are injected as a <style> tag the first time the studio opens, so the
// integrator does NOT have to import the CSS anywhere. The string is embedded
// here (rather than a `?inline` CSS import) so the module type-checks with plain
// `tsc` and bundles with no special CSS loader — fully self-contained.

// ---------------------------------------------------------------------------
// Paint model
// ---------------------------------------------------------------------------
// Each floor is authored as a grid of "cell kinds" plus a few overlays:
//   - grid[y][x] = CellKind        (the painted base tile)
//   - desks: Desk[]                (a desk paints a 2x1 desk + a walkable seat)
//   - portals: Portal[]            (elevator/portal tiles -> target floor+tile)
//   - spawn: TilePos               (the fallback spawn; exactly one)
//   - zoneNames: Map<area-instance-id, name>  (named zones)
// On serialize we derive the parseBuilding-shaped FloorJSON (solid/walls/
// furniture/areas/desks/anchors/spawn/portals).
//
// A CellKind is either EMPTY (open walkable floor) or one of the paintable kinds.

type ZoneCellKind =
  | "meeting"
  | "coffee"
  | "lounge"
  | "reception"
  | "cabin";

type CellKind =
  | "empty" // open, walkable floor
  | "wall" // solid wall
  | ZoneCellKind; // a zone tile (walkable; grouped into a named Area)

const ZONE_AREA_TYPE: Record<ZoneCellKind, AreaType> = {
  meeting: "MEETING_ROOM",
  coffee: "COFFEE",
  lounge: "LOUNGE",
  reception: "RECEPTION",
  cabin: "MEETING_ROOM", // a cabin is a small named meeting-style room
};

const ZONE_LABEL: Record<ZoneCellKind, string> = {
  meeting: "Meeting Room",
  coffee: "Coffee Area",
  lounge: "Lounge",
  reception: "Reception",
  cabin: "Cabin",
};

interface DeskMark {
  x: number;
  y: number;
  department: Department;
}

interface FloorModel {
  id: string;
  name: string;
  index: number;
  width: number;
  height: number;
  grid: CellKind[][]; // grid[y][x]
  desks: DeskMark[];
  portals: Portal[];
  spawn: TilePos;
  /** Custom names for painted zones, keyed by the zone's top-left tile "x,y". */
  zoneNames: Map<string, string>;
}

interface BuildingModel {
  id: string;
  name: string;
  floors: FloorModel[];
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

type ToolId =
  | "floor"
  | "wall"
  | "desk"
  | "meeting"
  | "coffee"
  | "lounge"
  | "reception"
  | "cabin"
  | "portal"
  | "spawn"
  | "eraser";

interface ToolDef {
  id: ToolId;
  label: string;
  /** Rendering / legend color. */
  color: string;
  /** Keyboard digit (1..0). */
  key: string;
}

const TOOLS: ToolDef[] = [
  { id: "floor", label: "Floor", color: "#1b2233", key: "1" },
  { id: "wall", label: "Wall", color: "#39435a", key: "2" },
  { id: "desk", label: "Desk", color: "#c89b3c", key: "3" },
  { id: "meeting", label: "Meeting room", color: "#5a6fd8", key: "4" },
  { id: "coffee", label: "Coffee zone", color: "#b9743a", key: "5" },
  { id: "lounge", label: "Lounge zone", color: "#7d56c2", key: "6" },
  { id: "reception", label: "Reception", color: "#3aa6a0", key: "7" },
  { id: "cabin", label: "Cabin", color: "#4a8f5a", key: "8" },
  { id: "portal", label: "Elevator / Portal", color: "#e5544b", key: "9" },
  { id: "spawn", label: "Spawn point", color: "#3ecf6e", key: "0" },
  { id: "eraser", label: "Eraser", color: "#0a0d14", key: "E" },
];

const TOOL_BY_KEY = new Map(TOOLS.map((t) => [t.key.toLowerCase(), t.id]));

/** Color used to render a painted base cell of a given kind. */
function cellColor(kind: CellKind): string {
  switch (kind) {
    case "empty":
      return "#141925";
    case "wall":
      return "#39435a";
    case "meeting":
      return "#2a3566";
    case "coffee":
      return "#5c3a22";
    case "lounge":
      return "#3d2b5c";
    case "reception":
      return "#1f4f4c";
    case "cabin":
      return "#234a2c";
  }
}

const TILE_PX = 16; // canvas pixels per tile (independent of game TILE size)
const DEFAULT_W = 48;
const DEFAULT_H = 34;

// ---------------------------------------------------------------------------
// Public handle
// ---------------------------------------------------------------------------

export interface MapStudioHandle {
  /** Open the studio (loads the active building if not already loaded). */
  open(): void;
  /** Close the studio (keeps the in-memory edits for the next open). */
  close(): void;
  /** Remove the studio + trigger from the DOM. */
  destroy(): void;
}

export interface MapStudioOptions {
  /** Auto-mount a floating "🗺 Map Studio" trigger button. Default true. */
  mountTrigger?: boolean;
}

const mapStudioCss = `
.ms-backdrop {
  position: fixed;
  inset: 0;
  z-index: 4000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 10, 16, 0.78);
  font-family: ui-monospace, "SFMono-Regular", "Menlo", "Consolas", monospace;
  color: #e6e9ef;
}
.ms-backdrop[hidden] { display: none; }
.ms-modal {
  display: flex;
  flex-direction: column;
  width: min(1280px, 96vw);
  height: min(860px, 94vh);
  background: #11141d;
  border: 2px solid #2a3142;
  border-radius: 10px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}
.ms-header {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 14px; border-bottom: 1px solid #232a39; background: #0d1019;
}
.ms-title { font-size: 15px; font-weight: 700; letter-spacing: 0.5px; margin: 0; white-space: nowrap; }
.ms-title .ms-building-name { color: #8a93a6; font-weight: 400; margin-left: 8px; }
.ms-tabs { display: flex; gap: 6px; flex: 1; overflow-x: auto; padding-bottom: 2px; }
.ms-tab {
  appearance: none; border: 1px solid #2a3142; background: #161b27; color: #b7c0d0;
  padding: 6px 12px; border-radius: 6px 6px 0 0; font: inherit; font-size: 12px;
  cursor: pointer; white-space: nowrap;
}
.ms-tab:hover { background: #1d2433; }
.ms-tab.ms-tab-active { background: #2a63e8; border-color: #2a63e8; color: #fff; }
.ms-tab.ms-tab-error::after { content: " warning"; color: #ffd34d; }
.ms-addfloor {
  appearance: none; border: 1px dashed #3a4458; background: transparent; color: #8a93a6;
  padding: 6px 10px; border-radius: 6px; font: inherit; font-size: 12px; cursor: pointer;
}
.ms-addfloor:hover { color: #e6e9ef; border-color: #5a6680; }
.ms-close {
  appearance: none; border: none; background: transparent; color: #8a93a6;
  font-size: 20px; line-height: 1; cursor: pointer; padding: 2px 6px;
}
.ms-close:hover { color: #fff; }
.ms-body { display: flex; flex: 1; min-height: 0; }
.ms-canvas-wrap {
  flex: 1; min-width: 0; overflow: auto; padding: 16px; background: #0a0d14;
  display: flex; align-items: flex-start; justify-content: center;
}
.ms-canvas { image-rendering: pixelated; background: #141925; cursor: crosshair; box-shadow: 0 0 0 1px #232a39; }
.ms-side {
  width: 280px; flex-shrink: 0; border-left: 1px solid #232a39; background: #0d1019;
  overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 14px;
}
.ms-section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6e7891; margin: 0 0 6px; }
.ms-palette { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.ms-tool {
  display: flex; align-items: center; gap: 7px; border: 1px solid #2a3142; background: #161b27;
  color: #c4ccda; padding: 7px 8px; border-radius: 6px; font: inherit; font-size: 11.5px;
  cursor: pointer; text-align: left;
}
.ms-tool:hover { background: #1d2433; }
.ms-tool.ms-tool-active { border-color: #2a63e8; background: #182542; color: #fff; }
.ms-tool .ms-swatch { width: 14px; height: 14px; border-radius: 3px; flex-shrink: 0; border: 1px solid rgba(255,255,255,0.18); }
.ms-tool .ms-key { margin-left: auto; color: #5f6a82; font-size: 10px; }
.ms-props { display: flex; flex-direction: column; gap: 8px; }
.ms-field { display: flex; flex-direction: column; gap: 3px; }
.ms-field label { font-size: 11px; color: #8a93a6; }
.ms-field input, .ms-field select {
  background: #11141d; border: 1px solid #2a3142; color: #e6e9ef; border-radius: 5px;
  padding: 6px 8px; font: inherit; font-size: 12px;
}
.ms-field input:focus, .ms-field select:focus { outline: none; border-color: #2a63e8; }
.ms-hint { font-size: 11px; color: #6e7891; line-height: 1.4; }
.ms-legend { display: flex; flex-direction: column; gap: 4px; }
.ms-legend-row { display: flex; align-items: center; gap: 7px; font-size: 11px; color: #aab2c2; }
.ms-legend-row .ms-swatch { width: 12px; height: 12px; border-radius: 3px; border: 1px solid rgba(255,255,255,0.18); }
.ms-footer { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-top: 1px solid #232a39; background: #0d1019; }
.ms-status { flex: 1; font-size: 12px; min-height: 18px; }
.ms-status.ms-ok { color: #3ecf6e; }
.ms-status.ms-warn { color: #ffd34d; }
.ms-status.ms-err { color: #ff6b61; }
.ms-errors { margin: 4px 0 0; padding: 0; list-style: none; font-size: 11px; color: #ff8077; max-height: 96px; overflow-y: auto; }
.ms-errors li { padding: 1px 0; }
.ms-btn {
  appearance: none; border: 1px solid #2a3142; background: #1b2230; color: #d6dce8;
  padding: 8px 16px; border-radius: 6px; font: inherit; font-size: 13px; cursor: pointer;
}
.ms-btn:hover { background: #232c3d; }
.ms-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ms-btn-primary { background: #2a63e8; border-color: #2a63e8; color: #fff; }
.ms-btn-primary:hover { background: #3a72f0; }
.ms-floor-meta { display: flex; flex-direction: column; gap: 8px; }
.ms-danger { color: #ff8077; border-color: #5a2a2a; }
.ms-danger:hover { background: #2a1414; }
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement("style");
  style.setAttribute("data-map-studio", "");
  style.textContent = mapStudioCss;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createMapStudio(
  parent: HTMLElement,
  options: MapStudioOptions = {},
): MapStudioHandle {
  injectCss();

  const state: {
    building: BuildingModel | null;
    activeFloorIdx: number;
    tool: ToolId;
    deskDept: Department;
    portalTargetFloorId: string;
    selectedZoneKey: string | null; // "x,y" of clicked zone top-left, for naming
    painting: boolean;
    paintErase: boolean;
    loading: boolean;
    loadError: string | null;
    validationErrors: BuildingValidationError[];
  } = {
    building: null,
    activeFloorIdx: 0,
    tool: "floor",
    deskDept: DEPARTMENTS[0],
    portalTargetFloorId: "",
    selectedZoneKey: null,
    painting: false,
    paintErase: false,
    loading: false,
    loadError: null,
    validationErrors: [],
  };

  // --- DOM scaffold --------------------------------------------------------
  const backdrop = document.createElement("div");
  backdrop.className = "ms-backdrop";
  backdrop.hidden = true;

  const modal = document.createElement("div");
  modal.className = "ms-modal";
  backdrop.appendChild(modal);

  // header
  const header = document.createElement("div");
  header.className = "ms-header";
  const title = document.createElement("h2");
  title.className = "ms-title";
  title.innerHTML = `🗺 Map Studio<span class="ms-building-name"></span>`;
  const tabs = document.createElement("div");
  tabs.className = "ms-tabs";
  const addFloorBtn = document.createElement("button");
  addFloorBtn.type = "button";
  addFloorBtn.className = "ms-addfloor";
  addFloorBtn.textContent = "+ Floor";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ms-close";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Close Map Studio");
  header.append(title, tabs, addFloorBtn, closeBtn);

  // body: canvas + side
  const body = document.createElement("div");
  body.className = "ms-body";
  const canvasWrap = document.createElement("div");
  canvasWrap.className = "ms-canvas-wrap";
  const canvas = document.createElement("canvas");
  canvas.className = "ms-canvas";
  canvasWrap.appendChild(canvas);
  const side = document.createElement("div");
  side.className = "ms-side";
  body.append(canvasWrap, side);

  // footer
  const footer = document.createElement("div");
  footer.className = "ms-footer";
  const statusWrap = document.createElement("div");
  statusWrap.style.flex = "1";
  const status = document.createElement("div");
  status.className = "ms-status";
  const errorsList = document.createElement("ul");
  errorsList.className = "ms-errors";
  statusWrap.append(status, errorsList);
  const testBtn = document.createElement("button");
  testBtn.type = "button";
  testBtn.className = "ms-btn";
  testBtn.textContent = "Test (preview)";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "ms-btn ms-btn-primary";
  saveBtn.textContent = "Save & Activate";
  footer.append(statusWrap, testBtn, saveBtn);

  modal.append(header, body, footer);
  parent.appendChild(backdrop);

  // optional floating trigger
  let trigger: HTMLButtonElement | null = null;
  if (options.mountTrigger !== false) {
    trigger = document.createElement("button");
    trigger.type = "button";
    // Position/z-index live in styles.css (.ms-trigger) so the bottom-right
    // dock stays consistent with the Admin button and other HUD chrome.
    trigger.className = "ms-btn ms-trigger";
    trigger.textContent = "🗺 Map Studio";
    trigger.addEventListener("click", () => handle.open());
    parent.appendChild(trigger);
  }

  const ctx = canvas.getContext("2d")!;

  // -------------------------------------------------------------------------
  // Model helpers
  // -------------------------------------------------------------------------

  function activeFloor(): FloorModel | null {
    if (!state.building) return null;
    return state.building.floors[state.activeFloorIdx] ?? null;
  }

  /** Build a blank floor grid (border walls, open interior). */
  function blankFloor(id: string, name: string, index: number): FloorModel {
    const width = DEFAULT_W;
    const height = DEFAULT_H;
    const grid: CellKind[][] = Array.from({ length: height }, (_unused, y) =>
      Array.from({ length: width }, (_u, x) =>
        x === 0 || y === 0 || x === width - 1 || y === height - 1 ? "wall" : "empty",
      ),
    );
    return {
      id,
      name,
      index,
      width,
      height,
      grid,
      desks: [],
      portals: [],
      spawn: { x: Math.floor(width / 2), y: Math.floor(height / 2) },
      zoneNames: new Map(),
    };
  }

  /** Convert a loaded FloorJSON into the editable paint model. */
  function floorFromJson(f: FloorJSON): FloorModel {
    const width = f.width;
    const height = f.height;
    const grid: CellKind[][] = Array.from({ length: height }, (_u, y) =>
      Array.from({ length: width }, (_u2, x) =>
        f.solid?.[y]?.[x] ? ("wall" as CellKind) : ("empty" as CellKind),
      ),
    );
    // Paint zones from areas (areas are walkable footprints).
    const zoneNames = new Map<string, string>();
    for (const a of f.areas ?? []) {
      const kind = areaTypeToCell(a);
      if (!kind) continue;
      for (let y = a.y; y < a.y + a.h; y++) {
        for (let x = a.x; x < a.x + a.w; x++) {
          if (y < 0 || x < 0 || y >= height || x >= width) continue;
          // Don't overwrite walls (zone perimeter walls stay walls).
          if (grid[y][x] !== "wall") grid[y][x] = kind;
        }
      }
      zoneNames.set(`${a.x},${a.y}`, a.name);
    }
    const desks: DeskMark[] = (f.desks ?? []).map((d) => ({
      x: d.x,
      y: d.y,
      department: d.department,
    }));
    return {
      id: f.id,
      name: f.name,
      index: f.index,
      width,
      height,
      grid,
      desks,
      portals: (f.portals ?? []).map((p) => ({ ...p })),
      spawn: { x: f.spawn.x, y: f.spawn.y },
      zoneNames,
    };
  }

  function areaTypeToCell(a: Area): ZoneCellKind | null {
    switch (a.type) {
      case "MEETING_ROOM":
        // Heuristic: small rooms named "Cabin*" map back to cabin tool.
        return a.name.toLowerCase().startsWith("cabin") ? "cabin" : "meeting";
      case "COFFEE":
        return "coffee";
      case "LOUNGE":
        return "lounge";
      case "RECEPTION":
        return "reception";
      case "DEPARTMENT":
        return null; // departments are represented by desks, not a paint cell
    }
  }

  function buildingFromJson(j: BuildingJSON): BuildingModel {
    const floors = [...j.floors]
      .sort((a, b) => a.index - b.index)
      .map((f) => floorFromJson(f));
    return { id: j.id, name: j.name, floors };
  }

  // -------------------------------------------------------------------------
  // Serialization -> BuildingJSON (parseBuilding format)
  // -------------------------------------------------------------------------

  function serializeFloor(f: FloorModel): FloorJSON {
    const { width, height, grid } = f;

    // solid: walls only (zones/desks-seats are walkable; desk bodies are solid).
    const solid: boolean[][] = Array.from({ length: height }, (_u, y) =>
      Array.from({ length: width }, (_u2, x) => grid[y][x] === "wall"),
    );

    const walls: TilePos[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (grid[y][x] === "wall") walls.push({ x, y });
      }
    }

    const furniture: Furniture[] = [];
    const desks: Desk[] = [];
    const anchors: Record<string, TilePos[]> = {};

    // Desks: a 2x1 desk body (solid) + a walkable seat below.
    for (const d of f.desks) {
      const seatY = d.y + 1;
      if (d.x < 0 || d.y < 0 || d.x + 1 >= width || seatY >= height) continue;
      desks.push({ x: d.x, y: d.y, seatX: d.x, seatY, department: d.department });
      furniture.push({ kind: deptDeskKind(d.department), x: d.x, y: d.y, w: 2, h: 1, solid: true });
      // Mark desk body solid in the grid-derived collision too.
      solid[d.y][d.x] = true;
      if (d.x + 1 < width) solid[d.y][d.x + 1] = true;
      // Seat stays walkable.
      if (seatY < height) solid[seatY][d.x] = false;
    }

    // Zones -> named Areas (group contiguous-rectangle by the painted region).
    const areas = deriveAreas(f, anchors);

    // Portal tiles render an "elevator" furniture marker (non-solid).
    const portals: Portal[] = f.portals.map((p) => ({ ...p }));
    for (const p of portals) {
      if (p.x >= 0 && p.y >= 0 && p.x < width && p.y < height) {
        furniture.push({ kind: "elevator", x: p.x, y: p.y, w: 1, h: 1, solid: false });
        solid[p.y][p.x] = false; // portal tile must be walkable
      }
    }

    // Spawn must be walkable.
    return {
      id: f.id,
      name: f.name,
      index: f.index,
      width,
      height,
      areas,
      desks,
      furniture,
      walls,
      solid,
      anchors,
      spawn: { x: f.spawn.x, y: f.spawn.y },
      portals,
    };
  }

  /**
   * Derive named Area rectangles from painted zone cells. Each connected zone
   * region of the SAME kind becomes one Area, using the user-given name (keyed
   * by the region's top-left tile) or a default label. Also fills anchors with
   * the walkable interior tiles of the region (used for event/meeting seating).
   */
  function deriveAreas(f: FloorModel, anchors: Record<string, TilePos[]>): Area[] {
    const { width, height, grid } = f;
    const seen: boolean[][] = Array.from({ length: height }, () =>
      Array<boolean>(width).fill(false),
    );
    const areas: Area[] = [];
    const usedNames = new Set<string>();

    const isZone = (k: CellKind): k is ZoneCellKind =>
      k === "meeting" || k === "coffee" || k === "lounge" || k === "reception" || k === "cabin";

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const k = grid[y][x];
        if (seen[y][x] || !isZone(k)) continue;
        // Flood-fill the connected region of identical kind.
        const region: TilePos[] = [];
        const stack: TilePos[] = [{ x, y }];
        let minX = x;
        let minY = y;
        let maxX = x;
        let maxY = y;
        while (stack.length) {
          const t = stack.pop()!;
          if (t.x < 0 || t.y < 0 || t.x >= width || t.y >= height) continue;
          if (seen[t.y][t.x] || grid[t.y][t.x] !== k) continue;
          seen[t.y][t.x] = true;
          region.push(t);
          minX = Math.min(minX, t.x);
          minY = Math.min(minY, t.y);
          maxX = Math.max(maxX, t.x);
          maxY = Math.max(maxY, t.y);
          stack.push({ x: t.x + 1, y: t.y }, { x: t.x - 1, y: t.y }, { x: t.x, y: t.y + 1 }, { x: t.x, y: t.y - 1 });
        }
        const key = `${minX},${minY}`;
        let name = f.zoneNames.get(key) || ZONE_LABEL[k];
        // De-dupe names so multiple unnamed zones of one kind stay distinct.
        let suffix = 2;
        const baseName = name;
        while (usedNames.has(name)) name = `${baseName} ${suffix++}`;
        usedNames.add(name);

        areas.push({
          name,
          type: ZONE_AREA_TYPE[k],
          x: minX,
          y: minY,
          w: maxX - minX + 1,
          h: maxY - minY + 1,
        });
        // Anchors = the walkable tiles of the region (cap to a sensible number).
        anchors[name] = region
          .filter((t) => grid[t.y][t.x] !== "wall")
          .slice(0, 16)
          .map((t) => ({ x: t.x, y: t.y }));
      }
    }
    return areas;
  }

  function serializeBuildingModel(b: BuildingModel): BuildingJSON {
    return {
      id: b.id,
      name: b.name,
      floors: b.floors.map((f) => serializeFloor(f)),
    };
  }

  function deptDeskKind(dept: Department): FurnitureKind {
    switch (dept) {
      case "Engineering":
        return "desk-engineering";
      case "Product":
        return "desk-product";
      case "Design":
        return "desk-design";
      case "HR":
        return "desk-hr";
      default:
        return "desk";
    }
  }

  // -------------------------------------------------------------------------
  // Local validation (mirrors parseBuilding's rules so errors show inline)
  // -------------------------------------------------------------------------

  function validateLocal(json: BuildingJSON): BuildingValidationError[] {
    const errs: BuildingValidationError[] = [];
    if (!json.id || json.id.trim() === "") {
      errs.push({ code: "BAD_ID", message: "Building needs a non-empty id" });
    }
    if (!json.floors.length) {
      errs.push({ code: "NO_FLOORS", message: "Building needs at least one floor" });
      return errs;
    }
    const ids = new Set<string>();
    const byId = new Map<string, FloorJSON>();
    for (const f of json.floors) {
      if (!f.id || f.id.trim() === "") {
        errs.push({ code: "BAD_FLOOR_ID", message: "A floor has an empty id" });
        continue;
      }
      if (ids.has(f.id)) {
        errs.push({ code: "DUP_FLOOR_ID", message: `Duplicate floor id "${f.id}"`, floorId: f.id });
        continue;
      }
      ids.add(f.id);
      byId.set(f.id, f);
    }
    for (const f of json.floors) {
      const onGrid = (x: number, y: number) => x >= 0 && y >= 0 && x < f.width && y < f.height;
      if (!onGrid(f.spawn.x, f.spawn.y) || f.solid[f.spawn.y]?.[f.spawn.x] === true) {
        errs.push({
          code: "BAD_SPAWN",
          message: `Floor "${f.name}": spawn point must sit on a walkable (non-wall) tile`,
          floorId: f.id,
        });
      }
      for (const p of f.portals) {
        if (!onGrid(p.x, p.y)) {
          errs.push({
            code: "BAD_PORTAL_TILE",
            message: `Floor "${f.name}": a portal is off the grid`,
            floorId: f.id,
          });
          continue;
        }
        const target = byId.get(p.toFloorId);
        if (!target) {
          errs.push({
            code: "PORTAL_TARGET_MISSING",
            message: `Floor "${f.name}": portal targets unknown floor "${p.toFloorId}"`,
            floorId: f.id,
          });
          continue;
        }
        const tOnGrid = p.toX >= 0 && p.toY >= 0 && p.toX < target.width && p.toY < target.height;
        if (!tOnGrid || target.solid[p.toY]?.[p.toX] === true) {
          errs.push({
            code: "PORTAL_TARGET_BLOCKED",
            message: `Floor "${f.name}": portal lands on a wall/off-grid tile of "${target.name}"`,
            floorId: f.id,
          });
        }
      }
    }
    return errs;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function renderAll(): void {
    renderBuildingName();
    renderTabs();
    renderSide();
    renderCanvas();
    renderStatus();
  }

  function renderBuildingName(): void {
    const span = title.querySelector(".ms-building-name") as HTMLElement;
    span.textContent = state.building ? `— ${state.building.name}` : "";
  }

  function renderTabs(): void {
    tabs.innerHTML = "";
    if (!state.building) return;
    const errFloorIds = new Set(state.validationErrors.map((e) => e.floorId).filter(Boolean) as string[]);
    state.building.floors.forEach((f, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ms-tab" + (i === state.activeFloorIdx ? " ms-tab-active" : "");
      if (errFloorIds.has(f.id)) btn.classList.add("ms-tab-error");
      btn.textContent = f.name;
      btn.addEventListener("click", () => {
        state.activeFloorIdx = i;
        state.selectedZoneKey = null;
        renderAll();
      });
      tabs.appendChild(btn);
    });
  }

  function renderSide(): void {
    side.innerHTML = "";
    const floor = activeFloor();

    // --- Tool palette ---
    const palSection = document.createElement("div");
    const palTitle = document.createElement("p");
    palTitle.className = "ms-section-title";
    palTitle.textContent = "Tools";
    const palette = document.createElement("div");
    palette.className = "ms-palette";
    for (const t of TOOLS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ms-tool" + (state.tool === t.id ? " ms-tool-active" : "");
      const sw = document.createElement("span");
      sw.className = "ms-swatch";
      sw.style.background = t.color;
      const lbl = document.createElement("span");
      lbl.textContent = t.label;
      const key = document.createElement("span");
      key.className = "ms-key";
      key.textContent = t.key;
      b.append(sw, lbl, key);
      b.addEventListener("click", () => {
        state.tool = t.id;
        renderSide();
        renderCanvas();
      });
      palette.appendChild(b);
    }
    palSection.append(palTitle, palette);
    side.appendChild(palSection);

    // --- Tool-specific properties ---
    const propSection = document.createElement("div");
    const propTitle = document.createElement("p");
    propTitle.className = "ms-section-title";
    propTitle.textContent = "Properties";
    propSection.appendChild(propTitle);
    const props = document.createElement("div");
    props.className = "ms-props";
    propSection.appendChild(props);

    if (state.tool === "desk") {
      props.appendChild(
        selectField("Department", DEPARTMENTS as readonly string[], state.deskDept, (v) => {
          state.deskDept = v as Department;
        }),
      );
      props.appendChild(hint("Paint a desk: a 2-wide desk with a walkable seat below it."));
    } else if (state.tool === "portal") {
      const targets = (state.building?.floors ?? [])
        .filter((f) => f.id !== floor?.id)
        .map((f) => f.id);
      if (!state.portalTargetFloorId && targets[0]) state.portalTargetFloorId = targets[0];
      if (targets.length === 0) {
        props.appendChild(hint("Add a second floor first — a portal needs a target floor."));
      } else {
        props.appendChild(
          selectField("Target floor", targets, state.portalTargetFloorId, (v) => {
            state.portalTargetFloorId = v;
          }),
        );
        props.appendChild(
          hint(
            "Click a tile to place an elevator. Its arrival tile is the target floor's spawn (edit later by repainting that floor's spawn).",
          ),
        );
      }
    } else if (state.selectedZoneKey && floor) {
      // Zone naming for a clicked zone.
      const name = floor.zoneNames.get(state.selectedZoneKey) || "";
      props.appendChild(
        textField("Zone name", name, (v) => {
          if (!floor) return;
          floor.zoneNames.set(state.selectedZoneKey!, v);
          revalidate();
          renderCanvas();
        }),
      );
      props.appendChild(hint("Naming the zone at " + state.selectedZoneKey + "."));
    } else {
      props.appendChild(hint(toolHint(state.tool)));
    }
    side.appendChild(propSection);

    // --- Floor meta ---
    if (floor) {
      const metaSection = document.createElement("div");
      const metaTitle = document.createElement("p");
      metaTitle.className = "ms-section-title";
      metaTitle.textContent = "Floor";
      const meta = document.createElement("div");
      meta.className = "ms-floor-meta";
      meta.appendChild(
        textField("Name", floor.name, (v) => {
          floor.name = v || floor.id;
          renderTabs();
          revalidate();
        }),
      );
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "ms-btn ms-danger";
      delBtn.textContent = "Delete this floor";
      delBtn.disabled = (state.building?.floors.length ?? 0) <= 1;
      delBtn.addEventListener("click", () => {
        if (!state.building || state.building.floors.length <= 1) return;
        state.building.floors.splice(state.activeFloorIdx, 1);
        state.building.floors.forEach((fl, i) => (fl.index = i));
        state.activeFloorIdx = Math.max(0, state.activeFloorIdx - 1);
        revalidate();
        renderAll();
      });
      meta.appendChild(delBtn);
      metaSection.append(metaTitle, meta);
      side.appendChild(metaSection);
    }

    // --- Legend ---
    const legSection = document.createElement("div");
    const legTitle = document.createElement("p");
    legTitle.className = "ms-section-title";
    legTitle.textContent = "Legend";
    const legend = document.createElement("div");
    legend.className = "ms-legend";
    for (const t of TOOLS) {
      if (t.id === "eraser" || t.id === "floor") continue;
      const row = document.createElement("div");
      row.className = "ms-legend-row";
      const sw = document.createElement("span");
      sw.className = "ms-swatch";
      sw.style.background = t.color;
      const lbl = document.createElement("span");
      lbl.textContent = t.label;
      row.append(sw, lbl);
      legend.appendChild(row);
    }
    legSection.append(legTitle, legend);
    side.appendChild(legSection);
  }

  function toolHint(tool: ToolId): string {
    switch (tool) {
      case "floor":
        return "Drag to clear tiles back to open, walkable floor.";
      case "wall":
        return "Drag to paint solid walls. Right-click or Eraser to remove.";
      case "spawn":
        return "Click to set the fallback spawn point (must be walkable).";
      case "eraser":
        return "Drag to erase tiles, desks, portals back to empty floor.";
      default:
        return "Drag to paint this zone. Click a painted zone to name it.";
    }
  }

  function selectField(
    label: string,
    options: readonly string[],
    value: string,
    onChange: (v: string) => void,
  ): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ms-field";
    const lab = document.createElement("label");
    lab.textContent = label;
    const sel = document.createElement("select");
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = o;
      opt.textContent = o;
      if (o === value) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => onChange(sel.value));
    wrap.append(lab, sel);
    return wrap;
  }

  function textField(label: string, value: string, onChange: (v: string) => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ms-field";
    const lab = document.createElement("label");
    lab.textContent = label;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = value;
    inp.addEventListener("input", () => onChange(inp.value));
    wrap.append(lab, inp);
    return wrap;
  }

  function hint(text: string): HTMLElement {
    const p = document.createElement("p");
    p.className = "ms-hint";
    p.textContent = text;
    return p;
  }

  function renderCanvas(): void {
    const floor = activeFloor();
    if (!floor) {
      canvas.width = 1;
      canvas.height = 1;
      return;
    }
    const w = floor.width * TILE_PX;
    const h = floor.height * TILE_PX;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;

    // Base cells.
    for (let y = 0; y < floor.height; y++) {
      for (let x = 0; x < floor.width; x++) {
        ctx.fillStyle = cellColor(floor.grid[y][x]);
        ctx.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
      }
    }

    // Grid lines.
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= floor.width; x++) {
      ctx.beginPath();
      ctx.moveTo(x * TILE_PX + 0.5, 0);
      ctx.lineTo(x * TILE_PX + 0.5, h);
      ctx.stroke();
    }
    for (let y = 0; y <= floor.height; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * TILE_PX + 0.5);
      ctx.lineTo(w, y * TILE_PX + 0.5);
      ctx.stroke();
    }

    // Desks (2x1 body + seat marker).
    for (const d of floor.desks) {
      ctx.fillStyle = TOOLS.find((t) => t.id === "desk")!.color;
      ctx.fillRect(d.x * TILE_PX, d.y * TILE_PX, TILE_PX * 2, TILE_PX);
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillRect(d.x * TILE_PX + 3, (d.y + 1) * TILE_PX + 3, TILE_PX - 6, TILE_PX - 6);
    }

    // Portals.
    for (const p of floor.portals) {
      ctx.fillStyle = TOOLS.find((t) => t.id === "portal")!.color;
      ctx.fillRect(p.x * TILE_PX + 2, p.y * TILE_PX + 2, TILE_PX - 4, TILE_PX - 4);
      ctx.fillStyle = "#fff";
      ctx.font = `${TILE_PX - 4}px monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("⇅", p.x * TILE_PX + TILE_PX / 2, p.y * TILE_PX + TILE_PX / 2 + 1);
    }

    // Spawn.
    ctx.fillStyle = TOOLS.find((t) => t.id === "spawn")!.color;
    ctx.beginPath();
    ctx.arc(
      floor.spawn.x * TILE_PX + TILE_PX / 2,
      floor.spawn.y * TILE_PX + TILE_PX / 2,
      TILE_PX / 2 - 2,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.fillStyle = "#0a0d14";
    ctx.font = `${TILE_PX - 6}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("S", floor.spawn.x * TILE_PX + TILE_PX / 2, floor.spawn.y * TILE_PX + TILE_PX / 2 + 1);

    // Zone name labels (top-left of each named zone region).
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = "10px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    for (const [key, name] of floor.zoneNames) {
      const [zx, zy] = key.split(",").map(Number);
      // Only show if that tile is still a zone tile.
      const k = floor.grid[zy]?.[zx];
      if (k && k !== "empty" && k !== "wall") {
        ctx.fillText(name, zx * TILE_PX + 2, zy * TILE_PX + 1);
      }
    }
  }

  function renderStatus(): void {
    errorsList.innerHTML = "";
    if (state.loading) {
      status.className = "ms-status";
      status.textContent = "Loading active building…";
      return;
    }
    if (state.loadError) {
      status.className = "ms-status ms-err";
      status.textContent = state.loadError;
      return;
    }
    if (state.validationErrors.length === 0) {
      status.className = "ms-status ms-ok";
      status.textContent = state.building
        ? "Valid — ready to save & activate."
        : "Open to load the active building.";
      return;
    }
    status.className = "ms-status ms-err";
    status.textContent = `${state.validationErrors.length} validation error(s):`;
    for (const e of state.validationErrors) {
      const li = document.createElement("li");
      li.textContent = e.message;
      errorsList.appendChild(li);
    }
  }

  function revalidate(): void {
    if (!state.building) {
      state.validationErrors = [];
      return;
    }
    state.validationErrors = validateLocal(serializeBuildingModel(state.building));
    renderStatus();
    renderTabs();
  }

  // -------------------------------------------------------------------------
  // Painting
  // -------------------------------------------------------------------------

  function eventTile(ev: MouseEvent): TilePos | null {
    const floor = activeFloor();
    if (!floor) return null;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    const px = (ev.clientX - rect.left) * sx;
    const py = (ev.clientY - rect.top) * sy;
    const x = Math.floor(px / TILE_PX);
    const y = Math.floor(py / TILE_PX);
    if (x < 0 || y < 0 || x >= floor.width || y >= floor.height) return null;
    return { x, y };
  }

  function applyTool(t: TilePos, erase: boolean): void {
    const floor = activeFloor();
    if (!floor) return;
    const tool = erase ? "eraser" : state.tool;

    switch (tool) {
      case "eraser":
        floor.grid[t.y][t.x] = "empty";
        removeDeskAt(floor, t);
        removePortalAt(floor, t);
        clearZoneName(floor, t);
        break;
      case "floor":
        floor.grid[t.y][t.x] = "empty";
        removeDeskAt(floor, t);
        removePortalAt(floor, t);
        break;
      case "wall":
        floor.grid[t.y][t.x] = "wall";
        removeDeskAt(floor, t);
        removePortalAt(floor, t);
        break;
      case "meeting":
      case "coffee":
      case "lounge":
      case "reception":
      case "cabin":
        floor.grid[t.y][t.x] = tool;
        break;
      case "desk":
        placeDesk(floor, t);
        break;
      case "portal":
        placePortal(floor, t);
        break;
      case "spawn":
        floor.spawn = { x: t.x, y: t.y };
        break;
    }
  }

  function placeDesk(floor: FloorModel, t: TilePos): void {
    // A desk needs its body (2 wide) and a seat below to be on-grid.
    if (t.x + 1 >= floor.width || t.y + 1 >= floor.height) return;
    // Avoid duplicates at the same origin.
    if (floor.desks.some((d) => d.x === t.x && d.y === t.y)) return;
    floor.grid[t.y][t.x] = "empty";
    floor.grid[t.y][t.x + 1] = "empty";
    floor.grid[t.y + 1][t.x] = "empty";
    floor.desks.push({ x: t.x, y: t.y, department: state.deskDept });
  }

  function removeDeskAt(floor: FloorModel, t: TilePos): void {
    floor.desks = floor.desks.filter(
      (d) => !((d.x === t.x || d.x + 1 === t.x) && d.y === t.y) && !(d.x === t.x && d.y + 1 === t.y),
    );
  }

  function placePortal(floor: FloorModel, t: TilePos): void {
    if (!state.portalTargetFloorId) return;
    const target = state.building?.floors.find((f) => f.id === state.portalTargetFloorId);
    if (!target) return;
    // Portal tile must be walkable.
    floor.grid[t.y][t.x] = "empty";
    // Don't double-place.
    if (floor.portals.some((p) => p.x === t.x && p.y === t.y)) return;
    floor.portals.push({
      x: t.x,
      y: t.y,
      kind: "elevator",
      toFloorId: target.id,
      toX: target.spawn.x,
      toY: target.spawn.y,
      label: `Elevator → ${target.name}`,
    });
  }

  function removePortalAt(floor: FloorModel, t: TilePos): void {
    floor.portals = floor.portals.filter((p) => !(p.x === t.x && p.y === t.y));
  }

  function clearZoneName(floor: FloorModel, t: TilePos): void {
    floor.zoneNames.delete(`${t.x},${t.y}`);
  }

  /** A click selects a zone for naming (when not in a paint-drag). */
  function maybeSelectZone(t: TilePos): void {
    const floor = activeFloor();
    if (!floor) return;
    const k = floor.grid[t.y][t.x];
    if (k === "empty" || k === "wall") {
      state.selectedZoneKey = null;
      return;
    }
    // Find the region's top-left by flood-fill min.
    const seen = new Set<string>();
    const stack: TilePos[] = [t];
    let minX = t.x;
    let minY = t.y;
    while (stack.length) {
      const c = stack.pop()!;
      const id = `${c.x},${c.y}`;
      if (seen.has(id)) continue;
      if (c.x < 0 || c.y < 0 || c.x >= floor.width || c.y >= floor.height) continue;
      if (floor.grid[c.y][c.x] !== k) continue;
      seen.add(id);
      if (c.y < minY || (c.y === minY && c.x < minX)) {
        minX = c.x;
        minY = c.y;
      }
      stack.push({ x: c.x + 1, y: c.y }, { x: c.x - 1, y: c.y }, { x: c.x, y: c.y + 1 }, { x: c.x, y: c.y - 1 });
    }
    state.selectedZoneKey = `${minX},${minY}`;
  }

  // Canvas mouse handlers.
  canvas.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    const t = eventTile(ev);
    if (!t) return;
    state.painting = true;
    state.paintErase = ev.button === 2; // right-click erases
    // A single click with a zone tool / on a zone offers naming via selection,
    // but only when the tool is not actively a zone painter and not erasing.
    applyTool(t, state.paintErase);
    if (
      !state.paintErase &&
      (state.tool === "meeting" ||
        state.tool === "coffee" ||
        state.tool === "lounge" ||
        state.tool === "reception" ||
        state.tool === "cabin")
    ) {
      maybeSelectZone(t);
    }
    revalidate();
    renderCanvas();
    renderSide();
  });
  canvas.addEventListener("mousemove", (ev) => {
    if (!state.painting) return;
    const t = eventTile(ev);
    if (!t) return;
    applyTool(t, state.paintErase);
    renderCanvas();
  });
  const endPaint = () => {
    if (!state.painting) return;
    state.painting = false;
    revalidate();
  };
  canvas.addEventListener("mouseup", endPaint);
  canvas.addEventListener("mouseleave", endPaint);
  // Clicking (without dragging) a zone with a non-paint selection selects it.
  canvas.addEventListener("click", (ev) => {
    const t = eventTile(ev);
    if (!t) return;
    const k = activeFloor()?.grid[t.y][t.x];
    if (k && k !== "empty" && k !== "wall") {
      maybeSelectZone(t);
      renderSide();
      renderCanvas();
    }
  });
  canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

  // -------------------------------------------------------------------------
  // REST: load / save / activate
  // -------------------------------------------------------------------------

  function authHeaders(base: Record<string, string> = {}): Record<string, string> {
    let token: string | null = null;
    try {
      token = sessionStorage.getItem("pixeloffice.token");
    } catch {
      token = null;
    }
    return token ? { ...base, Authorization: `Bearer ${token}` } : { ...base };
  }

  async function loadActive(): Promise<void> {
    state.loading = true;
    state.loadError = null;
    renderStatus();
    try {
      const res = await fetch(`${serverHttpBase()}/api/maps/active`, { headers: authHeaders() });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `Could not load active map (${res.status}).`);
      }
      const data = (await res.json()) as { building: BuildingJSON };
      state.building = buildingFromJson(data.building);
      state.activeFloorIdx = 0;
      state.portalTargetFloorId = "";
      revalidate();
    } catch (err) {
      state.loadError = `Network error: ${(err as Error).message}`;
    } finally {
      state.loading = false;
      renderAll();
    }
  }

  async function saveAndActivate(): Promise<void> {
    if (!state.building) return;
    const json = serializeBuildingModel(state.building);
    const localErrs = validateLocal(json);
    state.validationErrors = localErrs;
    if (localErrs.length > 0) {
      renderStatus();
      renderTabs();
      return;
    }

    saveBtn.disabled = true;
    testBtn.disabled = true;
    status.className = "ms-status";
    status.textContent = "Saving…";
    try {
      const saveRes = await fetch(`${serverHttpBase()}/api/maps`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(json),
      });
      if (saveRes.status === 400) {
        const body = (await saveRes.json().catch(() => null)) as
          | { error?: string; details?: BuildingValidationError[] }
          | null;
        state.validationErrors = body?.details ?? [
          { code: "SAVE_400", message: body?.error || "Server rejected the building." },
        ];
        renderStatus();
        renderTabs();
        return;
      }
      if (!saveRes.ok) {
        const body = (await saveRes.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `Save failed (${saveRes.status}).`);
      }
      const saved = (await saveRes.json()) as { id: string };

      const actRes = await fetch(`${serverHttpBase()}/api/maps/${encodeURIComponent(saved.id)}/activate`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!actRes.ok) {
        const body = (await actRes.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `Activate failed (${actRes.status}).`);
      }
      status.className = "ms-status ms-ok";
      status.textContent = "Live — rejoin to see changes. (New joins get the new map; live players keep their session.)";
    } catch (err) {
      status.className = "ms-status ms-err";
      status.textContent = `Error: ${(err as Error).message}`;
    } finally {
      saveBtn.disabled = false;
      testBtn.disabled = false;
    }
  }

  // "Test (preview)" = save + activate so a fresh join previews it. Same flow,
  // different copy (a full live hot-swap is out of scope per the contract).
  async function testPreview(): Promise<void> {
    await saveAndActivate();
    if (state.validationErrors.length === 0 && !state.loadError) {
      status.className = "ms-status ms-ok";
      status.textContent = "Preview activated — open a fresh session (rejoin) to walk the new map.";
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  addFloorBtn.addEventListener("click", () => {
    if (!state.building) return;
    const index = state.building.floors.length;
    let id = `floor-${index}`;
    const existing = new Set(state.building.floors.map((f) => f.id));
    let n = index;
    while (existing.has(id)) id = `floor-${++n}`;
    const name = index === 0 ? "Ground Floor" : `Floor ${index}`;
    state.building.floors.push(blankFloor(id, name, index));
    state.activeFloorIdx = state.building.floors.length - 1;
    state.selectedZoneKey = null;
    revalidate();
    renderAll();
  });

  testBtn.addEventListener("click", () => void testPreview());
  saveBtn.addEventListener("click", () => void saveAndActivate());
  closeBtn.addEventListener("click", () => handle.close());
  backdrop.addEventListener("mousedown", (ev) => {
    if (ev.target === backdrop) handle.close();
  });

  function onKey(ev: KeyboardEvent): void {
    if (backdrop.hidden) return;
    if (ev.key === "Escape") {
      handle.close();
      return;
    }
    // Don't hijack typing in inputs.
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) {
      return;
    }
    const toolId = TOOL_BY_KEY.get(ev.key.toLowerCase());
    if (toolId) {
      state.tool = toolId;
      renderSide();
      renderCanvas();
    }
  }
  document.addEventListener("keydown", onKey);

  // -------------------------------------------------------------------------
  // Handle
  // -------------------------------------------------------------------------

  const handle: MapStudioHandle = {
    open() {
      backdrop.hidden = false;
      if (!state.building && !state.loading) void loadActive();
      else renderAll();
    },
    close() {
      backdrop.hidden = true;
    },
    destroy() {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      trigger?.remove();
    },
  };

  return handle;
}
