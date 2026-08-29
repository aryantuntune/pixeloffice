import {
  PONG_COURT_W,
  PONG_COURT_H,
  PONG_BALL_R,
  PONG_PADDLE_H,
  PONG_PADDLE_1_FACE,
  PONG_PADDLE_2_FACE,
} from "@pixeloffice/shared";
import type { Prng } from "../pool/prng";

/** Serve speed (px/s). ~1.4 s per court traverse vs the old ~4 s. */
export const PONG_BALL_SPEED = 420;
/** Hard cap after rally acceleration (px/s). */
export const PONG_BALL_SPEED_MAX = 900;
/** Speed multiplier applied on every paddle hit, clamped to PONG_BALL_SPEED_MAX. */
export const PONG_RALLY_ACCEL = 1.05;
/** Paddle travel (px/s) — fast enough to defend a 900 px/s ball. */
export const PONG_PADDLE_SPEED = 520;
/** Max deflection off a paddle edge (radians from the x axis). */
export const PONG_MAX_BOUNCE_RAD = Math.PI / 3; // 60°
/** Freeze at center after a point so players can reset. */
export const PONG_SERVE_DELAY_MS = 700;
/** Physics sub-step ceiling (ms) — keeps per-step travel ≲ 7 px, so nothing tunnels. */
export const PONG_MAX_STEP_MS = 8;

export type PongDir = -1 | 0 | 1;

/** Internal simulation state (server-only; projected onto the wire PongState). */
export interface PongSim {
  ballX: number;
  ballY: number;
  /** px/s */
  velX: number;
  velY: number;
  paddle1Y: number;
  paddle2Y: number;
  /** ms remaining before the ball is released. */
  serveIn: number;
}

/** Center the ball, aim it at `serveDir` (+1 = toward paddle 2) with a random ±30° angle. */
export function freshPongSim(rand: Prng, serveDir: 1 | -1): PongSim {
  const angle = (rand() * 2 - 1) * (Math.PI / 6); // ±30°
  return {
    ballX: PONG_COURT_W / 2,
    ballY: PONG_COURT_H / 2,
    velX: serveDir * PONG_BALL_SPEED * Math.cos(angle),
    velY: PONG_BALL_SPEED * Math.sin(angle),
    paddle1Y: (PONG_COURT_H - PONG_PADDLE_H) / 2,
    paddle2Y: (PONG_COURT_H - PONG_PADDLE_H) / 2,
    serveIn: 0,
  };
}

/** Advance the simulation by dtMs (internally sub-stepped). Returns who scored, if anyone. */
export function stepPong(
  sim: PongSim,
  p1Dir: PongDir,
  p2Dir: PongDir,
  dtMs: number,
  rand: Prng,
): { scored: 1 | 2 | null } {
  let remainingDt = dtMs;

  while (remainingDt > 0) {
    const stepMs = Math.min(remainingDt, PONG_MAX_STEP_MS);
    remainingDt -= stepMs;
    const dt = stepMs / 1000;

    // 1. Move paddles
    sim.paddle1Y = Math.max(
      0,
      Math.min(PONG_COURT_H - PONG_PADDLE_H, sim.paddle1Y + p1Dir * PONG_PADDLE_SPEED * dt),
    );
    sim.paddle2Y = Math.max(
      0,
      Math.min(PONG_COURT_H - PONG_PADDLE_H, sim.paddle2Y + p2Dir * PONG_PADDLE_SPEED * dt),
    );

    // 2. Serve delay freeze
    if (sim.serveIn > 0) {
      sim.serveIn = Math.max(0, sim.serveIn - stepMs);
      sim.ballX = PONG_COURT_W / 2;
      sim.ballY = PONG_COURT_H / 2;
      continue;
    }

    // 3. Move ball
    const prevX = sim.ballX;
    const prevY = sim.ballY;
    let nextX = prevX + sim.velX * dt;
    let nextY = prevY + sim.velY * dt;

    // Wall bounce (top/bottom)
    if (nextY < PONG_BALL_R) {
      nextY = PONG_BALL_R;
      sim.velY = Math.abs(sim.velY);
    } else if (nextY > PONG_COURT_H - PONG_BALL_R) {
      nextY = PONG_COURT_H - PONG_BALL_R;
      sim.velY = -Math.abs(sim.velY);
    }
    sim.ballY = nextY;

    // 4. Paddle crossing check
    // Paddle 1 (Left) - Inner face is at PONG_PADDLE_1_FACE, ball moving left (velX < 0)
    if (
      sim.velX < 0 &&
      prevX - PONG_BALL_R >= PONG_PADDLE_1_FACE &&
      nextX - PONG_BALL_R < PONG_PADDLE_1_FACE
    ) {
      const tCross = (prevX - PONG_BALL_R - PONG_PADDLE_1_FACE) / (prevX - nextX);
      const crossY = prevY + (nextY - prevY) * tCross;

      if (
        crossY >= sim.paddle1Y - PONG_BALL_R &&
        crossY <= sim.paddle1Y + PONG_PADDLE_H + PONG_BALL_R
      ) {
        sim.ballX = PONG_PADDLE_1_FACE + PONG_BALL_R;
        const paddleCenter = sim.paddle1Y + PONG_PADDLE_H / 2;
        const offset = Math.max(-1, Math.min(1, (crossY - paddleCenter) / (PONG_PADDLE_H / 2)));
        const angle = offset * PONG_MAX_BOUNCE_RAD;
        const prevSpeed = Math.hypot(sim.velX, sim.velY);
        const speed = Math.min(prevSpeed * PONG_RALLY_ACCEL, PONG_BALL_SPEED_MAX);
        sim.velX = speed * Math.cos(angle);
        sim.velY = speed * Math.sin(angle);
        continue;
      }
    }

    // Paddle 2 (Right) - Inner face is at PONG_PADDLE_2_FACE, ball moving right (velX > 0)
    if (
      sim.velX > 0 &&
      prevX + PONG_BALL_R <= PONG_PADDLE_2_FACE &&
      nextX + PONG_BALL_R > PONG_PADDLE_2_FACE
    ) {
      const tCross = (PONG_PADDLE_2_FACE - (prevX + PONG_BALL_R)) / (nextX - prevX);
      const crossY = prevY + (nextY - prevY) * tCross;

      if (
        crossY >= sim.paddle2Y - PONG_BALL_R &&
        crossY <= sim.paddle2Y + PONG_PADDLE_H + PONG_BALL_R
      ) {
        sim.ballX = PONG_PADDLE_2_FACE - PONG_BALL_R;
        const paddleCenter = sim.paddle2Y + PONG_PADDLE_H / 2;
        const offset = Math.max(-1, Math.min(1, (crossY - paddleCenter) / (PONG_PADDLE_H / 2)));
        const angle = offset * PONG_MAX_BOUNCE_RAD;
        const prevSpeed = Math.hypot(sim.velX, sim.velY);
        const speed = Math.min(prevSpeed * PONG_RALLY_ACCEL, PONG_BALL_SPEED_MAX);
        sim.velX = -speed * Math.cos(angle);
        sim.velY = speed * Math.sin(angle);
        continue;
      }
    }

    sim.ballX = nextX;

    // 5. Point scoring check
    if (sim.ballX < -PONG_BALL_R) {
      // Player 2 scored (ball went out on left side)
      // Next serve aims toward player 1 (left: serveDir = -1) who conceded
      const angle = (rand() * 2 - 1) * (Math.PI / 6);
      sim.ballX = PONG_COURT_W / 2;
      sim.ballY = PONG_COURT_H / 2;
      sim.velX = -PONG_BALL_SPEED * Math.cos(angle);
      sim.velY = PONG_BALL_SPEED * Math.sin(angle);
      sim.serveIn = PONG_SERVE_DELAY_MS;
      return { scored: 2 };
    }

    if (sim.ballX > PONG_COURT_W + PONG_BALL_R) {
      // Player 1 scored (ball went out on right side)
      // Next serve aims toward player 2 (right: serveDir = 1) who conceded
      const angle = (rand() * 2 - 1) * (Math.PI / 6);
      sim.ballX = PONG_COURT_W / 2;
      sim.ballY = PONG_COURT_H / 2;
      sim.velX = PONG_BALL_SPEED * Math.cos(angle);
      sim.velY = PONG_BALL_SPEED * Math.sin(angle);
      sim.serveIn = PONG_SERVE_DELAY_MS;
      return { scored: 1 };
    }
  }

  return { scored: null };
}
