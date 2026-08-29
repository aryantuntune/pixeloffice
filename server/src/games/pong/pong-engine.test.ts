import { describe, it, expect } from "vitest";
import {
  PONG_COURT_W,
  PONG_COURT_H,
  PONG_BALL_R,
  PONG_PADDLE_H,
  PONG_PADDLE_1_FACE,
  PONG_PADDLE_2_FACE,
} from "@pixeloffice/shared";
import { makePrng } from "../pool/prng";
import {
  freshPongSim,
  stepPong,
  PONG_BALL_SPEED,
  PONG_BALL_SPEED_MAX,
  PONG_RALLY_ACCEL,
  PONG_MAX_BOUNCE_RAD,
  PONG_SERVE_DELAY_MS,
  type PongSim,
} from "./pong-engine";

describe("pong-engine", () => {
  it("serve traverse crosses from center to paddle 2 in under 900 ms", () => {
    const prng = makePrng(1);
    const sim = freshPongSim(prng, 1);
    // Place paddle 2 out of the way so we can measure unobstructed traverse
    sim.paddle2Y = 0;
    sim.paddle1Y = 0;
    let elapsedMs = 0;
    while (sim.ballX <= PONG_PADDLE_2_FACE && elapsedMs < 2000) {
      stepPong(sim, 0, 0, 16, prng);
      elapsedMs += 16;
    }
    expect(sim.ballX).toBeGreaterThan(PONG_PADDLE_2_FACE);
    expect(elapsedMs).toBeLessThan(900);
  });

  it("prevents tunneling at max speed via crossing test", () => {
    const prng = makePrng(1);
    const sim: PongSim = {
      ballX: 40,
      ballY: 200,
      velX: -PONG_BALL_SPEED_MAX,
      velY: 0,
      paddle1Y: 160,
      paddle2Y: 160,
      serveIn: 0,
    };
    // In a 16ms step, ball would travel -14.4px, moving ballX from 40 to 25.6.
    // Inner face is at 30 (ball inner edge goes from 34 to 19.6, crossing 30).
    const res = stepPong(sim, 0, 0, 16, prng);
    expect(res.scored).toBeNull();
    expect(sim.velX).toBeGreaterThan(0);
    expect(sim.ballX).toBeGreaterThanOrEqual(PONG_PADDLE_1_FACE + PONG_BALL_R);
  });

  it("handles paddle-edge deflection and accelerates velocity", () => {
    const prng = makePrng(1);
    const prevSpeed = 420;
    const sim: PongSim = {
      ballX: 38,
      ballY: 160, // hitting top of paddle 1 (paddle1Y = 160, paddleCenter = 200, offset = -1)
      velX: -prevSpeed,
      velY: 0,
      paddle1Y: 160,
      paddle2Y: 160,
      serveIn: 0,
    };
    stepPong(sim, 0, 0, 16, prng);
    const expectedSpeed = Math.min(prevSpeed * PONG_RALLY_ACCEL, PONG_BALL_SPEED_MAX);
    const actualSpeed = Math.hypot(sim.velX, sim.velY);
    expect(actualSpeed).toBeCloseTo(expectedSpeed, 4);
    // Deflection should be upwards (negative velY)
    expect(sim.velY).toBeLessThan(0);
    const expectedVelY = -expectedSpeed * Math.sin(PONG_MAX_BOUNCE_RAD);
    expect(sim.velY).toBeCloseTo(expectedVelY, 2);
  });

  it("clamps speed to PONG_BALL_SPEED_MAX under repeated hits", () => {
    const prng = makePrng(1);
    const sim: PongSim = {
      ballX: 38,
      ballY: 200,
      velX: -890,
      velY: 0,
      paddle1Y: 160,
      paddle2Y: 160,
      serveIn: 0,
    };
    stepPong(sim, 0, 0, 16, prng); // First hit: 890 * 1.05 = 934.5 -> clamped to 900
    expect(Math.hypot(sim.velX, sim.velY)).toBeCloseTo(PONG_BALL_SPEED_MAX, 4);
  });

  it("wall bounce negates velY and preserves speed magnitude", () => {
    const prng = makePrng(1);
    const speed = 400;
    const sim: PongSim = {
      ballX: 300,
      ballY: PONG_COURT_H - 10,
      velX: speed * 0.6,
      velY: speed * 0.8,
      paddle1Y: 160,
      paddle2Y: 160,
      serveIn: 0,
    };
    stepPong(sim, 0, 0, 16, prng);
    expect(sim.velY).toBeLessThan(0);
    expect(Math.hypot(sim.velX, sim.velY)).toBeCloseTo(speed, 4);
  });

  it("miss scores a point, resets ball to center with delay, and aims at conceding player", () => {
    const prng = makePrng(1);
    // Ball passes paddle 1 (miss on left side) -> player 2 scores
    const sim: PongSim = {
      ballX: -1,
      ballY: 50,
      velX: -PONG_BALL_SPEED,
      velY: 0,
      paddle1Y: 300, // paddle far away
      paddle2Y: 160,
      serveIn: 0,
    };
    const res = stepPong(sim, 0, 0, 16, prng);
    expect(res.scored).toBe(2);
    expect(sim.ballX).toBe(PONG_COURT_W / 2);
    expect(sim.ballY).toBe(PONG_COURT_H / 2);
    expect(sim.serveIn).toBe(PONG_SERVE_DELAY_MS);
    // Conceding side is player 1 (left), so next serve aims left (velX < 0)
    expect(sim.velX).toBeLessThan(0);

    // Ball passes paddle 2 (miss on right side) -> player 1 scores
    const sim2: PongSim = {
      ballX: PONG_COURT_W + 1,
      ballY: 50,
      velX: PONG_BALL_SPEED,
      velY: 0,
      paddle1Y: 160,
      paddle2Y: 300, // paddle far away
      serveIn: 0,
    };
    const res2 = stepPong(sim2, 0, 0, 16, prng);
    expect(res2.scored).toBe(1);
    expect(sim2.ballX).toBe(PONG_COURT_W / 2);
    expect(sim2.serveIn).toBe(PONG_SERVE_DELAY_MS);
    // Conceding side is player 2 (right), so next serve aims right (velX > 0)
    expect(sim2.velX).toBeGreaterThan(0);
  });

  it("does not move ball while serveIn > 0, then resumes motion once elapsed", () => {
    const prng = makePrng(1);
    const sim: PongSim = {
      ballX: PONG_COURT_W / 2,
      ballY: PONG_COURT_H / 2,
      velX: PONG_BALL_SPEED,
      velY: 0,
      paddle1Y: 160,
      paddle2Y: 160,
      serveIn: 100,
    };

    // Step 50 ms -> still in serveIn
    stepPong(sim, 0, 0, 50, prng);
    expect(sim.serveIn).toBe(50);
    expect(sim.ballX).toBe(PONG_COURT_W / 2);

    // Step 60 ms -> serveIn elapses (50ms spent waiting, 10ms moving)
    stepPong(sim, 0, 0, 60, prng);
    expect(sim.serveIn).toBe(0);
    expect(sim.ballX).toBeGreaterThan(PONG_COURT_W / 2);
  });

  it("clamps paddle positions within bounds", () => {
    const prng = makePrng(1);
    const sim: PongSim = {
      ballX: PONG_COURT_W / 2,
      ballY: PONG_COURT_H / 2,
      velX: PONG_BALL_SPEED,
      velY: 0,
      paddle1Y: 10,
      paddle2Y: PONG_COURT_H - PONG_PADDLE_H - 10,
      serveIn: 0,
    };

    // Move p1 up (-1) past 0, p2 down (+1) past max
    stepPong(sim, -1, 1, 100, prng);
    expect(sim.paddle1Y).toBe(0);
    expect(sim.paddle2Y).toBe(PONG_COURT_H - PONG_PADDLE_H);
  });
});
