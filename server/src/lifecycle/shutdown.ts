// ---------------------------------------------------------------------------
// Graceful shutdown helper (Reliability: recover from service restarts).
//
// On SIGINT/SIGTERM we want to be a good citizen so connected avatars degrade
// cleanly instead of vanishing:
//   1. stop accepting new joins (lock + later dispose the room)
//   2. broadcast a friendly TOAST so clients show "Office restarting…" and can
//      begin their own reconnect backoff
//   3. gracefully shut down Colyseus (drains connections, runs onDispose)
//   4. close the shared HTTP server (stops the REST API + ws transport)
//   5. end any optional db/redis pools that were wired in (best-effort)
//   6. hard-exit after a deadline so a stuck handle never wedges the container
//
// This module is framework-light: it only touches Colyseus through the small
// interface below, so it stays testable without booting a real server. The
// integrator calls installShutdown(deps) once in index.ts after listen().
// ---------------------------------------------------------------------------

import { S2C, type ToastPayload } from "@pixeloffice/shared";

/** Minimal slice of the Colyseus Server we depend on (keeps this testable). */
export interface GameServerLike {
  gracefullyShutdown(exit?: boolean): Promise<void>;
}

/** Minimal slice of node's http.Server. */
export interface HttpServerLike {
  close(callback?: (err?: Error) => void): unknown;
}

/** Anything with an async close()/end() — db pools, redis clients, etc. */
export interface ClosableLike {
  close?: () => unknown | Promise<unknown>;
  end?: () => unknown | Promise<unknown>;
}

/** Broadcasts a message to every connected client (the live room exposes this). */
export interface BroadcasterLike {
  broadcast(type: string, message: unknown): void;
}

export interface ShutdownDeps {
  gameServer: GameServerLike;
  httpServer: HttpServerLike;
  /** Lets us reach the live room to broadcast the restart toast (optional). */
  getRoom?: () => BroadcasterLike | null | undefined;
  /** Optional persistence handles to close on the way down (best-effort). */
  closables?: ClosableLike[];
  /** Milliseconds before we stop waiting and force-exit. Default 8000. */
  deadlineMs?: number;
  /** Message shown to clients as they are disconnected. */
  restartMessage?: string;
  /** Injectable for tests; defaults to process.exit. */
  exit?: (code: number) => void;
  /** Injectable for tests; defaults to a real timer. */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  /** Injectable for tests; defaults to console. */
  logger?: Pick<Console, "log" | "error">;
}

const DEFAULT_DEADLINE_MS = 8000;
const DEFAULT_RESTART_MESSAGE = "Office restarting… reconnecting shortly.";

/**
 * Run the graceful shutdown sequence exactly once. Exported (separately from
 * the signal wiring) so tests can drive it directly without sending signals.
 * Resolves once the clean path finishes; the hard-exit timer fires independently
 * if anything hangs.
 */
export async function gracefulShutdown(deps: ShutdownDeps): Promise<void> {
  const log = deps.logger ?? console;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const setTimer =
    deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const restartMessage = deps.restartMessage ?? DEFAULT_RESTART_MESSAGE;

  // Failsafe: never let a stuck pool/socket wedge the process forever.
  const timer = setTimer(() => {
    log.error("[shutdown] deadline reached — forcing exit");
    exit(1);
  }, deadlineMs);
  // Don't let the failsafe timer itself keep the event loop alive.
  if (typeof timer.unref === "function") timer.unref();

  try {
    // 2. Tell everyone we're going down so clients can show a banner + backoff.
    const room = deps.getRoom?.();
    if (room) {
      try {
        const toast: ToastPayload = { message: restartMessage, kind: "broadcast" };
        room.broadcast(S2C.TOAST, toast);
      } catch (err) {
        log.error("[shutdown] failed to broadcast restart toast", err);
      }
    }

    // 3. Drain + dispose Colyseus rooms (also closes its transport). We pass
    //    exit=false so WE control process termination after closing the rest.
    try {
      await deps.gameServer.gracefullyShutdown(false);
    } catch (err) {
      log.error("[shutdown] colyseus gracefullyShutdown error", err);
    }

    // 4. Close the shared HTTP server (REST + ws transport live here).
    await closeHttp(deps.httpServer, log);

    // 5. End optional persistence pools (postgres/redis) if the integrator
    //    wired any. Best-effort and order-independent.
    for (const c of deps.closables ?? []) {
      await closeClosable(c, log);
    }

    log.log("[shutdown] clean shutdown complete");
    exit(0);
  } catch (err) {
    log.error("[shutdown] unexpected error during shutdown", err);
    exit(1);
  }
}

/**
 * Install SIGINT/SIGTERM handlers that run {@link gracefulShutdown} once.
 * Repeated signals are ignored while a shutdown is already in flight (a second
 * Ctrl-C still works because the failsafe timer is running).
 */
export function installShutdown(deps: ShutdownDeps): void {
  const log = deps.logger ?? console;
  let started = false;
  const handler = (signal: NodeJS.Signals): void => {
    if (started) return;
    started = true;
    log.log(`[shutdown] received ${signal} — shutting down gracefully`);
    void gracefulShutdown(deps);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

function closeHttp(server: HttpServerLike, log: Pick<Console, "error">): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      server.close((err?: Error) => {
        if (err) log.error("[shutdown] http close error", err);
        resolve();
      });
    } catch (err) {
      log.error("[shutdown] http close threw", err);
      resolve();
    }
  });
}

async function closeClosable(c: ClosableLike, log: Pick<Console, "error">): Promise<void> {
  try {
    if (typeof c.close === "function") {
      await c.close();
    } else if (typeof c.end === "function") {
      await c.end();
    }
  } catch (err) {
    log.error("[shutdown] error closing resource", err);
  }
}
