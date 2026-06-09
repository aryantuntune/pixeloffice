// ---------------------------------------------------------------------------
// The Phaser office scene — pure rendering layer (plan rule: NO business logic).
//
// It renders the shared office map (floors, walls, furniture), draws every
// avatar (local + remote), runs Pokémon-Emerald-style grid-locked movement for
// the LOCAL avatar from keyboard input, and exposes imperative methods the UI
// bridge calls for remote players (add/remove/move/teleport/presence/bubble).
//
// The scene knows nothing about presence rules, meetings, the network, or the
// HUD. It receives facts (a presence STATE to pick an animation, a tile to walk
// to) and renders them. All callbacks back to the UI go through the options.
// ---------------------------------------------------------------------------

import Phaser from "phaser";
import {
  EMOTE_EMOJI,
  PresenceState,
  areaAt,
  buildOfficeMap,
  isWalkable,
  type Direction,
  type Emote,
  type Floor,
  type FurnitureKind,
  type OfficeMap,
  type PlayerSnapshot,
  type Portal,
} from "@pixeloffice/shared";
import {
  BUBBLE_MAX_CHARS,
  BUBBLE_MS,
  CAMERA_ZOOM,
  DEPTH_AREA_LABEL,
  DEPTH_ENTITY_BASE,
  DEPTH_FLOOR,
  DEPTH_OVERLAY,
  DEPTH_RUG,
  DEPTH_WALL,
  EMOTE_MS,
  FLOOR_FADE_MS,
  PAN_MS,
  PAN_RESUME_MS,
  STEP_MS,
  TILE,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_TWEEN_MS,
} from "./constants";
import {
  TEX,
  animKey,
  buildAllTextures,
  floorTextureForArea,
  floorVariantForTile,
  frameIndex,
  furnitureFlickers,
  type SheetDir,
} from "./textures";

/** Direction -> (dx,dy) in tiles. */
const DIR_VEC: Record<Direction, { dx: number; dy: number }> = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

/** Presence states that should play the idle ("anchored") pose, never walk. */
function poseDirFor(dir: Direction): SheetDir {
  return dir as SheetDir;
}

/** Server-side lounge game station ids (see Wire protocol / room handlers). */
type GameStationId =
  | "lounge:pool"
  | "lounge:ping-pong"
  | "lounge:tic-tac-toe"
  | "lounge:connect-four";

/**
 * Maps a playable furniture piece to the lounge game it launches + its [E]
 * prompt. The prompt names the game on the prop so the affordance is honest
 * regardless of which floor the furniture sits on.
 */
const GAME_STATIONS: Partial<
  Record<FurnitureKind, { gameId: GameStationId; prompt: string }>
> = {
  "pool-table": { gameId: "lounge:pool", prompt: "Press [E] to play Pool" },
  "ping-pong-table": {
    gameId: "lounge:ping-pong",
    prompt: "Press [E] to play Table Tennis",
  },
  "arcade-cabinet": {
    gameId: "lounge:connect-four",
    prompt: "Press [E] to play Connect Four",
  },
  "chess-table": {
    gameId: "lounge:tic-tac-toe",
    prompt: "Press [E] to play Tic-Tac-Toe",
  },
};

interface Avatar {
  snap: PlayerSnapshot;
  sprite: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Image; // soft ellipse under the feet
  nameTag: Phaser.GameObjects.Text;
  badge: Phaser.GameObjects.Container; // presence icon on a dark pill
  badgeBg: Phaser.GameObjects.Graphics;
  badgeIcon: Phaser.GameObjects.Text;
  bubble?: Phaser.GameObjects.Container;
  bubbleTimer?: Phaser.Time.TimerEvent;
  /** Active emote bubble (capped at one per avatar; replaced on a new emote). */
  emote?: Phaser.GameObjects.Container;
  emoteTimer?: Phaser.Time.TimerEvent;
  /** In-flight grid step tween, if any (remote interpolation / local step). */
  stepTween?: Phaser.Tweens.Tween;
  presence: PresenceState;
  /** Whether the avatar is mid-step (controls walk vs idle anim). */
  walking: boolean;
}

export interface SceneCallbacks {
  onLocalMove(x: number, y: number, dir: Direction, moving: boolean): void;
  onAreaChange(areaName: string): void;
  onInteractPrompt?(prompt: string | null, gameId?: string): void;
  /** Local user double-clicked their own avatar (open the profile modal). */
  onProfileOpen?(): void;
}

const BADGE_FOR: Record<PresenceState, string> = {
  [PresenceState.AVAILABLE]: "",
  [PresenceState.IN_MEETING]: "📅",
  [PresenceState.FOCUS]: "🎧",
  [PresenceState.BREAK]: "☕",
  [PresenceState.AWAY]: "💤",
  [PresenceState.OFFLINE]: "",
};

export class OfficeScene extends Phaser.Scene {
  // The geometry currently being rendered. Defaults to the legacy single-floor
  // map (back-compat: a caller that never supplies a Floor keeps the old office).
  // A Floor is a structural superset of OfficeMap, so this holds either.
  private map: OfficeMap | Floor = buildOfficeMap();
  /** Portals on the current floor (empty for a plain single-floor OfficeMap). */
  private portals: Portal[] = [];
  /** The current floor id (for the UI bridge / minimap). Defaults to "ground". */
  private floorId = "ground";
  // Every world-layer game object built by drawWorld(), tracked so a floor swap
  // can tear the old floor down cleanly before rebuilding (avatars are separate).
  private worldObjects: Phaser.GameObjects.GameObject[] = [];
  private flickerTimer?: Phaser.Time.TimerEvent;
  private avatars = new Map<string, Avatar>();
  private selfId = "";
  private selfStart!: PlayerSnapshot;
  private cb!: SceneCallbacks;
  /** The portal the local avatar is currently standing on / next to (hint). */
  private currentPortalLabel: string | null = null;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key>;
  /** While true the local avatar ignores keyboard (chat input focused). */
  private inputLocked = false;
  private lastArea = "Hallway";
  /** Timestamp of the last pointerdown on the self avatar (double-click detect). */
  private lastSelfClickAt = 0;
  /** Furniture pieces that flip between base/alt textures for a glow flicker. */
  private flickerPieces: { img: Phaser.GameObjects.Image; kind: FurnitureKind }[] = [];
  private flickerOn = false;
  private steamEmitters: Phaser.GameObjects.Particles.ParticleEmitter[] = [];
  private reducedMotion = false;
  private npcVisible = true;
  private panResumeTimer?: Phaser.Time.TimerEvent;
  private keyE!: Phaser.Input.Keyboard.Key;
  private currentPromptGameId?: string;

  constructor() {
    super({ key: "office" });
  }

  init(data: { self: PlayerSnapshot; cb: SceneCallbacks; floor?: Floor }): void {
    this.selfStart = data.self;
    this.selfId = data.self.sessionId;
    this.cb = data.cb;
    // If the UI bridge already fetched the player's floor geometry (from
    // GET /api/maps/active) it passes it here so create() renders the correct
    // floor immediately. Otherwise we fall back to the legacy single-floor map
    // and the bridge swaps in the real floor via setActiveFloor() afterwards.
    if (data.floor) {
      this.map = data.floor;
      this.portals = data.floor.portals ?? [];
      this.floorId = data.floor.id;
    } else {
      this.floorId = data.self.floorId ?? "ground";
    }
  }

  preload(): void {
    // All textures are generated at runtime (no asset files).
    buildAllTextures(this);
  }

  create(): void {
    this.cameras.main.setZoom(CAMERA_ZOOM);
    this.cameras.main.setBackgroundColor("#0e1116");

    this.drawWorld();

    // Local avatar (the game owns and controls it — contract rule).
    this.spawnAvatar(this.selfStart, true);
    const self = this.avatars.get(this.selfId)!;
    this.cameras.main.startFollow(self.sprite, true, 0.15, 0.15);
    this.cameras.main.setBounds(0, 0, this.map.width * TILE, this.map.height * TILE);

    // Input.
    const kb = this.input.keyboard!;
    this.cursors = kb.createCursorKeys();
    this.wasd = {
      up: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };
    this.keyE = kb.addKey(Phaser.Input.Keyboard.KeyCodes.E);

    // Announce initial area.
    this.reportArea(self);

    // Signal the handle factory that the scene is fully live (self avatar built).
    this.game.events.emit("office-ready");
  }

  update(): void {
    if (this.inputLocked) return;

    if (Phaser.Input.Keyboard.JustDown(this.keyE)) {
      this.triggerInteraction();
    }

    const self = this.avatars.get(this.selfId);
    if (!self || self.walking) return;

    const dir = this.pollDirection();
    if (!dir) return;

    // Any local movement input cancels a pan-to-player and snaps the camera
    // back to following the local avatar (human agency: the user is in control).
    if (this.panResumeTimer) this.resumeFollowSelf();

    // Face that way even if blocked (Emerald turn-in-place feel).
    self.snap.dir = dir;
    this.applyFacing(self);

    const { dx, dy } = DIR_VEC[dir];
    const nx = self.snap.x + dx;
    const ny = self.snap.y + dy;
    if (!isWalkable(this.map, nx, ny) || this.tileOccupied(nx, ny)) {
      // Blocked: still tell the server we turned (moving:false) so others see facing.
      this.cb.onLocalMove(self.snap.x, self.snap.y, dir, false);
      return;
    }

    this.stepLocal(self, nx, ny, dir);
  }

  private triggerInteraction(): void {
    if (this.currentPromptGameId) {
      this.game.events.emit("lounge-game-interact", this.currentPromptGameId);
    }
  }

  // -------------------------------------------------------------------------
  // World rendering
  // -------------------------------------------------------------------------

  /** Track a world-layer object so a floor swap can tear it down later. */
  private track<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.worldObjects.push(obj);
    return obj;
  }

  private drawWorld(): void {
    // Floors: paint each area's floor, hallway elsewhere. Pick one of the
    // deterministic variant tiles per position so large floors don't band.
    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        const area = areaAt(this.map, x, y);
        const base = area
          ? floorTextureForArea(area.type, area.department)
          : TEX.hallwayFloor;
        const key = floorVariantForTile(base, x, y);
        const img = this.add.image(x * TILE, y * TILE, key).setOrigin(0, 0);
        img.setDepth(DEPTH_FLOOR);
        this.track(img);
      }
    }

    // Area labels: pixel-font styling (caps, letter-spacing, outline).
    for (const a of this.map.areas) {
      const label = this.add.text(
        (a.x + a.w / 2) * TILE,
        (a.y + 0.45) * TILE,
        a.name.toUpperCase(),
        {
          fontFamily: "monospace",
          fontSize: "12px",
          color: "#eef2f6",
          stroke: "#11151b",
          strokeThickness: 3,
        },
      );
      label.setLetterSpacing?.(2);
      label.setOrigin(0.5, 0.5).setAlpha(0.62).setDepth(DEPTH_AREA_LABEL);
      this.track(label);
    }

    // Walls. Outer north wall tiles (y === 0, excluding corners) deterministically
    // become windows showing the sky — a few, not all, to keep it charming.
    const lastX = this.map.width - 1;
    for (const w of this.map.walls) {
      const northOuter = w.y === 0 && w.x > 1 && w.x < lastX - 1;
      const isWindow = northOuter && (w.x * 7 + w.y * 13) % 3 === 0;
      const tex = isWindow ? TEX.wallWindow : TEX.wall;
      this.track(this.add.image(w.x * TILE, w.y * TILE, tex).setOrigin(0, 0).setDepth(DEPTH_WALL));
    }

    // Furniture (y-sorted so taller pieces overlap correctly).
    for (const f of this.map.furniture) {
      const img = this.add.image(f.x * TILE, f.y * TILE, TEX.furniture(f.kind)).setOrigin(0, 0);
      if (f.kind === "rug") {
        img.setDepth(DEPTH_RUG);
      } else {
        const footY = (f.y + f.h) * TILE;
        img.setDepth(DEPTH_ENTITY_BASE + footY);
      }
      if (furnitureFlickers(f.kind)) this.flickerPieces.push({ img, kind: f.kind });
      if (f.kind === "coffee-machine") this.spawnSteam(f.x, f.y);
      this.track(img);
    }

    // Portals: a soft glowing pad on the floor under each elevator/stairs tile so
    // the player can see where the inter-floor link is even if no elevator
    // furniture was seeded there. Walking onto it is a normal MOVE; the SERVER
    // performs the floor change (human agency — the game decides no floor logic).
    this.drawPortalPads();

    // Drive the cheap 2-frame glow flicker on a slow shared timer.
    this.flickerTimer = this.time.addEvent({
      delay: 480,
      loop: true,
      callback: () => this.tickFlicker(),
    });
  }

  /** Draw a subtle glowing pad marker on each portal tile (under furniture). */
  private drawPortalPads(): void {
    for (const p of this.portals) {
      const g = this.add.graphics();
      const cx = p.x * TILE + TILE / 2;
      const cy = p.y * TILE + TILE / 2;
      g.fillStyle(0xffd24a, 0.12);
      g.fillCircle(cx, cy, TILE * 0.46);
      g.lineStyle(1, 0xffd24a, 0.35);
      g.strokeCircle(cx, cy, TILE * 0.42);
      g.setDepth(DEPTH_RUG); // above the floor, below furniture/avatars
      this.track(g);
    }
  }

  /** Toggle glowing-screen / LED furniture between its base + alt texture. */
  private tickFlicker(): void {
    this.flickerOn = !this.flickerOn;
    for (const f of this.flickerPieces) {
      f.img.setTexture(this.flickerOn ? TEX.furnitureAlt(f.kind) : TEX.furniture(f.kind));
    }
  }

  /** Tiny capped steam wisps rising from a coffee machine tile. */
  private spawnSteam(fx: number, fy: number): void {
    const x = fx * TILE + TILE / 2;
    const y = fy * TILE - 2;
    const emitter = this.add.particles(x, y, TEX.steam, {
      speedY: { min: -14, max: -8 },
      speedX: { min: -3, max: 3 },
      lifespan: 1400,
      frequency: 700, // capped + cheap: ~2 live wisps at a time
      scale: { start: 0.9, end: 0.2 },
      alpha: { start: 0.55, end: 0 },
      quantity: 1,
    });
    emitter.setDepth(DEPTH_ENTITY_BASE + (fy + 1) * TILE + 2);
    this.steamEmitters.push(emitter);
    if (this.reducedMotion) emitter.stop();
  }

  /** One-shot dust puff burst at a tile centre (teleport feedback). */
  private dustPuff(tileX: number, tileY: number): void {
    if (this.reducedMotion) return; // decorative only
    const x = tileX * TILE + TILE / 2;
    const y = tileY * TILE + TILE / 2 + 6;
    const emitter = this.add.particles(x, y, TEX.dust, {
      speed: { min: 20, max: 50 },
      angle: { min: 200, max: 340 },
      lifespan: 420,
      scale: { start: 1, end: 0.2 },
      alpha: { start: 0.9, end: 0 },
      gravityY: 30,
      quantity: 8,
      emitting: false,
    });
    emitter.setDepth(DEPTH_ENTITY_BASE + (tileY + 1) * TILE + 3);
    emitter.explode(8);
    // Free the emitter shortly after its particles die.
    this.time.delayedCall(700, () => emitter.destroy());
  }

  // -------------------------------------------------------------------------
  // Avatars
  // -------------------------------------------------------------------------

  private spawnAvatar(snap: PlayerSnapshot, isSelf: boolean): Avatar {
    const px = snap.x * TILE + TILE / 2;
    const py = snap.y * TILE + TILE / 2;

    // Soft drop shadow sits just below the feet, under the sprite.
    const shadow = this.add.image(px, py + 5, TEX.shadow);
    shadow.setOrigin(0.5, 0.5);

    const sprite = this.add.sprite(px, py, TEX.avatarSheet(snap.avatarId));
    sprite.setOrigin(0.5, 0.75); // feet near the tile centre
    sprite.setFrame(frameIndex(poseDirFor(snap.dir)));

    // Double-click the local avatar to open the profile modal.
    if (isSelf) {
      sprite.setInteractive({ useHandCursor: true });
      sprite.on("pointerdown", () => {
        const now = this.time.now;
        if (now - this.lastSelfClickAt < 350) {
          this.lastSelfClickAt = 0;
          this.cb.onProfileOpen?.();
        } else {
          this.lastSelfClickAt = now;
        }
      });
    }

    const nameTag = this.add.text(px, py - TILE * 0.95, isSelf ? `${snap.name} (you)` : snap.name, {
      fontFamily: "monospace",
      fontSize: "11px",
      color: isSelf ? "#ffe9a8" : "#e6ecf2",
      stroke: "#11151b",
      strokeThickness: 3,
    });
    nameTag.setOrigin(0.5, 1).setDepth(DEPTH_OVERLAY);

    // Presence badge: an icon on a small dark pill for readability.
    const badgeIcon = this.add.text(0, 0, BADGE_FOR[snap.presence], { fontSize: "12px" });
    badgeIcon.setOrigin(0.5, 0.5);
    const badgeBg = this.add.graphics();
    const badge = this.add.container(px + nameTag.displayWidth / 2 + 10, py - TILE * 0.95 - 6, [badgeBg, badgeIcon]);
    badge.setDepth(DEPTH_OVERLAY);

    const avatar: Avatar = {
      snap: { ...snap },
      sprite,
      shadow,
      nameTag,
      badge,
      badgeBg,
      badgeIcon,
      presence: snap.presence,
      walking: false,
    };
    this.drawBadgePill(avatar);
    this.avatars.set(snap.sessionId, avatar);
    this.applyDepth(avatar);
    this.applyPresenceAnim(avatar);
    // Newly joined NPCs respect the current hide-NPCs flag immediately.
    if (avatar.snap.isNpc && !this.npcVisible) this.applyAvatarVisibility(avatar, false);
    return avatar;
  }

  /** Show/hide every visual part of one avatar (sprite, shadow, tags, bubbles). */
  private applyAvatarVisibility(a: Avatar, visible: boolean): void {
    a.sprite.setVisible(visible);
    a.shadow.setVisible(visible);
    a.nameTag.setVisible(visible);
    // The badge has its own empty-state visibility; only force-show when the
    // presence actually has an icon, otherwise keep it hidden.
    a.badge.setVisible(visible && BADGE_FOR[a.presence] !== "");
    a.bubble?.setVisible(visible);
    a.emote?.setVisible(visible);
  }

  /** Redraw the dark pill behind the presence icon, or hide it when empty. */
  private drawBadgePill(a: Avatar): void {
    a.badgeBg.clear();
    const icon = BADGE_FOR[a.presence];
    // A hidden NPC's badge must stay hidden even when presence (and thus the
    // pill) is redrawn; otherwise it would reappear above an invisible avatar.
    const hiddenNpc = a.snap.isNpc === true && !this.npcVisible;
    a.badge.setVisible(icon !== "" && !hiddenNpc);
    if (icon === "") return;
    const w = a.badgeIcon.width + 8;
    const h = a.badgeIcon.height + 4;
    a.badgeBg.fillStyle(0x11151b, 0.78);
    a.badgeBg.fillRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    a.badgeBg.lineStyle(1, 0x2a323d, 0.9);
    a.badgeBg.strokeRoundedRect(-w / 2, -h / 2, w, h, h / 2);
  }

  private applyDepth(a: Avatar): void {
    a.sprite.setDepth(DEPTH_ENTITY_BASE + a.sprite.y);
    a.shadow.setDepth(DEPTH_ENTITY_BASE + a.sprite.y - 1);
  }

  private applyFacing(a: Avatar): void {
    if (a.walking) return;
    a.sprite.anims.stop();
    a.sprite.setFrame(frameIndex(poseDirFor(a.snap.dir)));
    this.applyPresenceAnim(a);
  }

  /** Idle posture by presence: FOCUS/BREAK/MEETING play their loop, else static. */
  private applyPresenceAnim(a: Avatar): void {
    if (a.walking) return;
    // Presence is purely cosmetic here; the scene plays the avatar idle anim.
    a.sprite.play(animKey(a.snap.avatarId, poseDirFor(a.snap.dir), "idle"), true);
  }

  private moveTags(a: Avatar): void {
    const px = a.sprite.x;
    const py = a.sprite.y;
    a.shadow.setPosition(px, py + 5);
    a.nameTag.setPosition(px, py - TILE * 0.95);
    a.badge.setPosition(px + a.nameTag.displayWidth / 2 + 10, py - TILE * 0.95 - 6);
    if (a.bubble) a.bubble.setPosition(px, py - TILE * 1.35);
    if (a.emote) a.emote.setPosition(px, py - TILE * 1.3);
  }

  // -------------------------------------------------------------------------
  // Local movement (grid-locked stepping)
  // -------------------------------------------------------------------------

  private pollDirection(): Direction | null {
    if (this.cursors.up.isDown || this.wasd.up.isDown) return "up";
    if (this.cursors.down.isDown || this.wasd.down.isDown) return "down";
    if (this.cursors.left.isDown || this.wasd.left.isDown) return "left";
    if (this.cursors.right.isDown || this.wasd.right.isDown) return "right";
    return null;
  }

  private stepLocal(a: Avatar, nx: number, ny: number, dir: Direction): void {
    a.snap.x = nx;
    a.snap.y = ny;
    a.snap.dir = dir;
    a.walking = true;
    a.sprite.play(animKey(a.snap.avatarId, poseDirFor(dir), "walk"), true);

    const tx = nx * TILE + TILE / 2;
    const ty = ny * TILE + TILE / 2;

    // Tell the server we committed a step (TILE coords on the wire).
    this.cb.onLocalMove(nx, ny, dir, true);

    a.stepTween = this.tweens.add({
      targets: a.sprite,
      x: tx,
      y: ty,
      duration: STEP_MS,
      ease: "Linear",
      onUpdate: () => {
        this.applyDepth(a);
        this.moveTags(a);
      },
      onComplete: () => {
        a.walking = false;
        a.stepTween = undefined;
        this.applyDepth(a);
        this.moveTags(a);
        this.reportArea(a);
        // If a movement key is still held the next update() continues walking;
        // otherwise settle to idle and tell the server we stopped.
        if (!this.inputLocked && this.pollDirection()) {
          // keep walking on next update()
        } else {
          this.applyFacing(a);
          this.cb.onLocalMove(a.snap.x, a.snap.y, a.snap.dir, false);
        }
      },
    });
  }

  private reportArea(a: Avatar): void {
    if (a.snap.sessionId !== this.selfId) return;
    const area = areaAt(this.map, a.snap.x, a.snap.y);
    const name = area?.name ?? "Hallway";
    if (name !== this.lastArea) {
      this.lastArea = name;
      this.cb.onAreaChange(name);
    }
    // Elevator/portal hint takes priority over lounge-game prompts: if the player
    // is on or next to a portal, advertise the destination. Stepping onto the
    // portal tile is a NORMAL move — the SERVER performs the floor change and
    // replies FLOOR_CHANGED (human agency: nothing auto-moves the avatar).
    if (this.checkPortalProximity(a.snap.x, a.snap.y)) return;
    this.checkGameProximity(a.snap.x, a.snap.y);
  }

  /** True if a portal hint was shown for (x,y). Hint shows when on/adjacent. */
  private checkPortalProximity(x: number, y: number): boolean {
    if (!this.cb.onInteractPrompt || this.portals.length === 0) return false;
    const near = this.portals.find(
      (p) => Math.abs(p.x - x) + Math.abs(p.y - y) <= 1,
    );
    if (!near) {
      if (this.currentPortalLabel !== null) {
        this.currentPortalLabel = null;
        // Clearing here is handled by the lounge check that runs next; we just
        // forget the label so re-entry re-announces it.
      }
      return false;
    }
    const onTile = near.x === x && near.y === y;
    const label = near.label ?? `Elevator → ${near.toFloorId}`;
    const text = onTile ? `${label} — step in to ride` : `${label} ↪ walk in`;
    this.currentPortalLabel = label;
    this.currentPromptGameId = undefined; // not an [E] interaction
    this.cb.onInteractPrompt(text);
    return true;
  }

  private checkGameProximity(x: number, y: number): void {
    if (!this.cb.onInteractPrompt) return;

    // Derive game stations from the active floor's furniture rather than
    // hardcoding a floor id + coordinates. This keeps the [E] prompts in sync
    // with wherever the lounge furniture actually lives (it sits on the rich
    // main-office floor, not the ground floor), and survives map edits.
    const station = this.gameStationNear(x, y);
    if (station) {
      this.currentPromptGameId = station.gameId;
      this.cb.onInteractPrompt(station.prompt, station.gameId);
      return;
    }

    this.currentPromptGameId = undefined;
    this.currentPortalLabel = null;
    this.cb.onInteractPrompt(null);
  }

  /**
   * If (x,y) is on or adjacent to a playable game furniture piece on the
   * current floor, return its station id + prompt text; otherwise undefined.
   * Adjacency is checked against the piece's full footprint (w×h), so multi-tile
   * tables (pool/ping-pong) prompt from the ring of tiles around them.
   */
  private gameStationNear(
    x: number,
    y: number,
  ): { gameId: GameStationId; prompt: string } | undefined {
    for (const f of this.map.furniture) {
      const station = GAME_STATIONS[f.kind as FurnitureKind];
      if (!station) continue;
      const nearX = x >= f.x - 1 && x <= f.x + f.w;
      const nearY = y >= f.y - 1 && y <= f.y + f.h;
      if (nearX && nearY) return station;
    }
    return undefined;
  }

  private tileOccupied(x: number, y: number): boolean {
    for (const a of this.avatars.values()) {
      if (a.snap.x === x && a.snap.y === y) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Public API for the UI bridge (remote players + self teleport/presence)
  // -------------------------------------------------------------------------

  setInputLocked(locked: boolean): void {
    this.inputLocked = locked;
  }

  /**
   * Swap the rendered world to a different floor (multi-floor support). The UI
   * bridge calls this on FLOOR_CHANGED (and may call it once right after WELCOME
   * to load the player's authoritative floor geometry fetched from /api/maps).
   *
   * It tears down the current floor's world + ALL avatars, rebuilds the world for
   * the new floor, re-creates the local avatar at `self` (x/y already set by the
   * server for the destination floor), adds every co-located remote player, and
   * snaps the camera to the local avatar behind a quick fade (instant under
   * reduced-motion). Human agency is intact: the SERVER decided the floor change
   * after the player's own committed step onto a portal; this only renders it.
   *
   * @param floor  the destination Floor geometry (areas/solid/desks/portals).
   * @param self   the local player's snapshot ON the new floor (authoritative x/y/dir).
   * @param others co-located remote players already on the new floor.
   */
  apiLoadFloor(floor: Floor, self: PlayerSnapshot, others: PlayerSnapshot[]): void {
    const swap = () => this.rebuildForFloor(floor, self, others);
    const cam = this.cameras.main;
    if (this.reducedMotion) {
      swap();
      return;
    }
    // Fade out, rebuild while black, then fade back in (a clean lift feel).
    cam.fadeOut(FLOOR_FADE_MS, 14, 17, 22);
    cam.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      swap();
      cam.fadeIn(FLOOR_FADE_MS, 14, 17, 22);
    });
  }

  /** Tear down the old floor + every avatar, then rebuild for the new floor. */
  private rebuildForFloor(floor: Floor, self: PlayerSnapshot, others: PlayerSnapshot[]): void {
    // 1. Remove every avatar (local + remote) — they belong to the old floor.
    for (const sessionId of [...this.avatars.keys()]) this.apiRemovePlayer(sessionId);

    // 2. Tear down the old world layer (floors, walls, furniture, labels, pads).
    this.teardownWorld();

    // 3. Point the scene at the new floor geometry.
    this.map = floor;
    this.portals = floor.portals ?? [];
    this.floorId = floor.id;
    this.selfStart = self;
    this.lastArea = "__force__";
    this.currentPortalLabel = null;
    this.currentPromptGameId = undefined;
    this.cb.onInteractPrompt?.(null);

    // 4. Rebuild the world + camera bounds for the new floor.
    this.drawWorld();
    this.cameras.main.setBounds(0, 0, this.map.width * TILE, this.map.height * TILE);

    // 5. Re-create the local avatar at the server-authoritative destination tile
    //    and snap the camera straight to it (no auto-walk — it just appears).
    this.spawnAvatar(self, true);
    const local = this.avatars.get(this.selfId)!;
    this.cameras.main.stopFollow();
    this.cameras.main.centerOn(local.sprite.x, local.sprite.y);
    this.cameras.main.startFollow(local.sprite, true, 0.15, 0.15);

    // 6. Add the co-located remote players already on the new floor.
    for (const p of others) this.apiAddPlayer(p);

    // 7. Announce the new area + portal/lounge prompts.
    this.reportArea(local);
  }

  /** Destroy everything drawWorld() created so the next floor starts clean. */
  private teardownWorld(): void {
    this.flickerTimer?.remove();
    this.flickerTimer = undefined;
    this.flickerPieces = [];
    this.flickerOn = false;
    for (const e of this.steamEmitters) e.destroy();
    this.steamEmitters = [];
    for (const obj of this.worldObjects) obj.destroy();
    this.worldObjects = [];
  }

  apiAddPlayer(snap: PlayerSnapshot): void {
    if (snap.sessionId === this.selfId) return; // self is owned by the scene
    const existing = this.avatars.get(snap.sessionId);
    if (existing) {
      existing.snap = { ...snap };
      this.placeInstant(existing, snap.x, snap.y);
      this.setPresenceBadge(existing, snap.presence);
      this.applyAvatarVisibility(existing, !existing.snap.isNpc || this.npcVisible);
      return;
    }
    this.spawnAvatar(snap, false);
  }

  apiRemovePlayer(sessionId: string): void {
    const a = this.avatars.get(sessionId);
    if (!a) return;
    a.stepTween?.stop();
    a.bubbleTimer?.remove();
    a.bubble?.destroy();
    a.emoteTimer?.remove();
    a.emote?.destroy();
    a.sprite.destroy();
    a.shadow.destroy();
    a.nameTag.destroy();
    a.badge.destroy(); // destroys child graphics + icon
    this.avatars.delete(sessionId);
  }

  apiMovePlayer(sessionId: string, x: number, y: number, dir: Direction, moving: boolean): void {
    if (sessionId === this.selfId) return; // never override local input
    const a = this.avatars.get(sessionId);
    if (!a) return;
    a.snap.dir = dir;

    if (a.snap.x === x && a.snap.y === y) {
      // Pure facing change / stop.
      a.walking = false;
      a.stepTween?.stop();
      a.stepTween = undefined;
      this.applyFacing(a);
      return;
    }

    a.snap.x = x;
    a.snap.y = y;
    a.walking = true;
    a.sprite.play(animKey(a.snap.avatarId, poseDirFor(dir), "walk"), true);

    const tx = x * TILE + TILE / 2;
    const ty = y * TILE + TILE / 2;
    a.stepTween?.stop();
    a.stepTween = this.tweens.add({
      targets: a.sprite,
      x: tx,
      y: ty,
      duration: STEP_MS,
      ease: "Linear",
      onUpdate: () => {
        this.applyDepth(a);
        this.moveTags(a);
      },
      onComplete: () => {
        a.stepTween = undefined;
        a.walking = false;
        this.applyDepth(a);
        this.moveTags(a);
        if (!moving) this.applyFacing(a);
      },
    });
  }

  apiTeleportPlayer(sessionId: string, x: number, y: number): void {
    const a = this.avatars.get(sessionId);
    if (!a) return;
    a.stepTween?.stop();
    a.stepTween = undefined;
    a.walking = false;
    // Dust puff at the departure tile and the arrival tile for a "poof" feel.
    this.dustPuff(a.snap.x, a.snap.y);
    a.snap.x = x;
    a.snap.y = y;
    this.placeInstant(a, x, y);
    this.dustPuff(x, y);
    if (sessionId === this.selfId) {
      this.lastArea = "__force__";
      this.reportArea(a);
    }
  }

  private placeInstant(a: Avatar, x: number, y: number): void {
    a.sprite.setPosition(x * TILE + TILE / 2, y * TILE + TILE / 2);
    this.applyDepth(a);
    this.moveTags(a);
    this.applyFacing(a);
  }

  apiSetPresence(sessionId: string, state: PresenceState): void {
    const a = this.avatars.get(sessionId);
    if (!a) return;
    this.setPresenceBadge(a, state);
  }

  apiPanToPlayer(sessionId: string): void {
    const a = this.avatars.get(sessionId);
    if (!a) return;
    this.panResumeTimer?.remove();
    this.panResumeTimer = undefined;
    this.cameras.main.stopFollow();
    this.cameras.main.pan(a.sprite.x, a.sprite.y, this.reducedMotion ? 0 : PAN_MS, "Sine.easeInOut");
    this.panResumeTimer = this.time.delayedCall(PAN_RESUME_MS, () => this.resumeFollowSelf());
  }

  /**
   * Camera-only pan to the nearest portal (elevator) on the CURRENT floor, then
   * resume following self. Never moves the avatar (human agency — the player
   * still has to walk into the elevator themselves). No-op when this floor has
   * no portals. Returns true if a portal was found and panned to.
   */
  apiPanToNearestPortal(): boolean {
    if (this.portals.length === 0) return false;
    const self = this.avatars.get(this.selfId);
    const fromX = self?.snap.x ?? this.selfStart.x;
    const fromY = self?.snap.y ?? this.selfStart.y;
    let nearest = this.portals[0];
    let best = Infinity;
    for (const p of this.portals) {
      const d = Math.abs(p.x - fromX) + Math.abs(p.y - fromY);
      if (d < best) {
        best = d;
        nearest = p;
      }
    }
    this.panResumeTimer?.remove();
    this.panResumeTimer = undefined;
    this.cameras.main.stopFollow();
    this.cameras.main.pan(
      nearest.x * TILE + TILE / 2,
      nearest.y * TILE + TILE / 2,
      this.reducedMotion ? 0 : PAN_MS,
      "Sine.easeInOut",
    );
    this.panResumeTimer = this.time.delayedCall(PAN_RESUME_MS, () => this.resumeFollowSelf());
    return true;
  }

  private resumeFollowSelf(): void {
    this.panResumeTimer?.remove();
    this.panResumeTimer = undefined;
    const self = this.avatars.get(this.selfId);
    if (!self) return;
    this.cameras.main.startFollow(self.sprite, true, 0.15, 0.15);
  }

  apiSetZoom(zoom: number): void {
    const next = Phaser.Math.Clamp(zoom, ZOOM_MIN, ZOOM_MAX);
    if (this.reducedMotion) {
      this.cameras.main.setZoom(next);
      return;
    }
    this.tweens.add({
      targets: this.cameras.main,
      zoom: next,
      duration: ZOOM_TWEEN_MS,
      ease: "Sine.easeInOut",
    });
  }

  apiSetNpcVisibility(visible: boolean): void {
    this.npcVisible = visible;
    for (const a of this.avatars.values()) {
      if (a.snap.isNpc) this.applyAvatarVisibility(a, visible);
    }
  }

  apiSetReducedMotion(on: boolean): void {
    this.reducedMotion = on;
    for (const emitter of this.steamEmitters) {
      if (on) emitter.stop();
      else emitter.start();
    }
  }

  /** The floor id currently rendered (for the UI minimap / floor readout). */
  apiCurrentFloorId(): string {
    return this.floorId;
  }

  private setPresenceBadge(a: Avatar, state: PresenceState): void {
    a.presence = state;
    a.snap.presence = state;
    a.badgeIcon.setText(BADGE_FOR[state]);
    this.drawBadgePill(a);
  }

  apiShowBubble(sessionId: string, text: string): void {
    const a = this.avatars.get(sessionId);
    if (!a) return;
    a.bubbleTimer?.remove();
    a.bubble?.destroy();

    const clipped = text.length > BUBBLE_MAX_CHARS ? text.slice(0, BUBBLE_MAX_CHARS - 1) + "…" : text;
    const label = this.add.text(0, 0, clipped, {
      fontFamily: "monospace",
      fontSize: "11px",
      color: "#16202b",
      wordWrap: { width: 160 },
      align: "center",
    });
    label.setOrigin(0.5, 0.5);
    const pad = 5;
    const bg = this.add.graphics();
    const w = label.width + pad * 2;
    const h = label.height + pad * 2;
    bg.fillStyle(0xf4f6f8, 0.96);
    bg.fillRoundedRect(-w / 2, -h / 2, w, h, 5);
    bg.fillTriangle(-5, h / 2 - 1, 5, h / 2 - 1, 0, h / 2 + 6);

    const container = this.add.container(a.sprite.x, a.sprite.y - TILE * 1.35, [bg, label]);
    container.setDepth(DEPTH_OVERLAY + 1);
    a.bubble = container;
    a.bubbleTimer = this.time.delayedCall(BUBBLE_MS, () => {
      container.destroy();
      a.bubble = undefined;
      a.bubbleTimer = undefined;
    });
  }

  /** Float a small cloud of the emoji up from the avatar's head, drifting apart
   *  and fading into thin air (Google Meet / Zoom / YouTube-Live reaction style). */
  apiShowEmote(sessionId: string, emote: string): void {
    const a = this.avatars.get(sessionId);
    if (!a) return;
    const glyph = EMOTE_EMOJI[emote as Emote] ?? emote;
    const font = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    const baseX = a.sprite.x;
    const baseY = a.sprite.y - TILE * 0.9;
    const count = this.reducedMotion ? 1 : 6;

    for (let i = 0; i < count; i++) {
      // Stagger spawns so they rise as a stream rather than a single clump.
      this.time.delayedCall(i * 90, () => {
        if (!this.avatars.has(sessionId)) return;
        const startX = baseX + (Math.random() - 0.5) * 26;
        const label = this.add.text(startX, baseY, glyph, {
          fontFamily: font,
          fontSize: `${16 + Math.round(Math.random() * 12)}px`,
        });
        label.setOrigin(0.5, 0.5).setDepth(DEPTH_OVERLAY + 2);

        const rise = 80 + Math.random() * 70;
        const drift = (Math.random() - 0.5) * 60;
        const dur = EMOTE_MS * (0.6 + Math.random() * 0.4);

        if (this.reducedMotion) {
          this.tweens.add({
            targets: label,
            y: baseY - rise,
            alpha: 0,
            duration: dur,
            onComplete: () => label.destroy(),
          });
          return;
        }

        // Pop in, rise + drift outward, then dissolve in the final stretch.
        label.setScale(0.3);
        this.tweens.add({ targets: label, scale: 1, duration: 180, ease: "Back.easeOut" });
        this.tweens.add({
          targets: label,
          x: startX + drift,
          y: baseY - rise,
          duration: dur,
          ease: "Sine.easeOut",
        });
        this.tweens.add({
          targets: label,
          alpha: 0,
          delay: dur * 0.45,
          duration: dur * 0.55,
          onComplete: () => label.destroy(),
        });
      });
    }
  }

  /** Apply a profile change (name / department / avatar) to a player avatar. */
  apiUpdatePlayer(
    sessionId: string,
    profile: { name: string; department: PlayerSnapshot["department"]; avatarId: PlayerSnapshot["avatarId"] },
  ): void {
    const a = this.avatars.get(sessionId);
    if (!a) return;
    const isSelf = sessionId === this.selfId;
    a.snap.name = profile.name;
    a.snap.department = profile.department;
    const avatarChanged = a.snap.avatarId !== profile.avatarId;
    a.snap.avatarId = profile.avatarId;

    a.nameTag.setText(isSelf ? `${profile.name} (you)` : profile.name);

    if (avatarChanged) {
      // Swap the avatar sheet and re-apply the current pose/animation.
      a.sprite.anims.stop();
      a.sprite.setTexture(TEX.avatarSheet(profile.avatarId));
      a.sprite.setFrame(frameIndex(poseDirFor(a.snap.dir)));
      if (a.walking) {
        a.sprite.play(animKey(profile.avatarId, poseDirFor(a.snap.dir), "walk"), true);
      } else {
        this.applyPresenceAnim(a);
      }
    }
    // Name width may have changed; reposition the name tag + presence badge.
    this.moveTags(a);
  }
}
