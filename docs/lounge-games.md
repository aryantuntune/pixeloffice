# Lounge Games

PixelOffice has three two-player mini-games in the **Lounge** for casual breaks:
**Ping-Pong**, **Tic-Tac-Toe**, and **Connect Four**. They are opt-in and explicit —
a game never starts on its own, never moves your avatar, and never affects presence,
attendance, or HR (consistent with the constitution: presence, not surveillance; human
agency).

## How to play

1. Walk your avatar into the **Lounge** (top-right of the map) and up to a game station
   (e.g. the **ping-pong table** at tile `(38, 21)`). The HUD shows an interact prompt.
2. Press **E** to join. The first player to join a station **waits** for a second player;
   when someone else joins the same station the game flips to **playing**.
3. A focused **game dialog** opens with the board/play surface. Make your move (click a
   cell / column, or use the paddle controls). Moves are sent to the server, which is
   authoritative and broadcasts the updated game to both players.
4. When the game ends (`gameover`), the winner and score are shown. Close the dialog or
   press **Esc** to leave; leaving mid-game frees your seat for someone else.

There are three fixed stations, one per game, created when the room boots:
`lounge:ping-pong`, `lounge:tic-tac-toe`, `lounge:connect-four`.

## Architecture

Games follow the same boundaries as the rest of PixelOffice: **server-authoritative state,
plain-JSON wire protocol, rendering-only client**. No business logic lives in the Phaser
scene or the HUD.

### Shared types (`shared/src/types.ts`)
```ts
type GameType = "ping-pong" | "tic-tac-toe" | "connect-four";

interface GamePlayer { sessionId: string; name: string; avatarId: string; }

interface PongState        { ballX; ballY; paddle1Y; paddle2Y; }      // numbers
interface TicTacToeState   { board: string[];   turn: string; }       // 9 cells "", "X", "O"
interface ConnectFourState { board: string[][]; turn: string; }       // 6×7 "", "R", "Y"

interface ActiveGame {
  id: string;
  type: GameType;
  player1: GamePlayer | null;
  player2: GamePlayer | null;
  score1: number;
  score2: number;
  winnerSessionId: string | null;
  state: PongState | TicTacToeState | ConnectFourState | null;
  status: "idle" | "waiting" | "playing" | "gameover";
}
```

### Wire protocol (`shared/src/protocol.ts`)
| Direction | Message | Payload | Meaning |
|---|---|---|---|
| C2S | `JOIN_GAME` | `{ gameId }` | Take a seat at a station (press E). |
| C2S | `LEAVE_GAME` | `{ gameId }` | Leave / give up the seat. |
| C2S | `GAME_INPUT` | `{ gameId, input }` | A move/paddle action (validated server-side). |
| S2C | `GAME_UPDATE` | `{ game: ActiveGame }` | Authoritative full game state after any change. |

### Server (`server/src/rooms/office.room.ts`)
- The three `ActiveGame`s are constructed in `onCreate` and held in a `games` map.
- `handleJoinGame` / `handleLeaveGame` / `handleGameInput` mutate the authoritative game
  state (seating, turns, board, scoring, win detection) and `broadcast(S2C.GAME_UPDATE)`.
- On player leave/disconnect, `onLeave` releases the player from any active game.
- Inputs are validated (turn ownership, legal move) before applying — the client is never
  trusted. Per-session rate limiting still applies.

### Client
- `client/src/game/scene.ts` — proximity detection near a station shows the interact
  prompt; pressing **E** emits an interact event the UI bridges to `JOIN_GAME`. The scene
  only renders/prompts; it holds no game rules.
- `client/src/ui/games.ts` — `mountGameOverlay` renders a `<dialog>` for the active game
  from `GAME_UPDATE` and sends `GAME_INPUT` / `LEAVE_GAME`.
- `client/src/main.ts` — wires `JOIN_GAME` / `LEAVE_GAME` / `GAME_INPUT` (C2S) and
  `GAME_UPDATE` (S2C) between the connection, store, and overlay.
- `client/src/ui/state.ts` — `setGame` mirrors the pushed `ActiveGame` and tracks the
  local player's `activeGameId`.

### Map (`shared/src/map.ts`)
The **Lounge** area (`type: "LOUNGE"`) hosts the stations and furniture (sofas, rug, coffee
table, plants, beanbags, bookshelves, and the `ping-pong-table` piece). Game furniture is
`solid` so avatars stand next to it to interact.

## Constitution alignment
- **Explicit & opt-in:** you must walk over and press E; nothing auto-joins.
- **Human agency:** joining a game never teleports your avatar.
- **No surveillance:** games are pure social play — they never touch presence scoring,
  attendance, or HR, and game activity is not logged as user metrics.
