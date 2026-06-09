// ---------------------------------------------------------------------------
// Public game-layer entry point. This is the ONLY surface the UI layer touches
// (CONTRACT.md: game <-> UI boundary). It boots a Phaser game with the office
// scene and returns an imperative handle the UI bridge drives from network
// messages. The game owns the local avatar; the UI never reaches into Phaser.
//
// Pure rendering layer: NO network, NO presence/meeting business logic here.
// ---------------------------------------------------------------------------

import Phaser from "phaser";
import type { Direction, Floor, PlayerSnapshot, PresenceState } from "@pixeloffice/shared";
import { BG_COLOR_NUM } from "./constants";
import { OfficeScene } from "./scene";

export interface OfficeGameHandle {
  addPlayer(p: PlayerSnapshot): void; // remote players only
  removePlayer(sessionId: string): void;
  /** Apply a profile change (name/department/avatar) to any player, incl. self. */
  updatePlayer(
    sessionId: string,
    profile: { name: string; department: PlayerSnapshot["department"]; avatarId: PlayerSnapshot["avatarId"] },
  ): void;
  movePlayer(sessionId: string, x: number, y: number, dir: Direction, moving: boolean): void;
  teleportPlayer(sessionId: string, x: number, y: number): void; // may target self
  setPresence(sessionId: string, state: PresenceState): void; // also accepts self sessionId
  showChatBubble(sessionId: string, text: string): void; // also accepts self sessionId
  /** Lock keyboard movement while the user is typing in the HUD (chat focus). */
  setInputLocked(locked: boolean): void;
  /** Pop an emote bubble above an avatar's name tag (also accepts self sessionId). */
  showEmote(sessionId: string, emote: string): void;
  /** Smooth-pan the camera to an avatar, then resume following self. Never moves avatars. */
  panToPlayer(sessionId: string): void;
  /**
   * Smooth-pan the camera to the nearest elevator/portal on the CURRENT floor,
   * then resume following self. Camera-only — never moves the avatar (the player
   * must still walk into the elevator). No-op (returns false) on a floor with no
   * portals.
   */
  panToNearestPortal(): boolean;
  /** Set the camera zoom (clamped to ZOOM_MIN..ZOOM_MAX) with a smooth tween. */
  setZoom(zoom: number): void;
  /** Show/hide every NPC avatar (sprite, shadow, tag, badge, bubbles). */
  setNpcVisibility(visible: boolean): void;
  /** When on, skip decorative tweens (emote bounce, camera pan, dust, steam). */
  setReducedMotion(on: boolean): void;
  /**
   * Swap the rendered world to a different floor (multi-floor support).
   *
   * Call this on the network FLOOR_CHANGED message — and OPTIONALLY once right
   * after WELCOME to load the player's authoritative floor geometry (fetched
   * from `GET /api/maps/active`, then look up `building.floors` by `self.floorId`).
   *
   * It tears down the current floor's world + every avatar, rebuilds the world
   * for `floor`, re-creates the local avatar at `self` (the server already set
   * `self.x/y/dir` for the destination floor), adds the co-located `others`, and
   * snaps the camera to the local avatar behind a quick fade (instant under
   * reduced-motion). It NEVER auto-walks an avatar — the server already decided
   * the floor change from the player's own committed step (human agency).
   */
  setActiveFloor(floor: Floor, self: PlayerSnapshot, others: PlayerSnapshot[]): void;
  /** The floor id currently being rendered (for a minimap / floor readout). */
  currentFloorId(): string;
  destroy(): void;
}

export interface CreateGameOptions {
  parent: HTMLElement;
  self: PlayerSnapshot; // the game creates and controls the local avatar itself
  /**
   * The geometry of the player's current floor (multi-floor support). OPTIONAL
   * and backward-compatible: when omitted the game renders the legacy single
   * office (`buildOfficeMap()`), which matches the default building's Ground
   * floor — the UI bridge can then call `setActiveFloor()` once it has fetched
   * the authoritative geometry from `GET /api/maps/active`.
   */
  floor?: Floor;
  onLocalMove(x: number, y: number, dir: Direction, moving: boolean): void;
  onAreaChange?(areaName: string): void; // local player entered a named area ("Hallway" when none)
  onInteractPrompt?(prompt: string | null, gameId?: string): void;
  onGameInteract?(gameId: string): void;
  /** Local player pressed [E] at a department's white table (open its board). */
  onWhiteboardInteract?(department: string): void;
  /** The local user double-clicked their own avatar (open the profile modal). */
  onProfileOpen?(): void;
}

export function createOfficeGame(opts: CreateGameOptions): Promise<OfficeGameHandle> {
  return new Promise((resolve) => {
    const scene = new OfficeScene();

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: opts.parent,
      backgroundColor: BG_COLOR_NUM,
      pixelArt: true,
      roundPixels: true,
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      render: { antialias: false },
      // No scene in the config: scenes given here auto-start with empty data,
      // which would run init() before we can hand it the self snapshot.
    });

    const callbacks = {
      onLocalMove: opts.onLocalMove,
      onAreaChange: (areaName: string) => opts.onAreaChange?.(areaName),
      onInteractPrompt: (prompt: string | null, gameId?: string) => opts.onInteractPrompt?.(prompt, gameId),
      onProfileOpen: () => opts.onProfileOpen?.(),
    };

    // Listen for interact event from the scene and bridge it to the UI
    game.events.on("lounge-game-interact", (gameId: string) => {
      opts.onGameInteract?.(gameId);
    });
    game.events.on("whiteboard-interact", (department: string) => {
      opts.onWhiteboardInteract?.(department);
    });

    // Resolve only once the scene's create() has built the local avatar, so the
    // UI bridge can safely target self (teleport/presence) from the first message.
    game.events.once("office-ready", () => {
      resolve(makeHandle(game, scene));
    });

    // Add the scene WITHOUT auto-start, then start it with the local snapshot
    // + callbacks so init() always receives its data.
    game.events.once(Phaser.Core.Events.READY, () => {
      game.scene.add("office", scene, false);
      game.scene.start("office", { self: opts.self, cb: callbacks, floor: opts.floor });
    });
  });
}

function makeHandle(game: Phaser.Game, scene: OfficeScene): OfficeGameHandle {
  return {
    addPlayer(p) {
      scene.apiAddPlayer(p);
    },
    removePlayer(sessionId) {
      scene.apiRemovePlayer(sessionId);
    },
    updatePlayer(sessionId, profile) {
      scene.apiUpdatePlayer(sessionId, profile);
    },
    movePlayer(sessionId, x, y, dir, moving) {
      scene.apiMovePlayer(sessionId, x, y, dir, moving);
    },
    teleportPlayer(sessionId, x, y) {
      scene.apiTeleportPlayer(sessionId, x, y);
    },
    setPresence(sessionId, state) {
      scene.apiSetPresence(sessionId, state);
    },
    showChatBubble(sessionId, text) {
      scene.apiShowBubble(sessionId, text);
    },
    setInputLocked(locked) {
      scene.setInputLocked(locked);
    },
    showEmote(sessionId, emote) {
      scene.apiShowEmote(sessionId, emote);
    },
    panToPlayer(sessionId) {
      scene.apiPanToPlayer(sessionId);
    },
    panToNearestPortal() {
      return scene.apiPanToNearestPortal();
    },
    setZoom(zoom) {
      scene.apiSetZoom(zoom);
    },
    setNpcVisibility(visible) {
      scene.apiSetNpcVisibility(visible);
    },
    setReducedMotion(on) {
      scene.apiSetReducedMotion(on);
    },
    setActiveFloor(floor, self, others) {
      scene.apiLoadFloor(floor, self, others);
    },
    currentFloorId() {
      return scene.apiCurrentFloorId();
    },
    destroy() {
      // Explicitly release the WebGL context. Phaser's WebGLRenderer.destroy()
      // nulls its GL wrappers but never calls loseContext(), so the orphaned
      // context only frees on (non-deterministic) GC. Browsers cap live WebGL
      // contexts (~16 in Chrome); since we destroy+recreate the whole game on
      // every reconnect, accumulating contexts can force-lose the live one and
      // break rendering. Capture gl BEFORE destroy (which nulls renderer.gl).
      const renderer = game.renderer as unknown as { gl?: WebGLRenderingContext | null };
      const gl = renderer?.gl ?? null;
      game.destroy(true);
      if (gl) {
        const ext = gl.getExtension("WEBGL_lose_context");
        ext?.loseContext();
      }
    },
  };
}
