// ---------------------------------------------------------------------------
// Pure presentation constants for the Phaser rendering layer.
// Palettes, timing, depth bands. NO business logic lives here — these are
// look-up tables consumed by the texture generator and the scene.
// ---------------------------------------------------------------------------

import type { AvatarId, Department } from "@pixeloffice/shared";
import { TILE } from "@pixeloffice/shared";

export { TILE };

// --- Timing -----------------------------------------------------------------

/** Milliseconds to walk a single tile (Pokémon Emerald grid step feel). */
export const STEP_MS = 150;
/** Camera zoom level. */
export const CAMERA_ZOOM = 1.4;
/** How long a chat bubble stays on screen. */
export const BUBBLE_MS = 4000;
/** Max characters shown in a chat bubble. */
export const BUBBLE_MAX_CHARS = 60;

// --- Depth bands ------------------------------------------------------------
// Floors at the bottom, then walls, then y-sorted entities, then UI on top.

export const DEPTH_FLOOR = 0;
export const DEPTH_RUG = 1;
export const DEPTH_AREA_LABEL = 2;
export const DEPTH_WALL = 5;
/** y-sorted entities (furniture + characters) get setDepth(pixelY + this). */
export const DEPTH_ENTITY_BASE = 10;
/** Bubbles / badges that should float above everything in the world. */
export const DEPTH_OVERLAY = 100000;

// --- Background -------------------------------------------------------------

export const BG_COLOR = "#0e1116";
export const BG_COLOR_NUM = 0x0e1116;

// --- Avatar palettes --------------------------------------------------------
// GBA-style 4-tone-ish palette per avatar id. Drawing code is data-driven:
// one routine reads this table, never six copies.

/** Distinct hair silhouette per avatar so the cast reads apart at a glance. */
export type HairStyle = "spiky" | "bob" | "curly" | "cap" | "long" | "buzz";

export interface AvatarPalette {
  /** Main shirt / hair accent colour. */
  shirt: string;
  /** Lighter shade of the shirt for top-lit highlight. */
  shirtLight: string;
  /** Darker shade of the shirt for shading. */
  shirtDark: string;
  /** Hair colour. */
  hair: string;
  /** Hair highlight (top sheen). */
  hairLight: string;
  /** Trousers colour. */
  pants: string;
  /** Darker trousers shade. */
  pantsDark: string;
  /** Shoe colour. */
  shoes: string;
  /** Skin tone. */
  skin: string;
  /** Darker skin tone for shading (nose/jaw). */
  skinDark: string;
  /** Outline colour (near-black). */
  outline: string;
  /** Hair silhouette shape for this avatar. */
  hairStyle: HairStyle;
}

const SKIN = "#e8b58c";
const SKIN_DARK = "#cf9468";
const SKIN_ALT = "#d49a6a";
const SKIN_ALT_DARK = "#b87c4f";
const OUTLINE = "#1a1a22";

export const AVATAR_PALETTES: Record<AvatarId, AvatarPalette> = {
  ruby: {
    shirt: "#d8324b",
    shirtLight: "#ef5870",
    shirtDark: "#9c1f33",
    hair: "#3a2a26",
    hairLight: "#523a32",
    pants: "#36405a",
    pantsDark: "#272f44",
    shoes: "#22262e",
    skin: SKIN,
    skinDark: SKIN_DARK,
    outline: OUTLINE,
    hairStyle: "spiky",
  },
  sapphire: {
    shirt: "#2f6fd0",
    shirtLight: "#5b93ec",
    shirtDark: "#1e4a93",
    hair: "#231f2e",
    hairLight: "#383145",
    pants: "#2b3346",
    pantsDark: "#1d2433",
    shoes: "#22262e",
    skin: SKIN,
    skinDark: SKIN_DARK,
    outline: OUTLINE,
    hairStyle: "bob",
  },
  emerald: {
    shirt: "#2faa5e",
    shirtLight: "#52c97f",
    shirtDark: "#1c7741",
    hair: "#2c2420",
    hairLight: "#443730",
    pants: "#384055",
    pantsDark: "#28303f",
    shoes: "#22262e",
    skin: SKIN_ALT,
    skinDark: SKIN_ALT_DARK,
    outline: OUTLINE,
    hairStyle: "curly",
  },
  amber: {
    shirt: "#e08a2a",
    shirtLight: "#f5a948",
    shirtDark: "#a85f17",
    hair: "#4a3220",
    hairLight: "#67492f",
    pants: "#3a3548",
    pantsDark: "#2a2636",
    shoes: "#22262e",
    skin: SKIN,
    skinDark: SKIN_DARK,
    outline: OUTLINE,
    hairStyle: "cap",
  },
  violet: {
    shirt: "#8a52d8",
    shirtLight: "#a877ee",
    shirtDark: "#5f339c",
    hair: "#2a2230",
    hairLight: "#403448",
    pants: "#33304a",
    pantsDark: "#242238",
    shoes: "#22262e",
    skin: SKIN_ALT,
    skinDark: SKIN_ALT_DARK,
    outline: OUTLINE,
    hairStyle: "long",
  },
  slate: {
    shirt: "#73808f",
    shirtLight: "#94a1af",
    shirtDark: "#4d5764",
    hair: "#2a2e34",
    hairLight: "#3f454d",
    pants: "#363b44",
    pantsDark: "#262a31",
    shoes: "#22262e",
    skin: SKIN,
    skinDark: SKIN_DARK,
    outline: OUTLINE,
    hairStyle: "buzz",
  },
};

// --- Floor / department palettes -------------------------------------------
// Each area type maps to a base floor + a carpet tint per department.

export type FloorKind = "carpet" | "wood" | "tile" | "checker";

export interface FloorStyle {
  /** How this floor is rendered (woven carpet, wood planks, cool tile, checker). */
  kind: FloorKind;
  /** Lighter base tone. */
  light: string;
  /** Darker base / weave tone. */
  dark: string;
  /** Subtle grain fleck colour. */
  fleck: string;
  /** Occasional accent tile / grout / plank line colour. */
  accent: string;
}

export const HALLWAY_FLOOR: FloorStyle = {
  kind: "checker",
  light: "#c9c2b2",
  dark: "#bdb6a6",
  fleck: "#d3ccbc",
  accent: "#aaa493",
};

export const RECEPTION_FLOOR: FloorStyle = {
  kind: "wood",
  light: "#caa472",
  dark: "#b88e5b",
  fleck: "#d9b885",
  accent: "#8f6a40",
};

export const MEETING_FLOOR: FloorStyle = {
  kind: "tile",
  light: "#bcc6d4",
  dark: "#aeb8c7",
  fleck: "#cdd5e1",
  accent: "#94a0b2",
};

export const COFFEE_FLOOR: FloorStyle = {
  kind: "wood",
  light: "#c3a07e",
  dark: "#b08a66",
  fleck: "#d2b393",
  accent: "#86603c",
};

export const LOUNGE_FLOOR: FloorStyle = {
  kind: "carpet",
  light: "#b8a7c4",
  dark: "#a896b6",
  fleck: "#c7b8d2",
  accent: "#cdb6e0",
};

/** Department carpet tints (used for DEPARTMENT areas). */
export const DEPARTMENT_FLOOR: Record<Department, FloorStyle> = {
  Engineering: { kind: "carpet", light: "#9fb6c9", dark: "#8fa8bd", fleck: "#b0c4d4", accent: "#bcd6ea" },
  Product: { kind: "carpet", light: "#c2a9b8", dark: "#b298a8", fleck: "#d0bac8", accent: "#e6c2d8" },
  Design: { kind: "carpet", light: "#aecaa6", dark: "#9cba94", fleck: "#bdd6b6", accent: "#cdeac0" },
  HR: { kind: "carpet", light: "#cabf9c", dark: "#bbb08c", fleck: "#d6ccae", accent: "#ead9a8" },
};

/** Number of deterministic variation tiles generated per floor type. */
export const FLOOR_VARIANTS = 3;

// --- Wall palette -----------------------------------------------------------

export const WALL_TOP = "#7f8a99"; // top highlight face
export const WALL_TOP_LIGHT = "#9aa6b5"; // bright lip on the top face
export const WALL_FRONT = "#565f6c"; // front shaded face
export const WALL_FRONT_LIGHT = "#646e7c"; // highlight row below the top lip
export const WALL_FRONT_DARK = "#434b56";
export const WALL_BASEBOARD = "#363d47"; // skirting line at the floor
export const WALL_OUTLINE = "#2e333b";

// --- Window (north outer wall) ---------------------------------------------

export const WINDOW_FRAME = "#cdd4dc";
export const WINDOW_FRAME_DARK = "#9aa3ad";
export const WINDOW_SKY_TOP = "#9fd3f2"; // top of the sky gradient
export const WINDOW_SKY_BOTTOM = "#dbeefb"; // horizon haze
export const WINDOW_GLASS_SHEEN = "#ffffff";
