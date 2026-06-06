// ---------------------------------------------------------------------------
// The office map: areas, walls, furniture, desks, collision grid, anchors.
// Pure data + pure functions. The client renders it; the server validates
// movement, assigns desks, and seats people at event/meeting anchors.
// All coordinates are TILE coordinates. solid[y][x] indexing.
// ---------------------------------------------------------------------------

import type { Department } from "./types";

export const TILE = 32; // pixels per tile (client rendering)
export const MAP_W = 48; // tiles
export const MAP_H = 34; // tiles

export type AreaType = "RECEPTION" | "DEPARTMENT" | "MEETING_ROOM" | "COFFEE" | "LOUNGE";

export interface Area {
  name: string;
  type: AreaType;
  department?: Department;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Desk {
  /** Top-left tile of the 2x1 desk (solid). */
  x: number;
  y: number;
  /** The seat tile directly below the desk — walkable, used as spawn point. */
  seatX: number;
  seatY: number;
  department: Department;
}

export type FurnitureKind =
  | "desk"
  | "desk-engineering"
  | "desk-product"
  | "desk-design"
  | "desk-hr"
  | "chair"
  | "chair-engineering"
  | "chair-product"
  | "chair-design"
  | "chair-hr"
  | "table"
  | "sofa"
  | "plant"
  | "counter"
  | "coffee-machine"
  | "reception-desk"
  | "rug"
  | "door-mat"
  | "bookshelf"
  | "vending-machine"
  | "water-cooler"
  | "ping-pong-table"
  | "beanbag"
  | "whiteboard"
  | "desk-lamp"
  | "chess-table"
  | "arcade-cabinet";

export interface Furniture {
  kind: FurnitureKind;
  x: number;
  y: number;
  w: number;
  h: number;
  solid: boolean;
}

export interface TilePos {
  x: number;
  y: number;
}

export interface OfficeMap {
  width: number;
  height: number;
  areas: Area[];
  desks: Desk[];
  furniture: Furniture[];
  /** Every wall tile (border + meeting room walls), for rendering. */
  walls: TilePos[];
  /** solid[y][x] === true means the tile cannot be walked on. */
  solid: boolean[][];
  /**
   * Named standing spots used when a user JOINS an event or meeting
   * (only ever applied after an explicit user action — human agency).
   */
  anchors: Record<string, TilePos[]>;
  /** Fallback spawn (Reception) when no desk is free. */
  spawn: TilePos;
}

function rect(x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  return { x, y, w, h };
}

/** Perimeter tiles of a rect, minus door gaps. */
function perimeter(r: { x: number; y: number; w: number; h: number }, doors: TilePos[]): TilePos[] {
  const tiles: TilePos[] = [];
  const isDoor = (x: number, y: number) => doors.some((d) => d.x === x && d.y === y);
  for (let x = r.x; x < r.x + r.w; x++) {
    for (const y of [r.y, r.y + r.h - 1]) {
      if (!isDoor(x, y)) tiles.push({ x, y });
    }
  }
  for (let y = r.y + 1; y < r.y + r.h - 1; y++) {
    for (const x of [r.x, r.x + r.w - 1]) {
      if (!isDoor(x, y)) tiles.push({ x, y });
    }
  }
  return tiles;
}

let cached: OfficeMap | null = null;

export function buildOfficeMap(): OfficeMap {
  if (cached) return cached;

  const areas: Area[] = [
    { name: "Meeting Room A", type: "MEETING_ROOM", ...rect(1, 1, 9, 8) },
    { name: "Meeting Room B", type: "MEETING_ROOM", ...rect(11, 1, 10, 8) },
    { name: "Meeting Room C", type: "MEETING_ROOM", ...rect(22, 1, 11, 8) },
    { name: "Coffee Area", type: "COFFEE", ...rect(34, 1, 13, 11) },
    { name: "Engineering", type: "DEPARTMENT", department: "Engineering", ...rect(1, 10, 15, 11) },
    { name: "Product", type: "DEPARTMENT", department: "Product", ...rect(17, 10, 16, 11) },
    { name: "Lounge", type: "LOUNGE", ...rect(34, 13, 13, 12) },
    { name: "Design", type: "DEPARTMENT", department: "Design", ...rect(1, 22, 15, 10) },
    { name: "HR", type: "DEPARTMENT", department: "HR", ...rect(17, 22, 16, 6) },
    { name: "Reception", type: "RECEPTION", ...rect(17, 28, 30, 5) },
  ];

  // Meeting room walls with 2-tile door gaps on the bottom wall.
  const doorA: TilePos[] = [{ x: 4, y: 8 }, { x: 5, y: 8 }];
  const doorB: TilePos[] = [{ x: 15, y: 8 }, { x: 16, y: 8 }];
  const doorC: TilePos[] = [{ x: 26, y: 8 }, { x: 27, y: 8 }];

  const walls: TilePos[] = [];
  // Outer border (fully solid; the entrance is decorative — a door mat).
  for (let x = 0; x < MAP_W; x++) {
    walls.push({ x, y: 0 }, { x, y: MAP_H - 1 });
  }
  for (let y = 1; y < MAP_H - 1; y++) {
    walls.push({ x: 0, y }, { x: MAP_W - 1, y });
  }
  walls.push(...perimeter(rect(1, 1, 9, 8), doorA));
  walls.push(...perimeter(rect(11, 1, 10, 8), doorB));
  walls.push(...perimeter(rect(22, 1, 11, 8), doorC));

  // Desks: 2x1 solid desk with a walkable seat tile directly below.
  const desks: Desk[] = [];
  const deskRows: Array<{ department: Department; xs: number[]; ys: number[] }> = [
    { department: "Engineering", xs: [2, 5, 8, 11], ys: [12, 16] },
    { department: "Product", xs: [18, 21, 24, 27], ys: [12, 16] },
    { department: "Design", xs: [2, 5, 8, 11], ys: [24, 28] },
    { department: "HR", xs: [18, 21, 24, 27], ys: [24] },
  ];
  for (const row of deskRows) {
    for (const y of row.ys) {
      for (const x of row.xs) {
        desks.push({ x, y, seatX: x, seatY: y + 1, department: row.department });
      }
    }
  }

  const furniture: Furniture[] = [];
  // Department desks + chairs.
  for (const d of desks) {
    let deskKind: FurnitureKind = "desk";
    let chairKind: FurnitureKind = "chair";
    if (d.department === "Engineering") {
      deskKind = "desk-engineering";
      chairKind = "chair-engineering";
    } else if (d.department === "Product") {
      deskKind = "desk-product";
      chairKind = "chair-product";
    } else if (d.department === "Design") {
      deskKind = "desk-design";
      chairKind = "chair-design";
    } else if (d.department === "HR") {
      deskKind = "desk-hr";
      chairKind = "chair-hr";
    }
    furniture.push({ kind: deskKind, x: d.x, y: d.y, w: 2, h: 1, solid: true });
    furniture.push({ kind: chairKind, x: d.seatX, y: d.seatY, w: 1, h: 1, solid: false });
  }

  // Meeting rooms: tables, whiteboards on walls, and exactly 6 chairs around tables (two top, two bottom, one left, one right).
  const meetingRooms = [
    { tableX: 4, tableY: 4, w: 3, h: 2, boardX: 2 },
    { tableX: 14, tableY: 4, w: 4, h: 2, boardX: 12 },
    { tableX: 25, tableY: 4, w: 5, h: 2, boardX: 23 }
  ];
  for (const r of meetingRooms) {
    furniture.push({ kind: "table", x: r.tableX, y: r.tableY, w: r.w, h: r.h, solid: true });
    furniture.push({ kind: "whiteboard", x: r.boardX, y: 1, w: 2, h: 1, solid: true });
    
    // Add exactly two chairs at the top of the table (at corners)
    furniture.push({ kind: "chair", x: r.tableX, y: r.tableY - 1, w: 1, h: 1, solid: false });
    furniture.push({ kind: "chair", x: r.tableX + r.w - 1, y: r.tableY - 1, w: 1, h: 1, solid: false });
    
    // Add exactly two chairs at the bottom of the table (at corners)
    furniture.push({ kind: "chair", x: r.tableX, y: r.tableY + r.h, w: 1, h: 1, solid: false });
    furniture.push({ kind: "chair", x: r.tableX + r.w - 1, y: r.tableY + r.h, w: 1, h: 1, solid: false });
    
    // Add exactly one chair on the left end
    furniture.push({ kind: "chair", x: r.tableX - 1, y: r.tableY, w: 1, h: 1, solid: false });
    
    // Add exactly one chair on the right end
    furniture.push({ kind: "chair", x: r.tableX + r.w, y: r.tableY, w: 1, h: 1, solid: false });
  }

  // Coffee area: counter along the top with machines, standing tables, plants, water cooler, and vending machine.
  furniture.push({ kind: "counter", x: 35, y: 2, w: 11, h: 1, solid: true });
  furniture.push({ kind: "coffee-machine", x: 36, y: 2, w: 1, h: 1, solid: true });
  furniture.push({ kind: "coffee-machine", x: 43, y: 2, w: 1, h: 1, solid: true });
  furniture.push({ kind: "table", x: 37, y: 6, w: 2, h: 1, solid: true });
  furniture.push({ kind: "table", x: 42, y: 6, w: 2, h: 1, solid: true });
  furniture.push({ kind: "table", x: 37, y: 9, w: 2, h: 1, solid: true });
  furniture.push({ kind: "table", x: 42, y: 9, w: 2, h: 1, solid: true });
  furniture.push({ kind: "plant", x: 35, y: 10, w: 1, h: 1, solid: true });
  furniture.push({ kind: "plant", x: 45, y: 10, w: 1, h: 1, solid: true });
  furniture.push({ kind: "water-cooler", x: 35, y: 6, w: 1, h: 1, solid: true });
  furniture.push({ kind: "vending-machine", x: 45, y: 6, w: 1, h: 1, solid: true });

  // Lounge: sofas around a rug, coffee table, plants, beanbags, bookshelves, and a ping pong table.
  furniture.push({ kind: "rug", x: 37, y: 16, w: 4, h: 3, solid: false });
  furniture.push({ kind: "sofa", x: 36, y: 15, w: 3, h: 1, solid: true });
  furniture.push({ kind: "sofa", x: 36, y: 19, w: 3, h: 1, solid: true });
  furniture.push({ kind: "sofa", x: 42, y: 16, w: 1, h: 3, solid: true });
  furniture.push({ kind: "table", x: 39, y: 17, w: 1, h: 1, solid: true });
  furniture.push({ kind: "plant", x: 35, y: 13, w: 1, h: 1, solid: true });
  furniture.push({ kind: "plant", x: 45, y: 13, w: 1, h: 1, solid: true });
  furniture.push({ kind: "plant", x: 35, y: 23, w: 1, h: 1, solid: true });
  furniture.push({ kind: "plant", x: 45, y: 23, w: 1, h: 1, solid: true });
  // New Lounge Items:
  furniture.push({ kind: "bookshelf", x: 35, y: 14, w: 1, h: 1, solid: true });
  furniture.push({ kind: "bookshelf", x: 45, y: 14, w: 1, h: 1, solid: true });
  furniture.push({ kind: "beanbag", x: 36, y: 17, w: 1, h: 1, solid: false });
  furniture.push({ kind: "beanbag", x: 41, y: 15, w: 1, h: 1, solid: false });
  furniture.push({ kind: "beanbag", x: 41, y: 19, w: 1, h: 1, solid: false });
  furniture.push({ kind: "ping-pong-table", x: 38, y: 21, w: 3, h: 2, solid: true });
  furniture.push({ kind: "arcade-cabinet", x: 35, y: 15, w: 1, h: 1, solid: true });
  furniture.push({ kind: "chess-table", x: 45, y: 15, w: 1, h: 1, solid: true });

  // HR Area: visitor chairs
  furniture.push({ kind: "chair-hr", x: 19, y: 23, w: 1, h: 1, solid: false });
  furniture.push({ kind: "chair-hr", x: 25, y: 23, w: 1, h: 1, solid: false });

  // Reception: front desk, plants, entrance mat, waiting sofa, coffee table, desk lamp, visitor chair.
  furniture.push({ kind: "reception-desk", x: 28, y: 29, w: 4, h: 1, solid: true });
  furniture.push({ kind: "plant", x: 18, y: 29, w: 1, h: 1, solid: true });
  furniture.push({ kind: "plant", x: 45, y: 29, w: 1, h: 1, solid: true });
  furniture.push({ kind: "door-mat", x: 31, y: 32, w: 2, h: 1, solid: false });
  furniture.push({ kind: "sofa", x: 20, y: 29, w: 3, h: 1, solid: true });
  furniture.push({ kind: "table", x: 23, y: 29, w: 1, h: 1, solid: true });
  furniture.push({ kind: "desk-lamp", x: 27, y: 29, w: 1, h: 1, solid: true });
  furniture.push({ kind: "chair", x: 25, y: 29, w: 1, h: 1, solid: false });

  // Populating empty areas inside departments (whiteboards, bookshelves, vending machines, water coolers)
  // Engineering right empty space (x: 13..15):
  furniture.push({ kind: "whiteboard", x: 13, y: 11, w: 2, h: 1, solid: true });
  furniture.push({ kind: "water-cooler", x: 14, y: 15, w: 1, h: 1, solid: true });
  // Product right empty space (x: 29..32):
  furniture.push({ kind: "bookshelf", x: 30, y: 11, w: 1, h: 1, solid: true });
  furniture.push({ kind: "whiteboard", x: 30, y: 15, w: 2, h: 1, solid: true });
  // Design right empty space (x: 13..15):
  furniture.push({ kind: "bookshelf", x: 14, y: 23, w: 1, h: 1, solid: true });
  furniture.push({ kind: "whiteboard", x: 13, y: 27, w: 2, h: 1, solid: true });
  // HR right empty space (x: 29..32):
  furniture.push({ kind: "vending-machine", x: 30, y: 23, w: 1, h: 1, solid: true });
  furniture.push({ kind: "water-cooler", x: 31, y: 23, w: 1, h: 1, solid: true });

  // Collision grid.
  const solid: boolean[][] = Array.from({ length: MAP_H }, () => Array<boolean>(MAP_W).fill(false));
  for (const w of walls) solid[w.y][w.x] = true;
  for (const f of furniture) {
    if (!f.solid) continue;
    for (let dy = 0; dy < f.h; dy++) {
      for (let dx = 0; dx < f.w; dx++) {
        solid[f.y + dy][f.x + dx] = true;
      }
    }
  }

  // Standing anchors for events and meetings (used only after explicit Join).
  const anchors: Record<string, TilePos[]> = {
    "Meeting Room A": [
      { x: 3, y: 3 }, { x: 5, y: 3 }, { x: 7, y: 3 },
      { x: 3, y: 6 }, { x: 5, y: 6 }, { x: 7, y: 6 },
      { x: 2, y: 4 }, { x: 8, y: 4 },
    ],
    "Meeting Room B": [
      { x: 13, y: 3 }, { x: 15, y: 3 }, { x: 17, y: 3 },
      { x: 13, y: 6 }, { x: 15, y: 6 }, { x: 17, y: 6 },
      { x: 12, y: 4 }, { x: 18, y: 4 }, { x: 19, y: 5 }, { x: 19, y: 3 },
    ],
    "Meeting Room C": [
      { x: 24, y: 3 }, { x: 26, y: 3 }, { x: 28, y: 3 }, { x: 30, y: 3 },
      { x: 24, y: 6 }, { x: 26, y: 6 }, { x: 28, y: 6 }, { x: 30, y: 6 },
      { x: 23, y: 4 }, { x: 31, y: 4 }, { x: 23, y: 5 }, { x: 31, y: 5 },
    ],
    "Coffee Area": [
      { x: 36, y: 6 }, { x: 39, y: 6 }, { x: 41, y: 6 }, { x: 44, y: 6 },
      { x: 36, y: 9 }, { x: 39, y: 9 }, { x: 41, y: 9 }, { x: 44, y: 9 },
      { x: 38, y: 4 }, { x: 42, y: 4 }, { x: 40, y: 7 }, { x: 40, y: 4 },
    ],
    Lounge: [
      { x: 36, y: 16 }, { x: 37, y: 16 }, { x: 38, y: 16 },
      { x: 36, y: 18 }, { x: 37, y: 18 }, { x: 38, y: 18 },
      { x: 40, y: 16 }, { x: 40, y: 18 }, { x: 41, y: 17 }, { x: 40, y: 17 },
      { x: 39, y: 21 }, { x: 41, y: 21 },
    ],
    Reception: [
      { x: 22, y: 31 }, { x: 24, y: 31 }, { x: 26, y: 31 }, { x: 28, y: 31 },
      { x: 30, y: 31 }, { x: 32, y: 31 }, { x: 34, y: 31 }, { x: 36, y: 31 },
      { x: 38, y: 31 }, { x: 40, y: 31 }, { x: 25, y: 30 }, { x: 35, y: 30 },
      { x: 21, y: 30 }, { x: 39, y: 30 }, { x: 23, y: 30 }, { x: 37, y: 30 },
    ],
  };

  cached = {
    width: MAP_W,
    height: MAP_H,
    areas,
    desks,
    furniture,
    walls,
    solid,
    anchors,
    spawn: { x: 31, y: 31 },
  };
  return cached;
}

/** The named area containing a tile, or null when standing in a hallway. */
export function areaAt(map: OfficeMap, x: number, y: number): Area | null {
  for (const a of map.areas) {
    if (x >= a.x && x < a.x + a.w && y >= a.y && y < a.y + a.h) return a;
  }
  return null;
}

export function isWalkable(map: OfficeMap, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  return !map.solid[y][x];
}

/** Pick the i-th anchor of an area, wrapping around when full. */
export function anchorFor(map: OfficeMap, areaName: string, index: number): TilePos {
  const list = map.anchors[areaName];
  if (!list || list.length === 0) return map.spawn;
  return list[index % list.length];
}
