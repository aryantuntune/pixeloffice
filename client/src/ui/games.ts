import type { ActiveGame, PongState, TicTacToeState, ConnectFourState } from "@pixeloffice/shared";
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

  function closeAndLeave() {
    if (activeGameId) {
      callbacks.onLeaveGame(activeGameId);
    }
  }

  function setupPongInput(gameId: string, role: "player1" | "player2") {
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

  return {
    render(game: ActiveGame) {
      activeGameId = game.id;
      const selfId = store.get().selfId;
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
      dialog.close();
      dialog.remove();
    },
  };
}
