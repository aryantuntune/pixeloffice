import { describe, expect, it, vi } from "vitest";
import { S2C } from "@pixeloffice/shared";
import { gracefulShutdown, type ShutdownDeps } from "./shutdown";

const silentLogger = { log: () => {}, error: () => {} };

/** Build deps with stubs; overrides win. Timer is a no-op (never fires). */
function makeDeps(over: Partial<ShutdownDeps> = {}): {
  deps: ShutdownDeps;
  exit: ReturnType<typeof vi.fn>;
  graceful: ReturnType<typeof vi.fn>;
  httpClose: ReturnType<typeof vi.fn>;
} {
  const exit = vi.fn();
  const graceful = vi.fn().mockResolvedValue(undefined);
  const httpClose = vi.fn((cb?: (err?: Error) => void) => cb?.());
  const deps: ShutdownDeps = {
    gameServer: { gracefullyShutdown: graceful },
    httpServer: { close: httpClose },
    exit,
    logger: silentLogger,
    // No-op timer so the deadline never fires during the happy path.
    setTimer: () => ({ unref: () => {} }),
    ...over,
  };
  return { deps, exit, graceful, httpClose };
}

describe("gracefulShutdown", () => {
  it("broadcasts a restart TOAST, drains colyseus, closes http, exits 0", async () => {
    const broadcast = vi.fn();
    const { deps, exit, graceful, httpClose } = makeDeps({
      getRoom: () => ({ broadcast }),
    });

    await gracefulShutdown(deps);

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0]).toBe(S2C.TOAST);
    expect(broadcast.mock.calls[0][1]).toMatchObject({ kind: "broadcast" });
    // gracefullyShutdown called with exit=false (we own process exit).
    expect(graceful).toHaveBeenCalledWith(false);
    expect(httpClose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("closes optional closables (db/redis pools)", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const end = vi.fn().mockResolvedValue(undefined);
    const { deps, exit } = makeDeps({ closables: [{ close }, { end }] });

    await gracefulShutdown(deps);

    expect(close).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("still exits 0 if there is no live room to broadcast to", async () => {
    const { deps, exit } = makeDeps({ getRoom: () => null });
    await gracefulShutdown(deps);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("continues shutting down even if colyseus shutdown rejects", async () => {
    const graceful = vi.fn().mockRejectedValue(new Error("boom"));
    const httpClose = vi.fn((cb?: (err?: Error) => void) => cb?.());
    const { deps, exit } = makeDeps({
      gameServer: { gracefullyShutdown: graceful },
      httpServer: { close: httpClose },
    });

    await gracefulShutdown(deps);

    expect(httpClose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("arms a failsafe timer that force-exits on the deadline", async () => {
    let fired: (() => void) | null = null;
    const exit = vi.fn();
    const { deps } = makeDeps({
      exit,
      setTimer: (fn) => {
        fired = fn;
        return { unref: () => {} };
      },
    });

    await gracefulShutdown(deps);
    expect(fired).toBeTypeOf("function");
    // Simulate the deadline firing (as if the clean path had hung).
    fired!();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
