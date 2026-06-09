import type {
  ActiveGame,
  PongState,
  TicTacToeState,
  ConnectFourState,
  PoolState,
  PoolBall,
} from "@pixeloffice/shared";
import {
  POOL_TABLE_W,
  POOL_TABLE_H,
  POOL_BALL_R,
  POOL_POCKET_R,
  POOL_POCKETS,
  POOL_AI_SESSION_ID,
} from "@pixeloffice/shared";
import type { Store } from "./state";
import type { HudCallbacks } from "./hud";

export interface GameOverlayHandle {
  render(game: ActiveGame): void;
  destroy(): void;
}

export function mountGameOverlay(
  parent: HTMLElement,
  store: Store,
  callbacks: HudCallbacks
): GameOverlayHandle {
  const dialog = document.createElement("dialog");
  dialog.className = "game-dialog";
  dialog.setAttribute("closedby", "any");
  dialog.setAttribute("aria-labelledby", "game-dialog-title");
  parent.appendChild(dialog);

  // Fallback for click-outside dismissal
  if (!("closedBy" in HTMLDialogElement.prototype)) {
    dialog.addEventListener("click", (e) => {
      if (e.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const clickInside = (
        rect.top <= e.clientY &&
        e.clientY <= rect.top + rect.height &&
        rect.left <= e.clientX &&
        e.clientX <= rect.left + rect.width
      );
      if (!clickInside) {
        closeAndLeave();
      }
    });
  }

  // Handle ESC key or cancel event
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeAndLeave();
  });

  dialog.showModal();

  let activeGameId: string | null = null;
  let lastPongDir: "up" | "down" | "stop" = "stop";
  let activeHandlers: (() => void)[] = [];
  let poolView: PoolView | null = null;

  function closeAndLeave() {
    if (activeGameId) {
      callbacks.onLeaveGame(activeGameId);
    }
  }

  function setupPongInput(gameId: string, _role: "player1" | "player2") {
    const handleKeyDown = (e: KeyboardEvent) => {
      let dir: "up" | "down" | null = null;
      if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") {
        dir = "up";
      } else if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") {
        dir = "down";
      }

      if (dir && dir !== lastPongDir) {
        lastPongDir = dir;
        callbacks.onGameInput(gameId, { dir });
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (
        (e.key === "ArrowUp" || e.key === "w" || e.key === "W") && lastPongDir === "up" ||
        (e.key === "ArrowDown" || e.key === "s" || e.key === "S") && lastPongDir === "down"
      ) {
        lastPongDir = "stop";
        callbacks.onGameInput(gameId, { dir: "stop" });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    activeHandlers.push(() => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    });
  }

  function clearInputHandlers() {
    for (const dispose of activeHandlers) dispose();
    activeHandlers = [];
    lastPongDir = "stop";
  }

  function disposePoolView() {
    if (poolView) {
      poolView.destroy();
      poolView = null;
    }
  }

  return {
    render(game: ActiveGame) {
      activeGameId = game.id;
      const selfId = store.get().selfId;

      // --- POOL: a persistent, self-animating view ------------------------
      // Pool owns its own DOM subtree + canvas + animation loop, so it must
      // survive the per-frame re-render (the other games rebuild from scratch).
      if (game.type === "pool") {
        clearInputHandlers(); // pool uses pointer input on the canvas, not keys
        if (!poolView) {
          dialog.innerHTML = "";
          poolView = mountPoolView(dialog, store, callbacks, () => closeAndLeave());
        }
        poolView.update(game);
        return;
      }
      disposePoolView();

      const isPlayer1 = game.player1?.sessionId === selfId;
      const isPlayer2 = game.player2?.sessionId === selfId;
      const myRole = isPlayer1 ? "player1" : isPlayer2 ? "player2" : null;

      // If playing pong and handlers are empty, set them up
      if (game.type === "ping-pong" && game.status === "playing" && myRole && activeHandlers.length === 0) {
        setupPongInput(game.id, myRole);
      } else if (game.status !== "playing" || !myRole) {
        clearInputHandlers();
      }

      // Title & Header details
      let titleStr = "";
      if (game.type === "ping-pong") titleStr = "Table Tennis (Pong)";
      else if (game.type === "tic-tac-toe") titleStr = "Tic-Tac-Toe";
      else if (game.type === "connect-four") titleStr = "Connect Four";

      dialog.innerHTML = "";

      const header = document.createElement("div");
      header.className = "game-header";

      const title = document.createElement("h2");
      title.id = "game-dialog-title";
      title.className = "game-title";
      title.textContent = titleStr;

      const leaveBtn = document.createElement("button");
      leaveBtn.className = "game-leave-btn";
      leaveBtn.textContent = "✕";
      leaveBtn.title = "Leave Game";
      leaveBtn.addEventListener("click", closeAndLeave);

      header.append(title, leaveBtn);
      dialog.appendChild(header);

      // Scoreboard / Players Info
      const scoreboard = document.createElement("div");
      scoreboard.className = "game-scoreboard";

      const p1Div = document.createElement("div");
      p1Div.className = `game-player-badge p1 ${isPlayer1 ? "self" : ""}`;
      p1Div.innerHTML = `
        <span class="game-avatar-icon dept-chip" data-dept="Engineering">${game.player1 ? game.player1.name : "Empty"}</span>
        <span class="game-score">${game.score1}</span>
      `;

      const vs = document.createElement("span");
      vs.className = "game-vs";
      vs.textContent = "VS";

      const p2Div = document.createElement("div");
      p2Div.className = `game-player-badge p2 ${isPlayer2 ? "self" : ""}`;
      p2Div.innerHTML = `
        <span class="game-score">${game.score2}</span>
        <span class="game-avatar-icon dept-chip" data-dept="Design">${game.player2 ? game.player2.name : "Waiting..."}</span>
      `;

      scoreboard.append(p1Div, vs, p2Div);
      dialog.appendChild(scoreboard);

      // Main content block based on status
      const content = document.createElement("div");
      content.className = "game-content";

      if (game.status === "waiting") {
        const lobby = document.createElement("div");
        lobby.className = "game-lobby";
        lobby.innerHTML = `
          <div class="lobby-spinner"></div>
          <p class="lobby-text">Waiting for an opponent to join...</p>
        `;
        content.appendChild(lobby);
      } else if (game.status === "playing") {
        const turnInfo = document.createElement("div");
        turnInfo.className = "game-turn-info";

        if (game.type === "ping-pong") {
          turnInfo.textContent = "Use Arrow Keys or W/S to move paddle!";
          content.appendChild(turnInfo);

          const canvas = document.createElement("canvas");
          canvas.width = 600;
          canvas.height = 400;
          canvas.className = "pong-canvas";
          content.appendChild(canvas);

          const ctx = canvas.getContext("2d");
          if (ctx && game.state) {
            const state = game.state as PongState;
            ctx.fillStyle = "#0e1116";
            ctx.fillRect(0, 0, 600, 400);

            // Draw dashed center line
            ctx.strokeStyle = "rgba(230, 236, 242, 0.15)";
            ctx.lineWidth = 4;
            ctx.setLineDash([10, 10]);
            ctx.beginPath();
            ctx.moveTo(300, 0);
            ctx.lineTo(300, 400);
            ctx.stroke();
            ctx.setLineDash([]);

            // Draw paddles
            ctx.fillStyle = "#ef6258"; // Player 1 Red
            ctx.fillRect(20, state.paddle1Y, 10, 80);

            ctx.fillStyle = "#3ecf6e"; // Player 2 Green
            ctx.fillRect(570, state.paddle2Y, 10, 80);

            // Draw Ball
            ctx.fillStyle = "#e6ecf2";
            ctx.beginPath();
            ctx.arc(state.ballX, state.ballY, 6, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (game.type === "tic-tac-toe") {
          const state = game.state as TicTacToeState;
          const isMyTurn = state.turn === selfId;
          turnInfo.textContent = isMyTurn ? "Your turn!" : "Opponent's turn...";
          turnInfo.className = `game-turn-info ${isMyTurn ? "active" : ""}`;
          content.appendChild(turnInfo);

          const grid = document.createElement("div");
          grid.className = "ttt-grid";

          for (let i = 0; i < 9; i++) {
            const cell = document.createElement("button");
            cell.className = "ttt-cell";
            const val = state.board[i];
            cell.textContent = val;
            if (val === "X") cell.style.color = "#ef6258";
            else if (val === "O") cell.style.color = "#2e6fd8";

            if (val === "" && isMyTurn && myRole) {
              cell.addEventListener("click", () => {
                callbacks.onGameInput(game.id, { cellIndex: i });
              });
            } else {
              cell.disabled = true;
            }
            grid.appendChild(cell);
          }
          content.appendChild(grid);
        } else if (game.type === "connect-four") {
          const state = game.state as ConnectFourState;
          const isMyTurn = state.turn === selfId;
          turnInfo.textContent = isMyTurn ? "Your turn!" : "Opponent's turn...";
          turnInfo.className = `game-turn-info ${isMyTurn ? "active" : ""}`;
          content.appendChild(turnInfo);

          const boardContainer = document.createElement("div");
          boardContainer.className = "c4-container";

          // Column drop indicators / triggers
          const columnHeader = document.createElement("div");
          columnHeader.className = "c4-header-row";
          for (let c = 0; c < 7; c++) {
            const colBtn = document.createElement("button");
            colBtn.className = "c4-col-btn";
            colBtn.innerHTML = "▼";

            // Check if column is full
            const colFull = state.board[0][c] !== "";
            if (isMyTurn && myRole && !colFull) {
              colBtn.addEventListener("click", () => {
                callbacks.onGameInput(game.id, { colIndex: c });
              });
            } else {
              colBtn.disabled = true;
            }
            columnHeader.appendChild(colBtn);
          }
          boardContainer.appendChild(columnHeader);

          const grid = document.createElement("div");
          grid.className = "c4-grid";

          for (let r = 0; r < 6; r++) {
            for (let c = 0; c < 7; c++) {
              const slot = document.createElement("div");
              slot.className = "c4-slot";
              const token = state.board[r][c];
              if (token === "R") {
                slot.classList.add("red");
              } else if (token === "Y") {
                slot.classList.add("yellow");
              }
              grid.appendChild(slot);
            }
          }
          boardContainer.appendChild(grid);
          content.appendChild(boardContainer);
        }
      } else if (game.status === "gameover") {
        const gameOverDiv = document.createElement("div");
        gameOverDiv.className = "game-over-banner";

        const bannerTitle = document.createElement("h3");
        if (game.winnerSessionId === selfId) {
          bannerTitle.textContent = "VICTORY!";
          bannerTitle.style.color = "#3ecf6e";
          bannerTitle.className = "banner-victory animate-victory";
        } else if (game.winnerSessionId === null) {
          bannerTitle.textContent = "DRAW GAME";
          bannerTitle.style.color = "#e6ecf2";
        } else {
          bannerTitle.textContent = "DEFEAT";
          bannerTitle.style.color = "#ef6258";
        }

        const statsDiv = document.createElement("div");
        statsDiv.className = "game-over-stats";
        statsDiv.innerHTML = `<p>Final Score: ${game.score1} - ${game.score2}</p>`;

        const actionBtn = document.createElement("button");
        actionBtn.className = "game-over-btn";
        actionBtn.textContent = "Return to Office";
        actionBtn.addEventListener("click", closeAndLeave);

        gameOverDiv.append(bannerTitle, statsDiv, actionBtn);
        content.appendChild(gameOverDiv);
      }

      dialog.appendChild(content);
    },
    destroy() {
      clearInputHandlers();
      disposePoolView();
      dialog.close();
      dialog.remove();
    },
  };
}

// ===========================================================================
// 8-Ball Pool view (server-authoritative; this is rendering + input ONLY).
//
// All physics/rules/AI live server-side; this view (a) draws the table + balls
// from PoolState, (b) replays the per-shot `trajectory` for smooth motion then
// settles on the authoritative rest `balls`, (c) captures a click-drag aim +
// power on the local player's turn and sends a PoolShotInput via onGameInput,
// and (d) lets the player re-spot the cue when ballInHand. It owns a persistent
// DOM subtree + a requestAnimationFrame loop, so the overlay keeps it alive
// across re-renders instead of rebuilding it every frame (which would kill the
// animation + drag).
// ===========================================================================

interface PoolView {
  /** Apply a fresh ActiveGame snapshot (called on every render). */
  update(game: ActiveGame): void;
  /** Tear down the loop + listeners + DOM. */
  destroy(): void;
}

/** Pixel scale: table units -> px. 200x100 tu * 3 = 600x300 px playfield. */
const POOL_SCALE = 3;
const POOL_PAD = 22; // px cushion/rail border around the playfield
const POOL_CANVAS_W = POOL_TABLE_W * POOL_SCALE + POOL_PAD * 2;
const POOL_CANVAS_H = POOL_TABLE_H * POOL_SCALE + POOL_PAD * 2;

/** Solid ball face colors by id (1..7 solids, 8 black, 9..15 stripe base). */
const POOL_BALL_COLORS: Record<number, string> = {
  1: "#f2c200", // yellow
  2: "#1f6fd8", // blue
  3: "#ef6258", // red
  4: "#7a52c7", // purple
  5: "#e8801f", // orange
  6: "#2f9e57", // green
  7: "#9c3b34", // maroon
  8: "#15181d", // black (eight)
  9: "#f2c200",
  10: "#1f6fd8",
  11: "#ef6258",
  12: "#7a52c7",
  13: "#e8801f",
  14: "#2f9e57",
  15: "#9c3b34",
};

function mountPoolView(
  dialog: HTMLElement,
  store: Store,
  callbacks: HudCallbacks,
  leave: () => void
): PoolView {
  // --- DOM shell ----------------------------------------------------------
  const header = document.createElement("div");
  header.className = "game-header";
  const title = document.createElement("h2");
  title.id = "game-dialog-title";
  title.className = "game-title";
  title.textContent = "8-Ball Pool";
  const leaveBtn = document.createElement("button");
  leaveBtn.className = "game-leave-btn";
  leaveBtn.textContent = "✕";
  leaveBtn.title = "Leave Game";
  leaveBtn.addEventListener("click", leave);
  header.append(title, leaveBtn);

  const scoreboard = document.createElement("div");
  scoreboard.className = "game-scoreboard pool-scoreboard";

  const banner = document.createElement("div");
  banner.className = "game-turn-info pool-banner";

  // Chooser (idle / waiting-as-host entry menu).
  const chooser = document.createElement("div");
  chooser.className = "pool-chooser";

  // Play area: canvas + power meter.
  const playArea = document.createElement("div");
  playArea.className = "pool-play";

  const tableWrap = document.createElement("div");
  tableWrap.className = "pool-table-wrap";
  const canvas = document.createElement("canvas");
  canvas.width = POOL_CANVAS_W;
  canvas.height = POOL_CANVAS_H;
  canvas.className = "pool-canvas";
  tableWrap.appendChild(canvas);

  const powerWrap = document.createElement("div");
  powerWrap.className = "pool-power";
  const powerFill = document.createElement("i");
  powerWrap.appendChild(powerFill);
  const powerLabel = document.createElement("span");
  powerLabel.className = "pool-power-label";

  playArea.append(tableWrap, powerWrap, powerLabel);

  // Potted tray.
  const tray = document.createElement("div");
  tray.className = "pool-tray";

  // Gameover banner.
  const overBanner = document.createElement("div");
  overBanner.className = "game-over-banner pool-over";
  overBanner.style.display = "none";

  dialog.append(header, scoreboard, banner, chooser, playArea, tray, overBanner);

  const ctx = canvas.getContext("2d");

  // --- Mutable view state -------------------------------------------------
  let game: ActiveGame | null = null;
  let rafId = 0;
  // Animation: when a new trajectory arrives we replay it frame-by-frame.
  let anim: { frames: PoolState["trajectory"]; idx: number; t: number } | null = null;
  let lastTrajectoryRef: PoolState["trajectory"] | undefined; // identity guard
  // The ball positions currently being PAINTED (interpolated during replay,
  // else the authoritative rest positions).
  let renderBalls: PoolBall[] = [];

  // Aim/power drag state (local turn only).
  let dragging = false;
  let aimAngle = 0;
  let aimPower = 0;
  let hoverAngle: number | null = null;

  // Ball-in-hand re-spot: a pending cue position (table units) the player set.
  let respot: { x: number; y: number } | null = null;
  let draggingCue = false;

  // True between clicking "Play again" and the server's fresh GAME_UPDATE landing.
  // Keeps the game-over banner hidden so the overlay never sticks on the terminal
  // screen while we wait for the re-racked table.
  let rematchPending = false;

  function selfId(): string {
    return store.get().selfId;
  }
  function poolState(): PoolState | null {
    return (game?.state as PoolState | undefined) ?? null;
  }
  function isSeated(): boolean {
    return (
      game?.player1?.sessionId === selfId() ||
      game?.player2?.sessionId === selfId()
    );
  }
  function isMyTurn(): boolean {
    const s = poolState();
    return !!s && s.currentTurn === selfId() && isSeated();
  }
  function canShoot(): boolean {
    const s = poolState();
    return !!s && isMyTurn() && !s.animating && game?.status === "playing" && !anim;
  }

  // --- Geometry helpers (tu <-> px) --------------------------------------
  function tuToPx(x: number, y: number): { px: number; py: number } {
    return { px: POOL_PAD + x * POOL_SCALE, py: POOL_PAD + y * POOL_SCALE };
  }
  function pxToTu(clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    // Account for CSS scaling of the canvas.
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    const cx = (clientX - rect.left) * sx;
    const cy = (clientY - rect.top) * sy;
    return { x: (cx - POOL_PAD) / POOL_SCALE, y: (cy - POOL_PAD) / POOL_SCALE };
  }
  function cueBall(): PoolBall | undefined {
    return renderBalls.find((b) => b.id === 0 && !b.pocketed);
  }

  // --- Pointer input on the canvas ---------------------------------------
  const onPointerDown = (e: PointerEvent) => {
    const s = poolState();
    if (!s) return;
    const pt = pxToTu(e.clientX, e.clientY);

    // Ball-in-hand: clicking near the cue (or anywhere on a fresh ball-in-hand)
    // begins a cue re-spot drag.
    if (s.ballInHand && isMyTurn() && !s.animating && !anim) {
      const cue = cueBall();
      const near =
        cue && Math.hypot(pt.x - cue.x, pt.y - cue.y) < POOL_BALL_R * 3;
      if (near || !cue) {
        draggingCue = true;
        respot = clampCue(pt.x, pt.y);
        canvas.setPointerCapture(e.pointerId);
        return;
      }
    }

    if (!canShoot()) return;
    const cue = cueBall();
    if (!cue) return;
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    updateAimFromPointer(pt, cue);
  };

  const onPointerMove = (e: PointerEvent) => {
    const pt = pxToTu(e.clientX, e.clientY);
    if (draggingCue) {
      respot = clampCue(pt.x, pt.y);
      return;
    }
    const cue = cueBall();
    if (!cue) return;
    if (dragging) {
      updateAimFromPointer(pt, cue);
    } else if (canShoot()) {
      // Live aim guide following the cursor (angle only, no power yet).
      hoverAngle = Math.atan2(pt.y - cue.y, pt.x - cue.x);
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    if (draggingCue) {
      draggingCue = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      return;
    }
    if (!dragging) return;
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (aimPower <= 0.02) {
      aimPower = 0;
      return; // a tap with no pull cancels the shot
    }
    const input: { angleRad: number; power: number; cueX?: number; cueY?: number } = {
      angleRad: aimAngle,
      power: Math.max(0, Math.min(1, aimPower)),
    };
    const s = poolState();
    if (s?.ballInHand && respot) {
      input.cueX = respot.x;
      input.cueY = respot.y;
    }
    if (game) callbacks.onGameInput(game.id, input);
    aimPower = 0;
    respot = null;
    hoverAngle = null;
  };

  const onPointerLeave = () => {
    if (!dragging && !draggingCue) hoverAngle = null;
  };

  // Drag AWAY from the cue ball aims TOWARD the cue ball (like pulling a cue
  // stick back): the shot fires in the direction from the pointer to the cue.
  // Drag distance maps to power.
  function updateAimFromPointer(pt: { x: number; y: number }, cue: PoolBall) {
    const dx = cue.x - pt.x;
    const dy = cue.y - pt.y;
    aimAngle = Math.atan2(dy, dx);
    const dist = Math.hypot(pt.x - cue.x, pt.y - cue.y);
    // Full power at ~half the table width of pull.
    aimPower = Math.max(0, Math.min(1, dist / (POOL_TABLE_W * 0.5)));
  }

  function clampCue(x: number, y: number): { x: number; y: number } {
    const r = POOL_BALL_R;
    return {
      x: Math.max(r, Math.min(POOL_TABLE_W - r, x)),
      y: Math.max(r, Math.min(POOL_TABLE_H - r, y)),
    };
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);

  // --- Per-frame paint ----------------------------------------------------
  function step(dt: number) {
    advanceAnimation(dt);
    paint();
    rafId = requestAnimationFrame(stepWrap);
  }
  let lastTs = 0;
  function stepWrap(ts: number) {
    const dt = lastTs ? (ts - lastTs) / 1000 : 0;
    lastTs = ts;
    step(Math.min(dt, 0.05));
  }

  function advanceAnimation(dt: number) {
    if (!anim || !anim.frames || anim.frames.length === 0) return;
    // ~120 frames/sec of playback through the downsampled trajectory.
    const FPS = 120;
    anim.t += dt * FPS;
    while (anim.t >= 1 && anim.idx < anim.frames.length - 1) {
      anim.t -= 1;
      anim.idx++;
    }
    const frames = anim.frames;
    if (anim.idx >= frames.length - 1) {
      // Done: settle on the authoritative rest positions.
      const s = poolState();
      if (s) renderBalls = s.balls.map((b) => ({ ...b }));
      anim = null;
      return;
    }
    const a = frames[anim.idx];
    const b = frames[anim.idx + 1];
    const tt = Math.max(0, Math.min(1, anim.t));
    // Interpolate by id (frames carry {id,x,y,pocketed}).
    const byIdB = new Map(b.map((p) => [p.id, p]));
    renderBalls = a.map((pa) => {
      const pb = byIdB.get(pa.id) ?? pa;
      const tpl = (poolState()?.balls.find((x) => x.id === pa.id));
      return {
        id: pa.id,
        kind: tpl?.kind ?? (pa.id === 0 ? "cue" : pa.id === 8 ? "eight" : pa.id < 8 ? "solid" : "stripe"),
        x: pa.x + (pb.x - pa.x) * tt,
        y: pa.y + (pb.y - pa.y) * tt,
        vx: 0,
        vy: 0,
        pocketed: pa.pocketed && pb.pocketed,
      };
    });
  }

  function paint() {
    if (!ctx) return;
    ctx.clearRect(0, 0, POOL_CANVAS_W, POOL_CANVAS_H);

    // Rail / cushion frame.
    ctx.fillStyle = "#3a2417";
    roundRect(ctx, 4, 4, POOL_CANVAS_W - 8, POOL_CANVAS_H - 8, 14);
    ctx.fill();

    // Felt.
    const feltX = POOL_PAD;
    const feltY = POOL_PAD;
    const feltW = POOL_TABLE_W * POOL_SCALE;
    const feltH = POOL_TABLE_H * POOL_SCALE;
    ctx.fillStyle = "#11623a";
    roundRect(ctx, feltX, feltY, feltW, feltH, 6);
    ctx.fill();
    // Subtle felt shading.
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 2;
    roundRect(ctx, feltX, feltY, feltW, feltH, 6);
    ctx.stroke();

    // Pockets.
    for (const p of POOL_POCKETS) {
      const { px, py } = tuToPx(p.x, p.y);
      ctx.beginPath();
      ctx.fillStyle = "#05080a";
      ctx.arc(px, py, POOL_POCKET_R * POOL_SCALE, 0, Math.PI * 2);
      ctx.fill();
    }

    // Aim guide on the local player's turn.
    const cue = cueBall();
    const s = poolState();
    if (cue && canShoot() && !s?.ballInHand) {
      const ang = dragging ? aimAngle : hoverAngle;
      if (ang != null) drawAimGuide(cue, ang, dragging ? aimPower : 0);
    }

    // Ball-in-hand ghost at the re-spot.
    if (s?.ballInHand && isMyTurn() && respot) {
      const { px, py } = tuToPx(respot.x, respot.y);
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = 1.5;
      ctx.arc(px, py, POOL_BALL_R * POOL_SCALE, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Balls.
    for (const b of renderBalls) {
      if (b.pocketed) continue;
      if (b.id === 0 && s?.ballInHand && isMyTurn() && respot) continue; // shown as ghost
      drawBall(b);
    }
  }

  function drawAimGuide(cue: PoolBall, ang: number, power: number) {
    if (!ctx) return;
    const { px, py } = tuToPx(cue.x, cue.y);
    const len = (POOL_TABLE_W * POOL_SCALE) * (0.25 + 0.55 * power);
    ctx.beginPath();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 2;
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(ang) * len, py + Math.sin(ang) * len);
    ctx.stroke();
    ctx.setLineDash([]);
    // Cue-stick stub behind the ball (opposite the shot direction), scaled by pull.
    if (power > 0) {
      const back = (POOL_BALL_R * 2 + power * POOL_TABLE_W * 0.45) * POOL_SCALE;
      ctx.beginPath();
      ctx.strokeStyle = "#d9b27a";
      ctx.lineWidth = 5;
      ctx.lineCap = "round";
      ctx.moveTo(px - Math.cos(ang) * (POOL_BALL_R * POOL_SCALE + 4), py - Math.sin(ang) * (POOL_BALL_R * POOL_SCALE + 4));
      ctx.lineTo(px - Math.cos(ang) * back, py - Math.sin(ang) * back);
      ctx.stroke();
    }
  }

  function drawBall(b: PoolBall) {
    if (!ctx) return;
    const { px, py } = tuToPx(b.x, b.y);
    const r = POOL_BALL_R * POOL_SCALE;
    ctx.save();
    // Shadow.
    ctx.beginPath();
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.arc(px + 1.5, py + 2, r, 0, Math.PI * 2);
    ctx.fill();

    if (b.kind === "cue") {
      ctx.fillStyle = "#f4f1e8";
    } else {
      ctx.fillStyle = POOL_BALL_COLORS[b.id] ?? "#cccccc";
    }
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();

    // Stripe band.
    if (b.kind === "stripe") {
      ctx.save();
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = "#f4f1e8";
      ctx.fillRect(px - r, py - r * 0.45, r * 2, r * 0.9);
      ctx.fillStyle = POOL_BALL_COLORS[b.id] ?? "#cccccc";
      ctx.fillRect(px - r, py - r * 0.45, r * 2, 0); // no-op keep base
      ctx.restore();
    }

    // Number circle for non-cue balls.
    if (b.kind !== "cue") {
      ctx.beginPath();
      ctx.fillStyle = "#f4f1e8";
      ctx.arc(px, py, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#15181d";
      ctx.font = `bold ${Math.round(r * 0.62)}px var(--font, sans-serif)`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(b.id), px, py + 0.5);
    }
    // Highlight.
    ctx.beginPath();
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.arc(px - r * 0.32, py - r * 0.32, r * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // --- Banner / scoreboard / chooser DOM ---------------------------------
  function groupOf(id: string): "solid" | "stripe" | null {
    const s = poolState();
    return (s?.assignedGroups[id] as "solid" | "stripe" | undefined) ?? null;
  }

  function renderScoreboard() {
    if (!game) return;
    const p1 = game.player1;
    const p2 = game.player2;
    const me = selfId();
    const g1 = p1 ? groupOf(p1.sessionId) : null;
    const g2 = p2 ? groupOf(p2.sessionId) : null;
    scoreboard.innerHTML = "";
    const badge = (p: typeof p1, isSelf: boolean, grp: "solid" | "stripe" | null) => {
      const div = document.createElement("div");
      div.className = `game-player-badge ${isSelf ? "self" : ""}`;
      const name = document.createElement("span");
      name.className = "pool-pname";
      name.textContent = p ? (p.sessionId === POOL_AI_SESSION_ID ? "🤖 " + p.name : p.name) : "Waiting…";
      div.appendChild(name);
      if (grp) {
        const chip = document.createElement("span");
        chip.className = `pool-group-chip ${grp}`;
        chip.textContent = grp === "solid" ? "● Solids" : "◍ Stripes";
        div.appendChild(chip);
      }
      return div;
    };
    const vs = document.createElement("span");
    vs.className = "game-vs";
    vs.textContent = "VS";
    scoreboard.append(
      badge(p1, p1?.sessionId === me, g1),
      vs,
      badge(p2, p2?.sessionId === me, g2)
    );
  }

  function renderBanner() {
    if (!game) return;
    const s = poolState();
    banner.classList.toggle("active", isMyTurn());
    if (game.status === "waiting") {
      banner.textContent = "";
      return;
    }
    if (game.status === "gameover") {
      banner.textContent = "";
      return;
    }
    if (!s) {
      banner.textContent = "";
      return;
    }
    const grp = groupOf(selfId());
    let youAre = "";
    if (isSeated()) {
      youAre = grp ? `You are ${grp === "solid" ? "Solids ●" : "Stripes ◍"}. ` : "Table is open. ";
    } else {
      youAre = "Spectating. ";
    }

    let turnTxt: string;
    if (s.currentTurn === POOL_AI_SESSION_ID) {
      turnTxt = "🤖 Pool Bot is thinking…";
    } else if (isMyTurn()) {
      turnTxt = s.ballInHand
        ? "Ball in hand — drag the cue to reposition, then drag to aim & shoot."
        : "Your shot — drag back from the cue ball to aim & set power, release to shoot.";
    } else if (s.animating || anim) {
      turnTxt = "Balls rolling…";
    } else {
      const other =
        game.player1?.sessionId === s.currentTurn
          ? game.player1?.name
          : game.player2?.name;
      turnTxt = `${other ?? "Opponent"}'s shot…`;
    }
    banner.textContent = youAre + turnTxt;
  }

  function renderTray() {
    const s = poolState();
    tray.innerHTML = "";
    if (!s) return;
    const potted = s.balls.filter((b) => b.pocketed && b.id !== 0);
    if (potted.length === 0) {
      tray.style.display = "none";
      return;
    }
    tray.style.display = "flex";
    const label = document.createElement("span");
    label.className = "pool-tray-label";
    label.textContent = "Potted:";
    tray.appendChild(label);
    for (const b of potted.sort((a, c) => a.id - c.id)) {
      const dot = document.createElement("span");
      dot.className = `pool-tray-ball ${b.kind}`;
      dot.style.setProperty("--bc", POOL_BALL_COLORS[b.id] ?? "#ccc");
      dot.textContent = String(b.id);
      tray.appendChild(dot);
    }
  }

  function renderChooser() {
    chooser.innerHTML = "";
    if (!game) return;
    // Show the entry chooser only to seat-1 host while waiting for an opponent
    // (i.e. they joined the idle table in the default GROUP mode). This lets
    // them pick: keep waiting for a friend, or switch to solo-vs-Bot.
    const me = selfId();
    const isHost = game.player1?.sessionId === me && !game.player2;
    const waitingGroup = game.status === "waiting" && isHost && !game.vsAi;
    if (!waitingGroup) {
      chooser.style.display = "none";
      return;
    }
    chooser.style.display = "flex";

    const intro = document.createElement("p");
    intro.className = "pool-chooser-intro";
    intro.textContent = "How do you want to play?";
    chooser.appendChild(intro);

    const row = document.createElement("div");
    row.className = "pool-chooser-row";

    const aiBtn = document.createElement("button");
    aiBtn.className = "pool-choose-btn primary";
    aiBtn.innerHTML = "🤖<span>Play vs Bot</span>";
    aiBtn.addEventListener("click", () => {
      if (!game || !callbacks.onJoinGame) return;
      const id = game.id;
      // Leave the group seat, then immediately rejoin as solo-vs-AI. The server
      // collapses the lone waiting seat to idle on leave, then seats us + the AI.
      callbacks.onLeaveGame(id);
      callbacks.onJoinGame(id, "ai");
    });

    const friendBtn = document.createElement("button");
    friendBtn.className = "pool-choose-btn";
    friendBtn.innerHTML = "👥<span>Play with a friend</span>";
    friendBtn.title = "Wait for a second player to walk up and join";
    friendBtn.disabled = true; // already in this (default) mode; just keep waiting

    row.append(aiBtn, friendBtn);
    chooser.appendChild(row);

    const wait = document.createElement("div");
    wait.className = "pool-chooser-wait";
    wait.innerHTML = `<span class="lobby-spinner small"></span> Waiting for a friend to join…`;
    chooser.appendChild(wait);
  }

  function renderOver() {
    if (!game || game.status !== "gameover" || rematchPending) {
      overBanner.style.display = "none";
      return;
    }
    overBanner.style.display = "flex";
    overBanner.innerHTML = "";
    const me = selfId();
    const h = document.createElement("h3");
    if (game.winnerSessionId === me) {
      h.textContent = "VICTORY!";
      h.style.color = "#3ecf6e";
      h.className = "banner-victory";
    } else if (game.winnerSessionId == null) {
      h.textContent = "GAME OVER";
      h.style.color = "#e6ecf2";
    } else {
      h.textContent = "DEFEAT";
      h.style.color = "#ef6258";
    }
    const reason = document.createElement("div");
    reason.className = "game-over-stats";
    const s = poolState();
    const r = s?.lastEvent?.reason;
    reason.textContent =
      r === "illegal-8-loss"
        ? "The 8-ball was sunk illegally."
        : r === "win"
        ? "8-ball sunk cleanly."
        : game.winnerSessionId && game.winnerSessionId !== me && !isSeated()
        ? ""
        : "";

    const actions = document.createElement("div");
    actions.className = "pool-over-actions";

    // Rematch / Play again — only seated players can re-rack (per the rematch
    // contract). The server resets the rack with the SAME seats and broadcasts a
    // fresh GAME_UPDATE (status "playing"), which `update` renders as a live table.
    if (isSeated()) {
      const again = document.createElement("button");
      again.className = "game-over-btn primary";
      again.textContent = "Play again";
      again.addEventListener("click", () => {
        if (!game) return;
        // Optimistically clear the local terminal view so we never get stuck on
        // the game-over screen; the authoritative fresh state arrives next tick.
        rematchPending = true;
        overBanner.style.display = "none";
        callbacks.onGameInput(game.id, { rematch: true });
      });
      actions.appendChild(again);
    }

    const btn = document.createElement("button");
    btn.className = "game-over-btn";
    btn.textContent = "Return to Office";
    btn.addEventListener("click", leave);
    actions.appendChild(btn);

    overBanner.append(h, reason, actions);
  }

  function syncPowerMeter() {
    const show = canShoot() && (dragging || aimPower > 0);
    powerWrap.style.visibility = show ? "visible" : "hidden";
    powerLabel.style.visibility = show ? "visible" : "hidden";
    const pct = Math.round(Math.max(0, Math.min(1, aimPower)) * 100);
    // Vertical meter on desktop (fills bottom-up); the mobile media query rotates
    // the bar and animates width instead, so drive both dimensions.
    if (window.matchMedia("(max-width: 760px)").matches) {
      powerFill.style.width = `${pct}%`;
      powerFill.style.height = "100%";
    } else {
      powerFill.style.height = `${pct}%`;
      powerFill.style.width = "100%";
    }
    powerLabel.textContent = `Power ${pct}%`;
  }

  // The DOM (banner/chooser/tray) is re-derived each render; the canvas paints
  // continuously via rAF. Keep the heavy DOM updates here, not in the paint loop.
  function syncDom() {
    if (!game) return;
    const playing = game.status === "playing";
    playArea.style.display = playing ? "flex" : "none";
    banner.style.display = game.status === "waiting" || game.status === "gameover" ? "none" : "block";
    renderScoreboard();
    renderBanner();
    renderChooser();
    renderTray();
    renderOver();
    syncPowerMeter();
  }

  function update(next: ActiveGame) {
    game = next;
    const s = poolState();
    // Once the server delivers a non-terminal state, the rematch has landed —
    // drop the pending guard so future game-overs render normally.
    if (next.status !== "gameover") rematchPending = false;
    // Detect a new shot trajectory (server sends it once per resolved shot).
    if (s?.trajectory && s.trajectory !== lastTrajectoryRef && s.trajectory.length > 1) {
      lastTrajectoryRef = s.trajectory;
      anim = { frames: s.trajectory, idx: 0, t: 0 };
      // Cancel any in-progress aim.
      dragging = false;
      aimPower = 0;
      respot = null;
      hoverAngle = null;
    } else if (!anim) {
      // No animation running: paint the authoritative rest positions.
      if (s) renderBalls = s.balls.map((b) => ({ ...b }));
      else renderBalls = [];
    }
    if (s && !s.trajectory) {
      lastTrajectoryRef = undefined;
    }
    syncDom();
  }

  // Power meter also needs to update during a drag (which is outside `update`),
  // so refresh the lightweight DOM bits on a slow interval too.
  const domTimer = window.setInterval(() => {
    renderBanner();
    syncPowerMeter();
  }, 120);

  rafId = requestAnimationFrame(stepWrap);

  return {
    update,
    destroy() {
      cancelAnimationFrame(rafId);
      window.clearInterval(domTimer);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
    },
  };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
