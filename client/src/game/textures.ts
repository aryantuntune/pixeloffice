// ---------------------------------------------------------------------------
// Runtime texture + animation generation. NO external asset files.
// Everything is drawn into Phaser CanvasTextures via the 2D context, then
// registered in the texture manager. Drawing is data-driven (palette tables
// in constants.ts) so the six avatars share a single draw routine.
//
// Pure presentation: this module knows nothing about presence/meetings/etc.
// All generation happens ONCE at scene preload — no per-frame allocations.
// ---------------------------------------------------------------------------

import Phaser from "phaser";
import type { AreaType, Department, FurnitureKind } from "@pixeloffice/shared";
import { AVATAR_IDS, type AvatarId } from "@pixeloffice/shared";
import {
  AVATAR_PALETTES,
  COFFEE_FLOOR,
  DEPARTMENT_FLOOR,
  FLOOR_VARIANTS,
  type FloorStyle,
  type HairStyle,
  HALLWAY_FLOOR,
  LOUNGE_FLOOR,
  MEETING_FLOOR,
  RECEPTION_FLOOR,
  TILE,
  WALL_BASEBOARD,
  WALL_FRONT,
  WALL_FRONT_DARK,
  WALL_FRONT_LIGHT,
  WALL_OUTLINE,
  WALL_TOP,
  WALL_TOP_LIGHT,
  WINDOW_FRAME,
  WINDOW_FRAME_DARK,
  WINDOW_GLASS_SHEEN,
  WINDOW_SKY_BOTTOM,
  WINDOW_SKY_TOP,
} from "./constants";

// ---------------------------------------------------------------------------
// Texture key helpers (stable, referenced by the scene).
// ---------------------------------------------------------------------------

export const TEX = {
  hallwayFloor: "floor:hallway",
  receptionFloor: "floor:reception",
  meetingFloor: "floor:meeting",
  coffeeFloor: "floor:coffee",
  loungeFloor: "floor:lounge",
  departmentFloor: (d: Department) => `floor:dept:${d}`,
  /** Variation tile (0..FLOOR_VARIANTS-1) chosen deterministically by position. */
  floorVariant: (baseKey: string, variant: number) => `${baseKey}#${variant}`,
  wall: "tile:wall",
  wallWindow: "tile:wall:window",
  furniture: (kind: FurnitureKind) => `furn:${kind}`,
  /** Second flicker frame for furniture with a glowing screen / LED. */
  furnitureAlt: (kind: FurnitureKind) => `furn:${kind}#alt`,
  avatarSheet: (id: AvatarId) => `avatar:${id}`,
  /** Soft ellipse drop-shadow shared by every avatar. */
  shadow: "fx:shadow",
  /** Tiny steam wisp particle for coffee machines. */
  steam: "fx:steam",
  /** Dust puff particle for teleports. */
  dust: "fx:dust",
} as const;

/** Resolve the base floor texture key for an area. */
export function floorTextureForArea(type: AreaType, department?: Department): string {
  switch (type) {
    case "RECEPTION":
      return TEX.receptionFloor;
    case "MEETING_ROOM":
      return TEX.meetingFloor;
    case "COFFEE":
      return TEX.coffeeFloor;
    case "LOUNGE":
      return TEX.loungeFloor;
    case "DEPARTMENT":
      return department ? TEX.departmentFloor(department) : TEX.hallwayFloor;
    default:
      return TEX.hallwayFloor;
  }
}

/**
 * Pick a stable floor-variant texture key for a tile. Variation is chosen by
 * (x*7 + y*13) % FLOOR_VARIANTS so adjacent tiles differ and large floors do
 * not visibly band/repeat. Pure function — same input always same output.
 */
export function floorVariantForTile(baseKey: string, x: number, y: number): string {
  const v = ((x * 7 + y * 13) % FLOOR_VARIANTS + FLOOR_VARIANTS) % FLOOR_VARIANTS;
  return TEX.floorVariant(baseKey, v);
}

// ---------------------------------------------------------------------------
// Low-level canvas helpers.
// ---------------------------------------------------------------------------

function makeCanvas(
  scene: Phaser.Scene,
  key: string,
  w: number,
  h: number,
): { tex: Phaser.Textures.CanvasTexture; ctx: CanvasRenderingContext2D } {
  // Re-creating with the same key (e.g. hot reload) would throw; guard it.
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const tex = scene.textures.createCanvas(key, w, h) as Phaser.Textures.CanvasTexture;
  const ctx = tex.getContext();
  ctx.imageSmoothingEnabled = false;
  return { tex, ctx };
}

function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/** Deterministic pseudo-random so the floor grain is stable across redraws. */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2654435761) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Linear blend of two #rrggbb colours, t in [0,1]. */
function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ar = (pa >> 16) & 255, ag = (pa >> 8) & 255, ab = pa & 255;
  const br = (pb >> 16) & 255, bg = (pb >> 8) & 255, bb = pb & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}

// ---------------------------------------------------------------------------
// Floors: per-kind charming GBA office tiles, 3 deterministic variants each.
// ---------------------------------------------------------------------------

function drawCarpet(ctx: CanvasRenderingContext2D, style: FloorStyle, seed: number, variant: number): void {
  // Woven 2-tone carpet: alternating warp/weft pixels for fabric texture.
  px(ctx, 0, 0, TILE, TILE, style.light);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      // 2x2 weave block, offset every other row for an interlocked look.
      const on = ((x >> 1) + (y >> 1)) % 2 === 0;
      if (on) px(ctx, x, y, 1, 1, style.dark);
    }
  }
  // Fibre flecks: deterministic sprinkle of the fleck tone.
  for (let y = 0; y < TILE; y += 2) {
    for (let x = 0; x < TILE; x += 2) {
      if (hash(x, y, seed + variant) % 9 === 0) px(ctx, x, y, 1, 1, style.fleck);
    }
  }
  // Occasional accent fleck per variant (a tiny coloured tuft).
  if (variant !== 1) {
    const ax = 6 + (hash(variant, seed, 3) % 18);
    const ay = 6 + (hash(seed, variant, 7) % 18);
    px(ctx, ax, ay, 2, 2, style.accent);
  }
}

function drawWood(ctx: CanvasRenderingContext2D, style: FloorStyle, seed: number, variant: number): void {
  // Wood planks running horizontally with grain flecks + plank seam lines.
  const plankH = 8;
  for (let py = 0; py < TILE; py += plankH) {
    const row = py / plankH;
    const base = row % 2 === 0 ? style.light : mix(style.light, style.dark, 0.5);
    px(ctx, 0, py, TILE, plankH, base);
    // Plank seam (dark grout line at the top of each plank).
    px(ctx, 0, py, TILE, 1, style.accent);
    // Grain flecks streaking along the plank.
    for (let x = 0; x < TILE; x++) {
      const r = hash(x, py + variant * 3, seed);
      if (r % 13 === 0) px(ctx, x, py + 2 + (r % (plankH - 3)), 2, 1, style.dark);
      else if (r % 17 === 0) px(ctx, x, py + 1 + (r % (plankH - 2)), 1, 1, style.fleck);
    }
    // Stagger the vertical plank-end seam per row for a parquet feel.
    const seam = (row * 11 + variant * 7) % TILE;
    px(ctx, seam, py, 1, plankH, mix(style.accent, base, 0.4));
  }
}

function drawTileFloor(ctx: CanvasRenderingContext2D, style: FloorStyle, seed: number, variant: number): void {
  // Cool meeting-room tiles: large squares with grout lines + corner sheen.
  px(ctx, 0, 0, TILE, TILE, style.light);
  const grout = style.accent;
  // 2x2 grid of 16px tiles.
  const half = TILE / 2;
  for (let gy = 0; gy < 2; gy++) {
    for (let gx = 0; gx < 2; gx++) {
      const shade = (gx + gy + variant) % 2 === 0 ? style.light : style.dark;
      px(ctx, gx * half + 1, gy * half + 1, half - 1, half - 1, shade);
      // Top-left corner sheen on each tile.
      px(ctx, gx * half + 2, gy * half + 2, 4, 1, style.fleck);
      px(ctx, gx * half + 2, gy * half + 2, 1, 4, style.fleck);
    }
  }
  // Grout lines.
  px(ctx, 0, half - 1, TILE, 1, grout);
  px(ctx, half - 1, 0, 1, TILE, grout);
  px(ctx, 0, 0, TILE, 1, mix(grout, style.dark, 0.4));
  px(ctx, 0, 0, 1, TILE, mix(grout, style.dark, 0.4));
  // A couple of deterministic wear specks so tiles aren't perfectly clean.
  for (let i = 0; i < 3; i++) {
    const r = hash(i, variant, seed);
    px(ctx, 3 + (r % (TILE - 6)), 3 + ((r >> 8) % (TILE - 6)), 1, 1, style.fleck);
  }
}

function drawChecker(ctx: CanvasRenderingContext2D, style: FloorStyle, seed: number, variant: number): void {
  // Neutral hallway checker: 4x4 grid with subtle wear flecks.
  px(ctx, 0, 0, TILE, TILE, style.light);
  const cell = TILE / 4;
  for (let cy = 0; cy < 4; cy++) {
    for (let cx = 0; cx < 4; cx++) {
      if ((cx + cy) % 2 === 0) px(ctx, cx * cell, cy * cell, cell, cell, style.dark);
    }
  }
  for (let y = 0; y < TILE; y += 2) {
    for (let x = 0; x < TILE; x += 2) {
      if (hash(x, y, seed + variant) % 12 === 0) px(ctx, x, y, 1, 1, style.fleck);
    }
  }
  // A faint scuff streak that shifts per variant.
  if (variant === 2) px(ctx, 4 + (seed % 16), 20, 8, 1, style.accent);
}

function drawFloorVariant(
  scene: Phaser.Scene,
  baseKey: string,
  style: FloorStyle,
  seed: number,
  variant: number,
): void {
  const key = TEX.floorVariant(baseKey, variant);
  const { tex, ctx } = makeCanvas(scene, key, TILE, TILE);
  switch (style.kind) {
    case "carpet":
      drawCarpet(ctx, style, seed, variant);
      break;
    case "wood":
      drawWood(ctx, style, seed, variant);
      break;
    case "tile":
      drawTileFloor(ctx, style, seed, variant);
      break;
    case "checker":
      drawChecker(ctx, style, seed, variant);
      break;
  }
  // Faint inner border to imply a seam between tiles.
  ctx.strokeStyle = "rgba(0,0,0,0.06)";
  ctx.strokeRect(0.5, 0.5, TILE - 1, TILE - 1);
  tex.refresh();
}

function drawFloor(scene: Phaser.Scene, baseKey: string, style: FloorStyle, seed: number): void {
  for (let v = 0; v < FLOOR_VARIANTS; v++) {
    drawFloorVariant(scene, baseKey, style, seed, v);
  }
}

// ---------------------------------------------------------------------------
// Wall tiles: top-face / front-face split with highlight + shadow + baseboard.
// A window variant shows a soft sky gradient for the outer north wall.
// ---------------------------------------------------------------------------

function drawWallBase(ctx: CanvasRenderingContext2D): number {
  const topH = Math.floor(TILE * 0.34);
  // Front face (lower, darker).
  px(ctx, 0, 0, TILE, TILE, WALL_FRONT);
  // Subtle vertical brick shading on the front face.
  for (let y = topH; y < TILE; y += 8) px(ctx, 0, y, TILE, 1, WALL_FRONT_DARK);
  for (let x = 0; x < TILE; x += 16) px(ctx, x, topH, 1, TILE - topH, WALL_FRONT_DARK);
  for (let x = 8; x < TILE; x += 16) px(ctx, x, topH + 8, 1, 8, WALL_FRONT_DARK);
  // Highlight row right below the top lip (catches the light).
  px(ctx, 0, topH, TILE, 2, WALL_FRONT_LIGHT);
  // Baseboard / skirting at the floor line.
  px(ctx, 0, TILE - 3, TILE, 3, WALL_BASEBOARD);
  px(ctx, 0, TILE - 3, TILE, 1, mix(WALL_BASEBOARD, WALL_FRONT_LIGHT, 0.5));
  // Top highlight face.
  px(ctx, 0, 0, TILE, topH, WALL_TOP);
  px(ctx, 0, topH - 1, TILE, 1, WALL_TOP_LIGHT); // bright lip
  px(ctx, 0, 0, TILE, 1, mix(WALL_TOP, WALL_TOP_LIGHT, 0.6)); // top sheen
  return topH;
}

function drawWall(scene: Phaser.Scene): void {
  const { tex, ctx } = makeCanvas(scene, TEX.wall, TILE, TILE);
  drawWallBase(ctx);
  ctx.strokeStyle = WALL_OUTLINE;
  ctx.strokeRect(0.5, 0.5, TILE - 1, TILE - 1);
  tex.refresh();
}

function drawWindowWall(scene: Phaser.Scene): void {
  const { tex, ctx } = makeCanvas(scene, TEX.wallWindow, TILE, TILE);
  drawWallBase(ctx);
  // Carve a window into the front face: sky gradient behind a frame.
  const fx = 4, fy = 4, fw = TILE - 8, fh = TILE - 11;
  px(ctx, fx - 1, fy - 1, fw + 2, fh + 2, WINDOW_FRAME_DARK); // outer frame shadow
  px(ctx, fx, fy, fw, fh, WINDOW_FRAME); // frame
  const gx = fx + 2, gy = fy + 2, gw = fw - 4, gh = fh - 4;
  // Sky gradient (top darker blue -> hazy horizon), one row at a time.
  for (let y = 0; y < gh; y++) {
    px(ctx, gx, gy + y, gw, 1, mix(WINDOW_SKY_TOP, WINDOW_SKY_BOTTOM, y / gh));
  }
  // Mullion cross.
  px(ctx, gx + (gw >> 1), gy, 1, gh, WINDOW_FRAME);
  px(ctx, gx, gy + (gh >> 1), gw, 1, WINDOW_FRAME);
  // Diagonal glass sheen.
  ctx.globalAlpha = 0.35;
  px(ctx, gx + 2, gy + 1, 2, gh - 2, WINDOW_GLASS_SHEEN);
  px(ctx, gx + 5, gy + 1, 1, gh - 2, WINDOW_GLASS_SHEEN);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = WALL_OUTLINE;
  ctx.strokeRect(0.5, 0.5, TILE - 1, TILE - 1);
  tex.refresh();
}

// ---------------------------------------------------------------------------
// Furniture textures. Each kind draws into a w*TILE x h*TILE canvas.
// Some kinds expose a 2-frame variant (glow on/off) for a cheap flicker.
// ---------------------------------------------------------------------------

function transparent(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
}

function outlineRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  outline = "#20242c",
): void {
  px(ctx, x, y, w, h, outline);
  px(ctx, x + 1, y + 1, w - 2, h - 2, fill);
}

interface FurnSpec {
  w: number; // tiles
  h: number; // tiles
  /** glow=true draws the "lit" frame (screen/LED bright); used for the alt frame. */
  draw(ctx: CanvasRenderingContext2D, W: number, H: number, glow: boolean): void;
  /** If true a second (alt) texture is generated for a 2-frame flicker. */
  flicker?: boolean;
}

const FURNITURE_SPECS: Record<FurnitureKind, FurnSpec> = {
  desk: {
    w: 2,
    h: 1,
    flicker: true,
    draw(ctx, W, H, glow) {
      transparent(ctx, W, H);
      // Wooden desk top with a sheen and a front apron.
      outlineRect(ctx, 1, 7, W - 2, H - 11, "#9c6b3f");
      px(ctx, 2, 8, W - 4, 2, "#b98a55"); // top sheen
      px(ctx, 2, H - 6, W - 4, 2, "#7c512e"); // apron shadow
      // Monitor.
      const mx = Math.floor(W / 2) - 10;
      outlineRect(ctx, mx, 1, 20, 14, "#1c1e24"); // dark bezel
      const screen = glow ? "#172030" : "#0f141f"; // dark screen
      px(ctx, mx + 2, 3, 16, 9, screen); // screen
      px(ctx, mx + 3, 4, 7, 3, glow ? "#2a3750" : "#1e273a"); // reflection
      px(ctx, mx + 2, 11, 16, 1, "#172030"); // subtle glow foot
      outlineRect(ctx, mx + 8, 15, 4, 3, "#2a2e36"); // stand
      // Keyboard, mouse, papers on the desk top.
      px(ctx, mx - 6, H - 6, 18, 4, "#3a3f48"); // keyboard
      for (let kx = mx - 5; kx < mx + 11; kx += 3) px(ctx, kx, H - 5, 2, 1, "#586070"); // keys
      px(ctx, mx + 13, H - 5, 3, 2, "#454c58"); // mouse
      px(ctx, 4, H - 7, 6, 5, "#e8e2d4"); // paper stack
      px(ctx, 5, H - 6, 4, 1, "#c7c0b0");
    },
  },
  chair: {
    w: 1,
    h: 1,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      const cx = Math.floor(W / 2);
      outlineRect(ctx, cx - 7, 3, 14, 8, "#3a4252"); // backrest
      px(ctx, cx - 5, 4, 10, 2, "#4a5468"); // backrest highlight
      outlineRect(ctx, cx - 8, 12, 16, 6, "#4a5468"); // seat
      px(ctx, cx - 6, 13, 12, 1, "#5a6480"); // seat sheen
      px(ctx, cx - 1, 18, 2, 7, "#2a2e36"); // post
      px(ctx, cx - 6, H - 4, 12, 2, "#22262e"); // base
      px(ctx, cx - 6, H - 3, 2, 2, "#15171c"); // caster
      px(ctx, cx + 4, H - 3, 2, 2, "#15171c");
    },
  },
  table: {
    w: 3,
    h: 2,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      // Meeting table: wood slab with a darker rim + legs.
      outlineRect(ctx, 3, 7, W - 6, H - 16, "#5a3d26"); // rim
      px(ctx, 5, 9, W - 10, H - 20, "#7d5536"); // inner top
      px(ctx, 6, 10, W - 12, 3, "#9c6b45"); // sheen
      // Legs.
      px(ctx, 8, H - 11, 4, 8, "#5a3d26");
      px(ctx, W - 12, H - 11, 4, 8, "#5a3d26");
      // Documents + a coffee cup scattered on top.
      px(ctx, 12, 13, 8, 6, "#e8e2d4");
      px(ctx, 13, 14, 6, 1, "#bcb4a2");
      px(ctx, 13, 16, 6, 1, "#bcb4a2");
      px(ctx, W - 24, 14, 7, 5, "#d8d0c0");
      outlineRect(ctx, W - 16, 12, 5, 5, "#e7eef2"); // mug
      px(ctx, W - 14, 13, 1, 3, "#9a6b3f"); // mug coffee
    },
  },
  sofa: {
    w: 3,
    h: 1,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      outlineRect(ctx, 1, 4, W - 2, H - 6, "#5a6e8c"); // body
      px(ctx, 3, 5, W - 6, 5, "#6c82a4"); // backrest
      px(ctx, 3, 5, W - 6, 1, "#83a0c4"); // back sheen
      // Cushions with seams.
      const seats = Math.max(1, Math.floor((W - 6) / 18));
      const sw = Math.floor((W - 8) / seats);
      for (let i = 0; i < seats; i++) {
        const sx = 4 + i * sw;
        outlineRect(ctx, sx, 11, sw - 2, H - 16, "#7990b2");
        px(ctx, sx + 2, 12, sw - 5, 1, "#93a9c8"); // cushion sheen
        px(ctx, sx + sw - 2, 12, 1, H - 18, "#566a88"); // seam shadow
      }
      // Armrests.
      px(ctx, 1, 6, 3, H - 9, "#485970");
      px(ctx, W - 4, 6, 3, H - 9, "#485970");
    },
  },
  plant: {
    w: 1,
    h: 1,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      const cx = Math.floor(W / 2);
      // Terracotta pot with rim + highlight.
      outlineRect(ctx, cx - 6, H - 11, 12, 9, "#9a5b3a");
      px(ctx, cx - 5, H - 10, 10, 2, "#b87248"); // rim
      px(ctx, cx - 4, H - 8, 2, 5, "#b5774f"); // pot highlight
      // Foliage: two leaf shapes (rounded clump + pointed sprigs).
      ctx.fillStyle = "#2f8a47";
      ctx.beginPath();
      ctx.arc(cx, H - 16, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#3fa258";
      ctx.beginPath();
      ctx.arc(cx - 5, H - 14, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx + 5, H - 15, 5, 0, Math.PI * 2);
      ctx.fill();
      // Pointed leaf sprigs (the second shape).
      px(ctx, cx - 1, H - 27, 2, 6, "#46b562");
      px(ctx, cx - 6, H - 23, 2, 5, "#3fa258");
      px(ctx, cx + 4, H - 24, 2, 5, "#3fa258");
      px(ctx, cx - 3, H - 18, 3, 3, "#52c272"); // leaf highlight
      // Dark base of leaves.
      px(ctx, cx - 9, H - 13, 18, 1, "#1f5e30");
    },
  },
  counter: {
    w: 11,
    h: 1,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      outlineRect(ctx, 0, 6, W, H - 8, "#6b4a30"); // cabinet
      px(ctx, 0, 4, W, 4, "#d2cab8"); // light countertop
      px(ctx, 0, 4, W, 1, "#ece6d4"); // counter sheen
      px(ctx, 0, 7, W, 1, "#8a6342"); // under-counter shadow
      // Cabinet door seams + handles.
      for (let x = 16; x < W; x += 16) {
        px(ctx, x, 9, 1, H - 13, "#4d3420");
        px(ctx, x - 4, 11, 2, 1, "#caa06e"); // handle
      }
      // A couple of mugs on the counter.
      outlineRect(ctx, 24, 1, 5, 4, "#e7eef2");
      px(ctx, 28, 2, 2, 2, "#cfd8de"); // mug handle
      outlineRect(ctx, W - 40, 1, 5, 4, "#e0c14c");
      px(ctx, W - 36, 2, 2, 2, "#c9aa3c");
    },
  },
  "coffee-machine": {
    w: 1,
    h: 1,
    flicker: true,
    draw(ctx, W, H, glow) {
      transparent(ctx, W, H);
      outlineRect(ctx, 6, 1, W - 12, H - 8, "#2c2f36"); // body
      px(ctx, 9, 4, W - 18, 5, "#4a4f59"); // panel
      px(ctx, 10, 5, 3, 2, glow ? "#ff6a60" : "#e5544b"); // red LED (flickers)
      px(ctx, 14, 5, 3, 2, "#3ecf6e"); // ready LED
      px(ctx, 9, 9, W - 18, 1, "#1c1e23"); // panel base
      px(ctx, Math.floor(W / 2) - 2, H - 11, 4, 3, "#1a1c20"); // spout
      px(ctx, Math.floor(W / 2) - 3, H - 8, 6, 2, "#15171b"); // drip tray
      // A waiting mug under the spout.
      outlineRect(ctx, Math.floor(W / 2) - 3, H - 6, 6, 4, "#e7eef2");
    },
  },
  "reception-desk": {
    w: 4,
    h: 1,
    flicker: true,
    draw(ctx, W, H, glow) {
      transparent(ctx, W, H);
      outlineRect(ctx, 1, 5, W - 2, H - 7, "#8a5a34"); // desk body
      px(ctx, 1, 3, W - 2, 4, "#d8cba6"); // top
      px(ctx, 1, 3, W - 2, 1, "#ece2c4"); // sheen
      px(ctx, 1, 7, W - 2, 1, "#6b4526"); // under-counter shadow
      // Front panel logo band.
      px(ctx, 6, 12, W - 12, 4, "#a86f40");
      px(ctx, 8, 13, W - 16, 1, "#c08a55"); // band highlight
      // Small monitor on the counter.
      outlineRect(ctx, W - 26, 1, 16, 7, "#1c1e24");
      px(ctx, W - 24, 2, 12, 4, glow ? "#172030" : "#0f141f");
      // Service bell on the counter.
      ctx.fillStyle = "#d9b441";
      ctx.beginPath();
      ctx.arc(8, 4, 3, Math.PI, Math.PI * 2);
      ctx.fill();
      px(ctx, 5, 4, 6, 1, "#a8842c"); // bell base
      px(ctx, 8, 0, 1, 1, "#f0d670"); // bell button
    },
  },
  rug: {
    w: 4,
    h: 3,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      // Soft round lounge rug with a fringe.
      ctx.fillStyle = "#7a5f96";
      ctx.beginPath();
      ctx.ellipse(W / 2, H / 2, W / 2 - 3, H / 2 - 3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#9c83b8";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(W / 2, H / 2, W / 2 - 8, H / 2 - 8, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#5f4878";
      ctx.beginPath();
      ctx.ellipse(W / 2, H / 2, W / 2 - 14, H / 2 - 13, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#8a6ea6";
      ctx.beginPath();
      ctx.ellipse(W / 2, H / 2, W / 2 - 20, H / 2 - 18, 0, 0, Math.PI * 2);
      ctx.fill();
      // Fringe ticks around the perimeter.
      ctx.fillStyle = "#9c83b8";
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 16) {
        const ex = W / 2 + Math.cos(a) * (W / 2 - 1);
        const ey = H / 2 + Math.sin(a) * (H / 2 - 1);
        ctx.fillRect(Math.round(ex), Math.round(ey), 1, 1);
      }
    },
  },
  "door-mat": {
    w: 2,
    h: 1,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      outlineRect(ctx, 2, 4, W - 4, H - 8, "#3a4a3a", "#243024"); // mat
      px(ctx, 3, 5, W - 6, 1, "#52684f"); // top bevel highlight
      // Coir weave detail.
      for (let y = 7; y < H - 5; y += 3) px(ctx, 4, y, W - 8, 1, "#46583f");
      for (let x = 6; x < W - 4; x += 4) px(ctx, x, 6, 1, H - 11, "#33422f");
      // "Welcome" hint: a brighter centre band.
      px(ctx, 8, H / 2 - 1, W - 16, 2, "#6b8265");
    },
  },
  "desk-engineering": {
    w: 2,
    h: 1,
    flicker: true,
    draw(ctx, W, H, glow) {
      transparent(ctx, W, H);
      // Sleek tech gray desk top
      outlineRect(ctx, 1, 7, W - 2, H - 11, "#4d5764");
      px(ctx, 2, 8, W - 4, 1, "#647283"); // sheen
      px(ctx, 2, H - 6, W - 4, 2, "#323842"); // apron shadow

      // Center Wide Monitor (Curved screen look)
      const mx = Math.floor(W / 2) - 10;
      outlineRect(ctx, mx, 1, 20, 14, "#1e222b"); // dark bezel
      const screenColor = glow ? "#1c2c26" : "#0d1a15";
      px(ctx, mx + 2, 2, 16, 10, screenColor); // screen
      // Code syntax lines
      px(ctx, mx + 3, 3, 5, 1, "#44df7a"); // green keyword
      px(ctx, mx + 9, 3, 4, 1, "#dfa544"); // yellow function
      px(ctx, mx + 3, 5, 9, 1, "#4492df"); // blue string
      px(ctx, mx + 3, 7, 3, 1, "#df5b5b"); // red tag
      px(ctx, mx + 7, 7, 5, 1, "#44df7a"); // green var
      if (glow) px(ctx, mx + 13, 7, 1, 1, "#ffffff"); // blinking cursor
      px(ctx, mx + 3, 9, 7, 1, "#94a0b2"); // comment
      outlineRect(ctx, mx + 8, 15, 4, 3, "#3a3f48"); // stand

      // Left Vertical Monitor (server status logs)
      outlineRect(ctx, mx - 9, 2, 7, 13, "#1e222b");
      px(ctx, mx - 8, 3, 5, 11, "#11151c");
      px(ctx, mx - 7, 4, 3, 1, "#3ecf6e"); // log line
      px(ctx, mx - 7, 6, 2, 1, "#e5544b"); // error log
      px(ctx, mx - 7, 8, 3, 1, "#3ecf6e");
      px(ctx, mx - 7, 10, 4, 1, "#3ecf6e");
      px(ctx, mx - 7, 12, 1, 1, glow ? "#ffeb60" : "#a8992c"); // blinking warning dot

      // Keyboard & controller
      px(ctx, mx - 2, H - 6, 14, 4, "#2d3139"); // keyboard
      for (let kx = mx - 1; kx < mx + 11; kx += 3) px(ctx, kx, H - 5, 2, 1, "#586070");
      px(ctx, mx + 14, H - 5, 3, 2, "#ff5b5b"); // red gaming mouse

      // Red Coffee Mug
      outlineRect(ctx, 4, H - 6, 4, 4, "#d32f2f");
      px(ctx, 5, H - 5, 2, 2, "#5a3d26"); // coffee inside
      px(ctx, 8, H - 5, 1, 2, "#d32f2f"); // handle

      // Computer Tower (beside desk)
      outlineRect(ctx, W - 10, 10, 8, 18, "#252830");
      px(ctx, W - 8, 12, 4, 1, glow ? "#3ecf6e" : "#1b5e20"); // power LED
      px(ctx, W - 8, 15, 2, 1, "#4a90e2"); // blue USB glow
    },
  },
  "desk-product": {
    w: 2,
    h: 1,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      // Warm oak wood desk top
      outlineRect(ctx, 1, 7, W - 2, H - 11, "#c3a07e");
      px(ctx, 2, 8, W - 4, 1, "#d9bda3"); // sheen
      px(ctx, 2, H - 6, W - 4, 2, "#967554"); // apron shadow

      // Laptop (open) on the left
      outlineRect(ctx, 5, 5, 15, 10, "#4a4f59", "#1c1e23"); // base & screen lip
      px(ctx, 6, 6, 13, 7, "#0f141f"); // dark screen
      px(ctx, 8, 8, 4, 3, "#e5a154"); // chart bar 1
      px(ctx, 13, 7, 4, 4, "#3ecf6e"); // chart bar 2

      // Secondary monitor showing charts on the right
      outlineRect(ctx, W - 24, 1, 18, 14, "#1c1e24");
      px(ctx, W - 22, 2, 14, 10, "#0f141f"); // dark screen
      px(ctx, W - 20, 4, 4, 6, "#4a90e2"); // blue bar
      px(ctx, W - 15, 6, 4, 4, "#f5a623"); // yellow bar
      px(ctx, W - 10, 8, 2, 2, "#7ed321"); // green bar
      outlineRect(ctx, W - 17, 15, 4, 3, "#2a2e36"); // stand

      // Colorful sticky notes
      px(ctx, 25, H - 6, 3, 3, "#ffe066"); // yellow note
      px(ctx, 29, H - 5, 3, 3, "#ff8787"); // pink note

      // Open planner notebook
      outlineRect(ctx, W - 14, H - 6, 10, 5, "#ffffff", "#4a4f59"); // white pages
      px(ctx, W - 13, H - 5, 3, 1, "#bcb4a2"); // notebook lines
      px(ctx, W - 13, H - 3, 3, 1, "#bcb4a2");
      px(ctx, W - 9, H - 5, 3, 1, "#bcb4a2");
      px(ctx, W - 9, H - 3, 3, 1, "#bcb4a2");
      px(ctx, W - 10, H - 6, 1, 5, "#df5b5b"); // red bookmark thread
    },
  },
  "desk-design": {
    w: 2,
    h: 1,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      // Clean white desk top
      outlineRect(ctx, 1, 7, W - 2, H - 11, "#f4f6f8", "#cbd2dc");
      px(ctx, 2, 8, W - 4, 1, "#ffffff"); // sheen
      px(ctx, 2, H - 6, W - 4, 2, "#b1b8c2"); // apron shadow

      // Center iMac-style screen
      const mx = Math.floor(W / 2) - 11;
      outlineRect(ctx, mx, 1, 22, 14, "#d0d5dd", "#9aa1a9"); // silver bezel
      px(ctx, mx + 2, 2, 18, 9, "#1e1e1e"); // dark Figma UI canvas
      px(ctx, mx + 5, 3, 12, 6, "#a259ff"); // purple artboard
      px(ctx, mx + 7, 4, 4, 2, "#f24e1e"); // orange box in artboard
      px(ctx, mx + 13, 7, 2, 2, "#1abc9c"); // teal designer cursor arrow
      outlineRect(ctx, mx + 9, 15, 4, 3, "#b0b5bd"); // silver stand

      // Drawing Tablet (Wacom) on the left
      outlineRect(ctx, 3, H - 6, 11, 5, "#252830");
      px(ctx, 4, H - 4, 1, 2, "#1abc9c"); // active indicator
      px(ctx, 6, H - 5, 6, 1, "#ffffff"); // stylus outline

      // Succulent plant in terracotta pot on the right
      outlineRect(ctx, W - 9, H - 7, 5, 5, "#d07d58");
      px(ctx, W - 9, H - 9, 2, 2, "#2ecc71"); // green succulent leaf
      px(ctx, W - 7, H - 10, 2, 3, "#27ae60");
      px(ctx, W - 5, H - 8, 2, 2, "#2ecc71");
    },
  },
  "desk-hr": {
    w: 2,
    h: 1,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      // Mahogany wood desk top
      outlineRect(ctx, 1, 7, W - 2, H - 11, "#8a5a34");
      px(ctx, 2, 8, W - 4, 1, "#aa7d56"); // sheen
      px(ctx, 2, H - 6, W - 4, 2, "#5c3d22"); // apron shadow

      // Standard office monitor showing candidate portal
      const mx = Math.floor(W / 2) - 8;
      outlineRect(ctx, mx, 2, 16, 13, "#1c1e24");
      px(ctx, mx + 2, 3, 12, 8, "#0f141f"); // dark portal page
      px(ctx, mx + 3, 4, 10, 2, "#1d3a54"); // dark blue header
      px(ctx, mx + 4, 7, 2, 2, "#4a5468"); // placeholder avatar

      // Manila Folder Organizer
      outlineRect(ctx, 4, H - 8, 7, 7, "#35485e");
      px(ctx, 5, H - 7, 2, 2, "#ffd275"); // yellow tab
      px(ctx, 8, H - 7, 2, 2, "#4a90e2"); // blue tab

      // Resume stack (overlapping white pages)
      px(ctx, W - 14, H - 7, 8, 6, "#ffffff");
      px(ctx, W - 15, H - 6, 8, 5, "#f4f6f8"); // page shadow
      px(ctx, W - 12, H - 5, 5, 1, "#cbd2dc"); // document lines
      px(ctx, W - 12, H - 3, 5, 1, "#cbd2dc");
    },
  },
  "chair-engineering": {
    w: 1,
    h: 1,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      const cx = Math.floor(W / 2);
      // Mesh gaming chair: black with red lining
      outlineRect(ctx, cx - 7, 2, 14, 10, "#1c1e23", "#ff3b30"); // high backrest with red edges
      px(ctx, cx - 5, 4, 10, 4, "#2d3139"); // center mesh
      outlineRect(ctx, cx - 8, 12, 16, 6, "#1c1e23", "#ff3b30"); // seat
      px(ctx, cx - 6, 13, 12, 2, "#2d3139"); // seat padding
      px(ctx, cx - 1, 18, 2, 7, "#2a2e36"); // post
      px(ctx, cx - 7, H - 4, 14, 2, "#1c1e23"); // base
      px(ctx, cx - 7, H - 3, 2, 2, "#111215"); // casters
      px(ctx, cx + 5, H - 3, 2, 2, "#111215");
    },
  },
  "chair-product": {
    w: 1,
    h: 1,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      const cx = Math.floor(W / 2);
      // Padded blue corporate task chair
      outlineRect(ctx, cx - 6, 3, 12, 8, "#357ab8", "#1c2c3e"); // blue back
      px(ctx, cx - 4, 4, 8, 2, "#4a90e2"); // highlight
      outlineRect(ctx, cx - 7, 12, 14, 6, "#357ab8", "#1c2c3e"); // blue seat
      px(ctx, cx - 5, 13, 10, 2, "#4a90e2");
      px(ctx, cx - 1, 18, 2, 7, "#2a2e36"); // post
      px(ctx, cx - 6, H - 4, 12, 2, "#22262e"); // base
    },
  },
  "chair-design": {
    w: 1,
    h: 1,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      const cx = Math.floor(W / 2);
      // Minimalist circular wooden stool/chair
      outlineRect(ctx, cx - 6, 4, 12, 2, "#4a3f35"); // low wood back outline
      px(ctx, cx - 1, 6, 2, 6, "#7c848e"); // back support bar
      outlineRect(ctx, cx - 7, 12, 14, 5, "#c3a07e", "#5c4e43"); // round wood seat
      px(ctx, cx - 5, 13, 10, 1, "#d9bda3"); // seat sheen
      px(ctx, cx - 1, 17, 2, 8, "#7c848e"); // post
      px(ctx, cx - 6, H - 4, 12, 2, "#4a4f59"); // base
    },
  },
  "chair-hr": {
    w: 1,
    h: 1,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      const cx = Math.floor(W / 2);
      // Comfortable padded teal fabric chair
      outlineRect(ctx, cx - 7, 3, 14, 9, "#1f6b6b", "#0f3a3a"); // back
      px(ctx, cx - 5, 4, 10, 3, "#2ea0a0");
      outlineRect(ctx, cx - 7, 12, 14, 6, "#1f6b6b", "#0f3a3a"); // seat
      px(ctx, cx - 5, 13, 10, 2, "#2ea0a0");
      px(ctx, cx - 1, 18, 2, 7, "#2a2e36"); // post
      px(ctx, cx - 6, H - 4, 12, 2, "#22262e"); // base
    },
  },
  "ping-pong-table": {
    w: 3,
    h: 2,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      // Ping pong green surface
      outlineRect(ctx, 2, 4, W - 4, H - 8, "#3e9c35", "#1b5e20");
      
      // Boundary lines
      px(ctx, 3, 5, W - 6, 1, "#ffffff"); // top
      px(ctx, 3, H - 5, W - 6, 1, "#ffffff"); // bottom
      px(ctx, 3, 5, 1, H - 10, "#ffffff"); // left
      px(ctx, W - 4, 5, 1, H - 10, "#ffffff"); // right
      
      // Net
      px(ctx, Math.floor(W / 2), 4, 1, H - 8, "#e0e0e0"); // center white net
      
      // Paddles and Ball
      px(ctx, 20, 12, 2, 2, "#df5b5b"); // red paddle
      px(ctx, W - 22, 16, 2, 2, "#4a90e2"); // blue paddle
      px(ctx, Math.floor(W / 2) - 4, 10, 1, 1, "#ffeb60"); // yellow ball

      // Legs
      px(ctx, 4, H - 4, 2, 4, "#1b5e20");
      px(ctx, W - 6, H - 4, 2, 4, "#1b5e20");
    },
  },
  "pool-table": {
    w: 3,
    h: 2,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      // Wooden rail frame.
      outlineRect(ctx, 0, 2, W, H - 4, "#5a3d26", "#362214");
      // Green felt playfield.
      outlineRect(ctx, 3, 5, W - 6, H - 10, "#11623a", "#0a3f25");
      // Six pockets (4 corners + 2 mid long-rail).
      const pk = (x: number, y: number) => px(ctx, x, y, 2, 2, "#05080a");
      pk(3, 5);
      pk(Math.floor(W / 2) - 1, 4);
      pk(W - 5, 5);
      pk(3, H - 7);
      pk(Math.floor(W / 2) - 1, H - 6);
      pk(W - 5, H - 7);
      // Racked balls + cue.
      px(ctx, W - 12, Math.floor(H / 2) - 1, 2, 2, "#f2c200");
      px(ctx, W - 10, Math.floor(H / 2) - 2, 2, 2, "#1f6fd8");
      px(ctx, W - 10, Math.floor(H / 2), 2, 2, "#ef6258");
      px(ctx, W - 8, Math.floor(H / 2) - 1, 2, 2, "#15181d"); // eight
      px(ctx, 9, Math.floor(H / 2) - 1, 2, 2, "#f4f1e8"); // cue
      // Legs.
      px(ctx, 3, H - 4, 2, 4, "#362214");
      px(ctx, W - 5, H - 4, 2, 4, "#362214");
    },
  },
  "vending-machine": {
    w: 1,
    h: 1,
    flicker: true,
    draw(ctx, W, H, glow) {
      transparent(ctx, W, H);
      // Red machine cabinet
      outlineRect(ctx, 2, 0, W - 4, H - 2, "#b82626", "#6c1212");
      // Glass viewport
      outlineRect(ctx, 5, 4, W - 10, 15, "#15171c", "#6c1212");
      // Soda cans inside
      px(ctx, 7, 6, 2, 2, "#4a90e2"); // blue
      px(ctx, 11, 6, 2, 2, "#ff5b5b"); // red
      px(ctx, 7, 10, 2, 2, "#3ecf6e"); // green
      px(ctx, 11, 10, 2, 2, "#ffeb60"); // yellow
      px(ctx, 7, 14, 2, 2, "#f5a623"); // orange

      // Glowing logo header banner
      px(ctx, 4, 1, W - 8, 2, glow ? "#ffeb60" : "#a8992c");

      // Dispenser slot at bottom
      outlineRect(ctx, 6, H - 7, 10, 4, "#2d3139");
    },
  },
  "water-cooler": {
    w: 1,
    h: 1,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      // White cabinet base
      outlineRect(ctx, 7, 12, W - 14, H - 14, "#f4f6f8", "#cbd2dc");
      // Dispenser bay
      outlineRect(ctx, 9, 15, W - 18, 7, "#2d3139");
      px(ctx, 11, 16, 2, 2, "#4a90e2"); // cold tap
      px(ctx, 15, 16, 2, 2, "#df5b5b"); // hot tap

      // Blue transparent inverted water bottle
      ctx.fillStyle = "rgba(74, 144, 226, 0.7)";
      ctx.fillRect(8, 2, W - 16, 9);
      // Neck collar
      outlineRect(ctx, 10, 10, W - 20, 2, "#cbd2dc");
      // Water level line inside bottle
      ctx.fillStyle = "rgba(74, 144, 226, 0.35)";
      ctx.fillRect(9, 3, W - 18, 3);
    },
  },
  "bookshelf": {
    w: 1,
    h: 1,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      // Dark wood shelf frame
      outlineRect(ctx, 1, 0, W - 2, H - 2, "#5a3d26", "#362214");
      // Shelf slats
      px(ctx, 2, 10, W - 4, 1, "#362214");
      px(ctx, 2, 20, W - 4, 1, "#362214");

      // Colorful books
      px(ctx, 3, 3, 2, 7, "#df5b5b"); // red
      px(ctx, 5, 4, 2, 6, "#4a90e2"); // blue
      px(ctx, 8, 3, 2, 7, "#ffeb60"); // yellow
      px(ctx, 11, 4, 2, 6, "#3ecf6e"); // green

      px(ctx, 3, 13, 2, 7, "#8a52d8"); // purple
      px(ctx, 6, 13, 2, 7, "#f5a623"); // orange
      // Leaning books
      px(ctx, 9, 14, 2, 6, "#4a90e2");
      px(ctx, 12, 15, 2, 5, "#ffffff");
    },
  },
  "beanbag": {
    w: 1,
    h: 1,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      const cx = Math.floor(W / 2);
      const cy = Math.floor(H / 2) + 2;
      // Cozy rounded beanbag in purple
      ctx.fillStyle = "#8a52d8";
      ctx.beginPath();
      ctx.arc(cx, cy, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#5f339c";
      ctx.stroke();

      // Top light sheen
      ctx.fillStyle = "#a877ee";
      ctx.beginPath();
      ctx.arc(cx - 3, cy - 3, 4, 0, Math.PI * 2);
      ctx.fill();

      // Creases
      px(ctx, cx - 6, cy + 3, 3, 1, "#5f339c");
      px(ctx, cx + 4, cy + 2, 2, 1, "#5f339c");
    },
  },
  "whiteboard": {
    w: 2,
    h: 1,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      // Aluminum board frame
      outlineRect(ctx, 2, 2, W - 4, H - 6, "#f5f5f5", "#94a0b2");
      // Marker writing diagrams (nodes, flow arrows)
      px(ctx, 8, 6, 6, 4, "#2a2e36"); // main box sketch
      px(ctx, 10, 7, 2, 2, "#4a90e2");
      px(ctx, 18, 6, 2, 2, "#df5b5b"); // red node
      px(ctx, 22, 10, 8, 4, "#2a2e36"); // second box
      // Connector line
      px(ctx, 15, 8, 6, 1, "#2a2e36");
      px(ctx, 20, 8, 1, 3, "#2a2e36");

      // Tray at bottom
      px(ctx, 4, H - 4, W - 8, 1, "#4a4f59");
    },
  },
  "desk-lamp": {
    w: 1,
    h: 1,
    flicker: true,
    draw(ctx, W, H, glow) {
      transparent(ctx, W, H);
      const cx = Math.floor(W / 2);
      
      // Warm yellow lamp shade
      outlineRect(ctx, cx - 6, 2, 12, 6, "#ffd54f", "#8f6a40");
      px(ctx, cx - 1, 8, 2, 18, "#7c848e"); // brass stand
      outlineRect(ctx, cx - 5, H - 6, 10, 3, "#4a4f59"); // heavy iron base

      // Yellow light beam cone under the lamp shade (alpha blended)
      if (glow) {
        ctx.fillStyle = "rgba(255, 235, 59, 0.16)";
        ctx.beginPath();
        ctx.moveTo(cx - 3, 8);
        ctx.lineTo(cx - 14, H);
        ctx.lineTo(cx + 14, H);
        ctx.closePath();
        ctx.fill();
      }
    },
  },
  "arcade-cabinet": {
    w: 1,
    h: 1,
    flicker: true,
    draw(ctx, W, H, glow) {
      transparent(ctx, W, H);
      outlineRect(ctx, 3, 0, W - 6, H - 2, "#4a2c8a", "#211042");
      outlineRect(ctx, 6, 4, W - 12, 13, "#1a1c23", "#211042");
      px(ctx, 8, 6, 16, 9, glow ? "#122a18" : "#0a180e");
      px(ctx, 15, 8, 2, 2, "#3ecf6e");
      px(ctx, 12, 12, 1, 1, "#e5544b");
      px(ctx, 19, 11, 1, 1, "#e5544b");
      
      outlineRect(ctx, 4, 17, W - 8, 5, "#2a2e36");
      px(ctx, 8, 19, 2, 2, "#ff3b30");
      px(ctx, 22, 19, 2, 2, "#4a90e2");
      
      px(ctx, 5, 1, W - 10, 2, glow ? "#ffeb60" : "#a8992c");
      
      px(ctx, 10, H - 6, 4, 3, "#1a1c23");
      px(ctx, 18, H - 6, 4, 3, "#1a1c23");
    },
  },
  "chess-table": {
    w: 1,
    h: 1,
    draw(ctx, W, H) {
      transparent(ctx, W, H);
      outlineRect(ctx, 4, 8, W - 8, H - 16, "#8a5a34", "#4a2f1a");
      px(ctx, 5, 9, W - 10, H - 18, "#9c6b3f");
      for (let y = 10; y < 22; y += 3) {
        for (let x = 7; x < 25; x += 3) {
          const isDark = ((x - 7) / 3 + (y - 10) / 3) % 2 === 0;
          px(ctx, x, y, 3, 3, isDark ? "#4a2f1a" : "#d8cba6");
        }
      }
      px(ctx, 6, H - 8, 2, 8, "#4a2f1a");
      px(ctx, W - 8, H - 8, 2, 8, "#4a2f1a");

      outlineRect(ctx, 0, 10, 3, 10, "#5c3d22");
      px(ctx, 2, 16, 2, 4, "#5c3d22");
      outlineRect(ctx, W - 3, 10, 3, 10, "#5c3d22");
      px(ctx, W - 4, 16, 2, 4, "#5c3d22");
    },
  },
  // The inter-floor portal marker. Rendered as an elevator door set INTO the
  // wall/floor. It is a NON-SOLID walkable tile (a Portal in the shared model);
  // the player steps onto it and the SERVER performs the floor change — the game
  // never decides floor logic, it only draws the door + shows an interact hint.
  // The lit "call" arrow flickers via the alt frame so it reads as active.
  elevator: {
    w: 1,
    h: 1,
    flicker: true,
    draw(ctx, W, H, glow) {
      transparent(ctx, W, H);
      // Brushed-steel surround (the door frame in the wall).
      outlineRect(ctx, 2, 0, W - 4, H - 1, "#8b95a3", "#3a4150");
      px(ctx, 3, 1, W - 6, 1, "#aab4c2"); // top sheen on the frame
      px(ctx, 3, H - 3, W - 6, 1, "#5b6675"); // bottom shade
      // The two sliding doors with a centre seam.
      const dx = 5;
      const dw = W - 10;
      outlineRect(ctx, dx, 3, dw, H - 7, "#b9c2cf", "#525c6b");
      const mid = Math.floor(W / 2);
      px(ctx, mid, 4, 1, H - 9, "#525c6b"); // centre seam
      // Vertical brushed-metal striations on each door leaf.
      for (let x = dx + 2; x < mid - 1; x += 2) px(ctx, x, 4, 1, H - 9, "#c8d1dd");
      for (let x = mid + 2; x < dx + dw - 1; x += 2) px(ctx, x, 4, 1, H - 9, "#c8d1dd");
      // Call panel + up arrow indicator beside the door (lights via glow frame).
      const panelX = dx + dw + 0;
      px(ctx, Math.min(panelX, W - 4), 6, 2, 6, "#2a2e36"); // panel housing
      // Up arrow (a small triangle) — bright amber when "called", dim otherwise.
      ctx.fillStyle = glow ? "#ffd24a" : "#7a6a2c";
      ctx.beginPath();
      ctx.moveTo(mid, 7);
      ctx.lineTo(mid - 3, 11);
      ctx.lineTo(mid + 3, 11);
      ctx.closePath();
      ctx.fill();
      // Floor-level threshold strip so it reads as a doorway on the ground.
      px(ctx, dx, H - 4, dw, 1, "#6b7585");
    },
  },
};

function drawFurniture(scene: Phaser.Scene, kind: FurnitureKind): void {
  const spec = FURNITURE_SPECS[kind];
  const W = spec.w * TILE;
  const H = spec.h * TILE;
  const base = makeCanvas(scene, TEX.furniture(kind), W, H);
  spec.draw(base.ctx, W, H, false);
  base.tex.refresh();
  if (spec.flicker) {
    const alt = makeCanvas(scene, TEX.furnitureAlt(kind), W, H);
    spec.draw(alt.ctx, W, H, true);
    alt.tex.refresh();
  }
}

/** True if this furniture kind has a 2-frame glow flicker (alt texture exists). */
export function furnitureFlickers(kind: FurnitureKind): boolean {
  return FURNITURE_SPECS[kind].flicker === true;
}

// ---------------------------------------------------------------------------
// FX textures: avatar drop-shadow, steam wisp, dust puff.
// ---------------------------------------------------------------------------

function drawShadow(scene: Phaser.Scene): void {
  const w = 22, h = 10;
  const { tex, ctx } = makeCanvas(scene, TEX.shadow, w, h);
  // Soft ellipse via two stacked alpha ellipses (cheap, no blur filter).
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(0,0,0,0.16)";
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2, w / 2 - 3, h / 2 - 2, 0, 0, Math.PI * 2);
  ctx.fill();
  tex.refresh();
}

function drawSteam(scene: Phaser.Scene): void {
  const s = 6;
  const { tex, ctx } = makeCanvas(scene, TEX.steam, s, s);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2 - 1, 0, Math.PI * 2);
  ctx.fill();
  tex.refresh();
}

function drawDust(scene: Phaser.Scene): void {
  const s = 6;
  const { tex, ctx } = makeCanvas(scene, TEX.dust, s, s);
  ctx.fillStyle = "rgba(220,212,190,0.9)";
  ctx.fillRect(1, 1, s - 2, s - 2);
  ctx.fillStyle = "rgba(190,180,158,0.9)";
  ctx.fillRect(2, 2, 2, 2);
  tex.refresh();
}

// ---------------------------------------------------------------------------
// Avatar spritesheets. One data-driven routine renders all six palettes.
// Layout: 4 rows (down, left, right, up) x 6 columns:
//   col 0..1 = idle breathe (bob 0, bob 1)
//   col 2..5 = walk cycle (contact, passing, contact, passing) with arm swing
// 32x32 frames, GBA-ish proportions: head ~40% height, 2px outline.
// ---------------------------------------------------------------------------

const FRAME = TILE; // 32
const DIRS_ORDER = ["down", "left", "right", "up"] as const;
type SheetDir = (typeof DIRS_ORDER)[number];

const COLS = 6;
const ROWS = 4;

/** Column ranges within a direction row. */
const IDLE_COLS = [0, 1] as const;
const WALK_COLS = [2, 3, 4, 5] as const;

/** Frame index in the sheet for (dir, column). */
function sheetFrame(dir: SheetDir, col: number): number {
  return DIRS_ORDER.indexOf(dir) * COLS + col;
}

/**
 * Back-compat helper kept for the scene's initial static frame: the idle "rest"
 * frame for a direction. (Older signature took a pose; we expose the first idle.)
 */
export function frameIndex(dir: SheetDir, _pose?: string): number {
  return sheetFrame(dir, IDLE_COLS[0]);
}

interface PoseParams {
  /** Whole-body vertical bob (idle breathe). */
  bob: number;
  /** Forward arm offset (positive = the near arm swings forward), per side. */
  armL: number;
  armR: number;
  /** Leg lift: which foot is forward/up this frame. */
  legL: number;
  legR: number;
}

function drawHair(
  p: (x: number, y: number, w: number, h: number, c: string) => void,
  style: HairStyle,
  dir: SheetDir,
  hair: string,
  hairLight: string,
  by: number,
): void {
  const back = dir === "up";
  if (style === "buzz") {
    // Close-cropped: thin cap hugging the skull.
    p(9, 3 + by, 14, back ? 9 : 3, hair);
    if (!back) {
      p(9, 6 + by, 2, 1, hair);
      p(21, 6 + by, 2, 1, hair);
    }
    p(10, 3 + by, 12, 1, hairLight);
    return;
  }
  if (style === "cap") {
    // Baseball cap: solid brim + dome.
    p(8, 2 + by, 16, 4, hair);
    p(9, 1 + by, 14, 1, hair);
    p(10, 1 + by, 12, 1, hairLight);
    if (dir === "down") p(8, 6 + by, 16, 2, hair); // brim shadow line
    if (dir === "left") p(6, 6 + by, 4, 2, hair); // brim juts left
    if (dir === "right") p(22, 6 + by, 4, 2, hair); // brim juts right
    if (dir === "up") p(9, 3 + by, 14, 6, hair);
    return;
  }
  if (style === "spiky") {
    p(9, 3 + by, 14, back ? 9 : 4, hair);
    // Spikes poking up across the top.
    for (let sx = 9; sx <= 21; sx += 3) {
      p(sx, 1 + by, 2, 2, hair);
    }
    p(10, 3 + by, 4, 1, hairLight);
    if (!back) {
      p(9, 7 + by, 2, 2, hair);
      p(21, 7 + by, 2, 2, hair);
    }
    return;
  }
  if (style === "bob") {
    // Rounded bob framing the face down to the jaw.
    p(8, 3 + by, 16, back ? 10 : 5, hair);
    p(8, 7 + by, 2, back ? 5 : 6, hair); // left fall
    p(22, 7 + by, 2, back ? 5 : 6, hair); // right fall
    p(10, 3 + by, 10, 1, hairLight);
    return;
  }
  if (style === "curly") {
    // Bumpy curly top via stacked dots.
    p(9, 4 + by, 14, back ? 8 : 4, hair);
    for (let cx = 8; cx <= 22; cx += 3) {
      p(cx, 2 + by, 3, 3, hair);
    }
    p(8, 6 + by, 2, 2, hair);
    p(22, 6 + by, 2, 2, hair);
    p(11, 3 + by, 3, 1, hairLight);
    return;
  }
  // long: shoulder-length hair with side curtains.
  p(8, 3 + by, 16, back ? 12 : 5, hair);
  p(8, 7 + by, 3, back ? 7 : 9, hair); // left curtain
  p(21, 7 + by, 3, back ? 7 : 9, hair); // right curtain
  p(10, 3 + by, 11, 1, hairLight);
}

function drawAvatarFrame(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  pal: typeof AVATAR_PALETTES[AvatarId],
  dir: SheetDir,
  pose: PoseParams,
): void {
  const p = (x: number, y: number, w: number, h: number, c: string) => px(ctx, ox + x, oy + y, w, h, c);
  const by = pose.bob; // body bob

  const OUT = pal.outline;

  // --- Legs / shoes (behind body) ---
  p(11, 22 + by, 10, 5, pal.pants);
  p(11, 25 + by, 10, 1, pal.pantsDark); // pant cuff shadow
  p(15, 22 + by, 2, 5, OUT); // leg split
  // Shoes step up/down per frame.
  p(11, 27 + by - pose.legL, 4, 2 + pose.legL, pal.shoes);
  p(17, 27 + by - pose.legR, 4, 2 + pose.legR, pal.shoes);

  // --- Body / shirt ---
  p(9, 14 + by, 14, 9, OUT); // torso outline
  p(10, 15 + by, 12, 7, pal.shirt);
  p(10, 15 + by, 12, 2, pal.shirtLight); // top-lit highlight
  p(10, 20 + by, 12, 2, pal.shirtDark); // lower shading

  // Arms depend on facing + swing.
  if (dir === "down" || dir === "up") {
    const ly = 15 + by - pose.armL;
    const ry = 15 + by - pose.armR;
    p(8, ly, 3, 6, OUT);
    p(21, ry, 3, 6, OUT);
    p(9, ly + 1, 1, 4, pal.shirtDark);
    p(22, ry + 1, 1, 4, pal.shirtDark);
    p(8, ly + 5, 2, 2, pal.skin); // hands
    p(22, ry + 5, 2, 2, pal.skin);
  } else if (dir === "left") {
    const ly = 15 + by - pose.armL;
    p(9, ly, 3, 6, OUT);
    p(10, ly + 1, 1, 4, pal.shirtDark);
    p(9, ly + 5, 2, 2, pal.skin);
  } else {
    const ry = 15 + by - pose.armR;
    p(20, ry, 3, 6, OUT);
    p(21, ry + 1, 1, 4, pal.shirtDark);
    p(21, ry + 5, 2, 2, pal.skin);
  }

  // --- Head (big, ~13px tall ≈ 40% of 32) ---
  p(8, 2 + by, 16, 14, OUT); // outline
  p(9, 3 + by, 14, 12, pal.skin); // face

  // Hair silhouette per avatar style.
  drawHair(p, pal.hairStyle, dir, pal.hair, pal.hairLight, by);

  // Face features by direction.
  if (dir === "down") {
    p(12, 9 + by, 2, 3, OUT); // eyes
    p(18, 9 + by, 2, 3, OUT);
    p(12, 9 + by, 1, 1, "#ffffff"); // eye glints
    p(18, 9 + by, 1, 1, "#ffffff");
    p(15, 11 + by, 2, 1, pal.skinDark); // nose
    p(14, 13 + by, 4, 1, "#8a5a44"); // mouth
  } else if (dir === "up") {
    // Back of head: hair already covers it; add a nape shadow.
    p(10, 14 + by, 12, 1, pal.hair);
  } else if (dir === "left") {
    p(11, 9 + by, 2, 3, OUT); // visible eye
    p(11, 9 + by, 1, 1, "#ffffff");
    p(9, 11 + by, 1, 2, pal.skinDark); // nose at facing edge
    p(11, 13 + by, 3, 1, "#8a5a44"); // mouth
  } else {
    p(19, 9 + by, 2, 3, OUT);
    p(20, 9 + by, 1, 1, "#ffffff");
    p(22, 11 + by, 1, 2, pal.skinDark);
    p(18, 13 + by, 3, 1, "#8a5a44");
  }
}

// Pose tables. Idle = gentle breathe bob; walk = 4-frame contact/passing cycle
// with opposing arm/leg swing. Defined once (module scope) — no per-frame alloc.
const IDLE_POSES: PoseParams[] = [
  { bob: 0, armL: 0, armR: 0, legL: 0, legR: 0 },
  { bob: 1, armL: 0, armR: 0, legL: 0, legR: 0 },
];
const WALK_POSES: PoseParams[] = [
  { bob: 0, armL: 1, armR: -1, legL: 1, legR: 0 }, // left foot forward
  { bob: 1, armL: 0, armR: 0, legL: 0, legR: 0 }, // passing
  { bob: 0, armL: -1, armR: 1, legL: 0, legR: 1 }, // right foot forward
  { bob: 1, armL: 0, armR: 0, legL: 0, legR: 0 }, // passing
];

function drawAvatarSheet(scene: Phaser.Scene, id: AvatarId): void {
  const pal = AVATAR_PALETTES[id];
  const { tex, ctx } = makeCanvas(scene, TEX.avatarSheet(id), COLS * FRAME, ROWS * FRAME);
  for (let r = 0; r < ROWS; r++) {
    const dir = DIRS_ORDER[r];
    // Idle columns.
    for (let i = 0; i < IDLE_COLS.length; i++) {
      drawAvatarFrame(ctx, IDLE_COLS[i] * FRAME, r * FRAME, pal, dir, IDLE_POSES[i]);
    }
    // Walk columns.
    for (let i = 0; i < WALK_COLS.length; i++) {
      drawAvatarFrame(ctx, WALK_COLS[i] * FRAME, r * FRAME, pal, dir, WALK_POSES[i]);
    }
  }
  tex.refresh();
  // Register the frame grid so the texture is usable as a spritesheet.
  const phaserTex = scene.textures.get(TEX.avatarSheet(id));
  let i = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      phaserTex.add(i, 0, c * FRAME, r * FRAME, FRAME, FRAME);
      i++;
    }
  }
}

// ---------------------------------------------------------------------------
// Animations: 4-frame walk + 2-frame idle breathe per avatar + direction.
// ---------------------------------------------------------------------------

export function animKey(id: AvatarId, dir: SheetDir, kind: "walk" | "idle"): string {
  return `${id}:${kind}:${dir}`;
}

function registerAnimations(scene: Phaser.Scene, id: AvatarId): void {
  const sheet = TEX.avatarSheet(id);
  for (const dir of DIRS_ORDER) {
    if (!scene.anims.exists(animKey(id, dir, "walk"))) {
      scene.anims.create({
        key: animKey(id, dir, "walk"),
        frames: WALK_COLS.map((c) => ({ key: sheet, frame: sheetFrame(dir, c) })),
        frameRate: 9,
        repeat: -1,
      });
    }
    if (!scene.anims.exists(animKey(id, dir, "idle"))) {
      scene.anims.create({
        key: animKey(id, dir, "idle"),
        frames: IDLE_COLS.map((c) => ({ key: sheet, frame: sheetFrame(dir, c) })),
        frameRate: 1.6, // slow breathe bob
        repeat: -1,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Public entrypoint: build every texture + animation once at scene preload.
// ---------------------------------------------------------------------------

export function buildAllTextures(scene: Phaser.Scene): void {
  // Floors (3 deterministic variants each).
  drawFloor(scene, TEX.hallwayFloor, HALLWAY_FLOOR, 1);
  drawFloor(scene, TEX.receptionFloor, RECEPTION_FLOOR, 2);
  drawFloor(scene, TEX.meetingFloor, MEETING_FLOOR, 3);
  drawFloor(scene, TEX.coffeeFloor, COFFEE_FLOOR, 4);
  drawFloor(scene, TEX.loungeFloor, LOUNGE_FLOOR, 5);
  let deptSeed = 6;
  for (const dept of Object.keys(DEPARTMENT_FLOOR) as Department[]) {
    drawFloor(scene, TEX.departmentFloor(dept), DEPARTMENT_FLOOR[dept], deptSeed++);
  }

  // Walls.
  drawWall(scene);
  drawWindowWall(scene);

  // Furniture (+ flicker alt frames where applicable).
  for (const kind of Object.keys(FURNITURE_SPECS) as FurnitureKind[]) {
    drawFurniture(scene, kind);
  }

  // FX.
  drawShadow(scene);
  drawSteam(scene);
  drawDust(scene);

  // Avatars + animations.
  for (const id of AVATAR_IDS) {
    drawAvatarSheet(scene, id);
    registerAnimations(scene, id);
  }
}

export type { SheetDir };
