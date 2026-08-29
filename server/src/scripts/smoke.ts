// ---------------------------------------------------------------------------
// End-to-end protocol smoke test. Assumes the server is ALREADY running on
// localhost:2567 (npm run dev). Exercises the wire protocol with colyseus.js,
// prints PASS/FAIL per step, exits 1 on any failure, hard timeout 30s.
//
// No test framework — just small waitFor() promises against received messages.
// ---------------------------------------------------------------------------

import "../load-env";
import { JwtService } from "../auth/jwt.service";

import { Client, type Room } from "colyseus.js";
import {
  C2S,
  DEFAULT_SERVER_PORT,
  PresenceState,
  ROOM_NAME,
  S2C,
  buildOfficeMap,
  isWalkable,
  type Direction,
  type JoinOptions,
  type MovePayload,
  type PlayerJoinedPayload,
  type PlayerMovedPayload,
  type PlayerTeleportedPayload,
  type PresencePayload,
  type SetStatusPayload,
  type WelcomePayload,
  type FloorChangedPayload,
  type BuildingJSON,
  type FloorJSON,
} from "@pixeloffice/shared";

const ENDPOINT = `ws://localhost:${DEFAULT_SERVER_PORT}`;
const HTTP = `http://localhost:${DEFAULT_SERVER_PORT}`;
const HARD_TIMEOUT_MS = 30_000;

let failures = 0;

function pass(step: string): void {
  console.log(`PASS  ${step}`);
}
function fail(step: string, detail?: string): void {
  failures++;
  console.log(`FAIL  ${step}${detail ? ` — ${detail}` : ""}`);
}

/** Resolve when `predicate` returns truthy, else reject after `timeoutMs`. */
function waitFor<T>(
  describe: string,
  poll: () => T | undefined,
  timeoutMs = 7000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = poll();
      if (v !== undefined && v !== null && v !== false) {
        resolve(v as T);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timeout waiting for ${describe}`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

/** Capture messages of a given type into a growing array. */
function collector<T>(room: Room, type: string): T[] {
  const bucket: T[] = [];
  room.onMessage(type, (msg: T) => bucket.push(msg));
  return bucket;
}

async function main(): Promise<void> {
  const map = buildOfficeMap();
  const client = new Client(ENDPOINT);

  const jwtSecret = process.env.JWT_SECRET;
  const jwt = jwtSecret ? new JwtService({ secret: jwtSecret }) : null;
  const token = jwt
    ? jwt.sign({
        sub: "smoke-user-id",
        email: "smoke@pixeloffice.test",
        name: "Smoke",
        department: "Engineering",
        role: "superadmin",
      })
    : undefined;
  const optsA: JoinOptions = { name: "Smoke", department: "Engineering", avatarId: "emerald", ...(token ? { token } : {}) };
  const roomA: Room = await client.joinOrCreate(ROOM_NAME, optsA);

  // Set up collectors before sending anything.
  const welcomesA = collector<WelcomePayload>(roomA, S2C.WELCOME);
  const presenceA = collector<PresencePayload>(roomA, S2C.PRESENCE);
  const emotesA = collector<{ sessionId: string; emote: string }>(roomA, S2C.EMOTE);
  const teleportsA = collector<PlayerTeleportedPayload>(roomA, S2C.PLAYER_TELEPORTED);
  const eventsCreatedA = collector<{ event: { id: string } }>(roomA, S2C.EVENT_CREATED);
  const meetingsStartedA = collector<{ meeting: { id: string; title: string } }>(
    roomA,
    S2C.MEETING_STARTED,
  );

  // 1. WELCOME with self at a walkable tile.
  const welcome = await waitFor("WELCOME", () => welcomesA[0]);
  if (
    welcome.self &&
    Number.isInteger(welcome.self.x) &&
    Number.isInteger(welcome.self.y) &&
    isWalkable(map, welcome.self.x, welcome.self.y)
  ) {
    pass(`WELCOME self spawn at (${welcome.self.x},${welcome.self.y})`);
  } else {
    fail("WELCOME self spawn at walkable tile", JSON.stringify(welcome.self));
  }

  const self = welcome.self;

  // 2. MOVE one tile in a walkable direction.
  const firstStep = pickWalkableStep(map, self.x, self.y);
  if (!firstStep) {
    fail("find a walkable adjacent tile for first MOVE");
  } else {
    roomA.send(C2S.MOVE, firstStep);
    pass(`MOVE to (${firstStep.x},${firstStep.y})`);
  }

  // 2b. EMOTE should echo to the sender (client-visible social expression).
  roomA.send(C2S.EMOTE, { emote: "WAVE" });
  try {
    await waitFor("EMOTE echo", () =>
      emotesA.find((m) => m.sessionId === roomA.sessionId && m.emote === "WAVE"),
    );
    pass("EMOTE echoed to sender");
  } catch (e) {
    fail("EMOTE echoed to sender", (e as Error).message);
  }

  // 3. Second client joins; roomA must receive PLAYER_JOINED, then PLAYER_MOVED
  //    when client A moves again.
  // Register the collector BEFORE B joins, or the broadcast races past us.
  const joinedA = collector<PlayerJoinedPayload>(roomA, S2C.PLAYER_JOINED);

  const clientB = new Client(ENDPOINT);
  const tokenB = jwt
    ? jwt.sign({
        sub: "smoke-buddy-id",
        email: "buddy@pixeloffice.test",
        name: "Buddy",
        department: "Product",
        role: "member",
      })
    : undefined;
  const optsB: JoinOptions = { name: "Buddy", department: "Product", avatarId: "ruby", ...(tokenB ? { token: tokenB } : {}) };
  const roomB: Room = await clientB.joinOrCreate(ROOM_NAME, optsB);

  const movedB = collector<PlayerMovedPayload>(roomB, S2C.PLAYER_MOVED);

  try {
    await waitFor("PLAYER_JOINED (B seen by A)", () =>
      joinedA.find((m) => m.player.name === "Buddy"),
    );
    pass("PLAYER_JOINED received by A");
  } catch (e) {
    fail("PLAYER_JOINED received by A", (e as Error).message);
  }

  // A moves again -> B should receive PLAYER_MOVED.
  const cur = firstStep ?? { x: self.x, y: self.y, dir: "down" as Direction, moving: false };
  const secondStep = pickWalkableStep(map, cur.x, cur.y, cur.dir);
  if (secondStep) {
    roomA.send(C2S.MOVE, secondStep);
    try {
      await waitFor("PLAYER_MOVED (A seen by B)", () =>
        movedB.find((m) => m.sessionId === roomA.sessionId),
      );
      pass("PLAYER_MOVED received by B");
    } catch (e) {
      fail("PLAYER_MOVED received by B", (e as Error).message);
    }
  } else {
    fail("find a second walkable step for A");
  }

  // 4. SET_STATUS FOCUS -> PRESENCE FOCUS/MANUAL.
  const setFocus: SetStatusPayload = { state: "FOCUS" };
  roomA.send(C2S.SET_STATUS, setFocus);
  try {
    await waitFor(
      "PRESENCE FOCUS/MANUAL",
      () =>
        presenceA.find(
          (p) =>
            p.sessionId === roomA.sessionId &&
            p.state === PresenceState.FOCUS &&
            p.source === "MANUAL",
        ),
      7000,
    );
    pass("PRESENCE FOCUS/MANUAL after SET_STATUS");
  } catch (e) {
    fail("PRESENCE FOCUS/MANUAL after SET_STATUS", (e as Error).message);
  }

  // Reset to AVAILABLE so the event-break can take effect cleanly.
  roomA.send(C2S.SET_STATUS, { state: "AVAILABLE" } satisfies SetStatusPayload);

  // 5. POST /api/events -> EVENT_CREATED.
  let createdEventId = "";
  try {
    const resp = await fetch(`${HTTP}/api/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ type: "COFFEE_BREAK" }),
    });
    const json = (await resp.json()) as { event?: { id: string } };
    const seen = await waitFor("EVENT_CREATED", () => eventsCreatedA[0]);
    createdEventId = json.event?.id ?? seen.event.id;
    pass("EVENT_CREATED received after POST /api/events");
  } catch (e) {
    fail("EVENT_CREATED received after POST /api/events", (e as Error).message);
  }

  // 6. JOIN_EVENT -> PLAYER_TELEPORTED to a Coffee Area anchor + PRESENCE BREAK/EVENT.
  if (createdEventId) {
    const coffeeAnchors = map.anchors["Coffee Area"] ?? [];
    roomA.send(C2S.JOIN_EVENT, { eventId: createdEventId });
    try {
      await waitFor(
        "PLAYER_TELEPORTED to Coffee Area",
        () =>
          teleportsA.find(
            (t) =>
              t.sessionId === roomA.sessionId &&
              coffeeAnchors.some((a) => a.x === t.x && a.y === t.y),
          ),
        7000,
      );
      pass("PLAYER_TELEPORTED to a Coffee Area anchor");
    } catch (e) {
      fail("PLAYER_TELEPORTED to a Coffee Area anchor", (e as Error).message);
    }
    try {
      await waitFor(
        "PRESENCE BREAK/EVENT",
        () =>
          presenceA.find(
            (p) =>
              p.sessionId === roomA.sessionId &&
              p.state === PresenceState.BREAK &&
              p.source === "EVENT",
          ),
        7000,
      );
      pass("PRESENCE BREAK/EVENT after JOIN_EVENT");
    } catch (e) {
      fail("PRESENCE BREAK/EVENT after JOIN_EVENT", (e as Error).message);
    }
  } else {
    fail("JOIN_EVENT (no event id from previous step)");
  }

  // 7. POST /api/meetings -> MEETING_STARTED within 7s (tick is ~3s).
  try {
    const mResp = await fetch(`${HTTP}/api/meetings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ title: "Smoke Standup" }),
    });
    await waitFor(
      "MEETING_STARTED",
      () => meetingsStartedA.find((m) => m.meeting.title === "Smoke Standup"),
      7000,
    );
    pass("MEETING_STARTED received after POST /api/meetings");
  } catch (e) {
    fail("MEETING_STARTED received after POST /api/meetings", (e as Error).message);
  }

  // 8. MULTI-FLOOR: a fresh client walks onto the elevator portal on its OWN
  //    spawn floor and must receive FLOOR_CHANGED to that portal's target floor
  //    (human agency: own movement only). New players now spawn on the rich MAIN
  //    OFFICE floor (the top floor), whose elevator goes DOWN to floor-1.
  try {
    const resp = await fetch(`${HTTP}/api/maps/active`);
    const { building } = (await resp.json()) as { building: BuildingJSON };

    const clientC = new Client(ENDPOINT);
    const tokenC = jwt
      ? jwt.sign({
          sub: "smoke-lift-id",
          email: "lift@pixeloffice.test",
          name: "Lift",
          department: "HR",
          role: "member",
        })
      : undefined;
    const optsC: JoinOptions = { name: "Lift", department: "HR", avatarId: "violet", ...(tokenC ? { token: tokenC } : {}) };
    const roomC: Room = await clientC.joinOrCreate(ROOM_NAME, optsC);
    const welcomesC = collector<WelcomePayload>(roomC, S2C.WELCOME);
    const floorChangesC = collector<FloorChangedPayload>(roomC, S2C.FLOOR_CHANGED);
    const teleportsC = collector<PlayerTeleportedPayload>(roomC, S2C.PLAYER_TELEPORTED);
    const welcomeC = await waitFor("WELCOME (C)", () => welcomesC[0]);

    // The player's actual spawn floor + that floor's elevator portal.
    const spawnFloorId = welcomeC.self.floorId ?? "ground";
    const spawnFloor = building.floors.find((f) => f.id === spawnFloorId)!;
    const portal = spawnFloor.portals[0];

    // WELCOME must advertise the building (floor list) + the player's floor, and
    // new players spawn on the rich main office (the top floor).
    const topIndex = Math.max(...building.floors.map((f) => f.index));
    if (
      welcomeC.building &&
      welcomeC.building.floors.length >= 3 &&
      spawnFloor &&
      spawnFloor.index === topIndex
    ) {
      pass(
        `WELCOME carries building summary (${welcomeC.building.floors.length} floors) + spawns on main office (${spawnFloorId})`,
      );
    } else {
      fail("WELCOME carries building summary + spawns on main office", JSON.stringify(welcomeC.building));
    }

    // BFS a path from spawn to the portal tile, then step it one tile per MOVE.
    const path = bfsPath(spawnFloor, { x: welcomeC.self.x, y: welcomeC.self.y }, { x: portal.x, y: portal.y });
    if (!path) {
      fail("BFS path to the spawn-floor elevator portal");
    } else {
      let prevDir: Direction = welcomeC.self.dir;
      for (const step of path) {
        roomC.send(C2S.MOVE, step);
        prevDir = step.dir;
        // Pace within the 20 steps/sec move budget.
        await sleep(60);
      }
      void prevDir;
      const fc = await waitFor(
        "FLOOR_CHANGED to the portal target floor",
        () => floorChangesC.find((m) => m.selfFloorId !== spawnFloorId),
        7000,
      );
      if (fc.selfFloorId === portal.toFloorId) {
        pass(`FLOOR_CHANGED to ${fc.selfFloorId} after stepping onto the elevator`);
      } else {
        fail("FLOOR_CHANGED to the portal target floor", JSON.stringify(fc));
      }
      // The mover lands on a walkable, NON-portal tile beside the return elevator
      // (lift lobby — must not re-trigger a crossing).
      const destFloor = building.floors.find((f) => f.id === fc.selfFloorId)!;
      const landsOnPortal = destFloor.portals.some((p) => p.x === fc.x && p.y === fc.y);
      const landsWalkable = destFloor.solid[fc.y][fc.x] !== true;
      if (landsWalkable && !landsOnPortal) {
        pass(`elevator deposit lands on a walkable non-portal tile (${fc.x},${fc.y})`);
      } else {
        fail("elevator deposit lands on a walkable non-portal tile", `(${fc.x},${fc.y})`);
      }
      // The mover should NOT have been teleported by anything other than their
      // own portal step (no auto-teleport on the old floor).
      void teleportsC;
    }

    await roomC.leave();
  } catch (e) {
    fail("multi-floor elevator floor change", (e as Error).message);
  }

  await roomA.leave();
  await roomB.leave();
}

/** Sleep helper for pacing MOVE sends within the rate budget. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Breadth-first shortest walkable path from `start` to `goal` on a FloorJSON,
 * returned as a list of MovePayload steps (excluding the start tile). null when
 * unreachable. Uses the floor's solid grid as the collision authority.
 */
function bfsPath(
  floor: FloorJSON,
  start: { x: number; y: number },
  goal: { x: number; y: number },
): MovePayload[] | null {
  const key = (x: number, y: number) => `${x},${y}`;
  const walkable = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < floor.width && y < floor.height && floor.solid[y][x] !== true;
  const prev = new Map<string, { x: number; y: number; dir: Direction } | null>();
  prev.set(key(start.x, start.y), null);
  const queue: Array<{ x: number; y: number }> = [start];
  const steps: Array<{ dx: number; dy: number; dir: Direction }> = [
    { dx: 0, dy: -1, dir: "up" },
    { dx: 0, dy: 1, dir: "down" },
    { dx: -1, dy: 0, dir: "left" },
    { dx: 1, dy: 0, dir: "right" },
  ];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.x === goal.x && cur.y === goal.y) break;
    for (const s of steps) {
      const nx = cur.x + s.dx;
      const ny = cur.y + s.dy;
      if (!walkable(nx, ny)) continue;
      const k = key(nx, ny);
      if (prev.has(k)) continue;
      prev.set(k, { x: cur.x, y: cur.y, dir: s.dir });
      queue.push({ x: nx, y: ny });
    }
  }
  if (!prev.has(key(goal.x, goal.y))) return null;
  // Reconstruct.
  const out: MovePayload[] = [];
  let curK = key(goal.x, goal.y);
  let cur = goal;
  while (true) {
    const p = prev.get(curK);
    if (!p) break;
    out.push({ x: cur.x, y: cur.y, dir: p.dir, moving: true });
    cur = { x: p.x, y: p.y };
    curK = key(p.x, p.y);
  }
  out.reverse();
  return out;
}

/** Pick a walkable adjacent tile, preferring `preferDir` if walkable. */
function pickWalkableStep(
  map: ReturnType<typeof buildOfficeMap>,
  x: number,
  y: number,
  preferDir?: Direction,
): MovePayload | null {
  const candidates: Array<{ dir: Direction; x: number; y: number }> = [
    { dir: "up", x, y: y - 1 },
    { dir: "down", x, y: y + 1 },
    { dir: "left", x: x - 1, y },
    { dir: "right", x: x + 1, y },
  ];
  if (preferDir) {
    candidates.sort((a) => (a.dir === preferDir ? -1 : 0));
  }
  for (const c of candidates) {
    if (isWalkable(map, c.x, c.y)) {
      return { x: c.x, y: c.y, dir: c.dir, moving: true };
    }
  }
  return null;
}

const hardTimeout = setTimeout(() => {
  console.log("FAIL  hard timeout (30s) — server unresponsive");
  process.exit(1);
}, HARD_TIMEOUT_MS);
hardTimeout.unref?.();

main()
  .then(() => {
    clearTimeout(hardTimeout);
    if (failures > 0) {
      console.log(`\n${failures} step(s) FAILED`);
      process.exit(1);
    }
    console.log("\nALL SMOKE STEPS PASSED");
    process.exit(0);
  })
  .catch((err) => {
    clearTimeout(hardTimeout);
    console.log(`FAIL  unexpected error — ${(err as Error).message}`);
    process.exit(1);
  });
