// ---------------------------------------------------------------------------
// Thin colyseus.js wrapper. Knows nothing about presence/meeting rules — it is
// pure transport. All message names flow through the C2S / S2C constants from
// the shared protocol so we never drift from the server's wire contract.
//
// Resilience (plan.md Reliability: recover from service restarts): when the
// connection drops unexpectedly, Connection auto-reconnects with exponential
// backoff + jitter, re-joining the same room with the SAME JoinOptions (and an
// auth token if one was supplied). Registered message handlers are re-attached
// to the fresh room automatically, so callers do not re-register. After a
// successful re-join the server sends a fresh WELCOME — main.ts must handle that
// idempotently (see notes/NOTES-infra.md).
//
// Backward compatible: the original class/methods (connect, sessionId, on,
// send, onLeave, onError) keep their signatures; everything below is additive.
// ---------------------------------------------------------------------------

import { Client, Room } from "colyseus.js";
import {
  DEFAULT_SERVER_PORT,
  ROOM_NAME,
  type JoinOptions,
} from "@pixeloffice/shared";

/** Derive the server WebSocket endpoint from the page location so the same
 *  build works on localhost and over a LAN IP (phones, other machines). */
export function serverHttpBase(): string {
  const host = location.hostname || "localhost";
  return `http://${host}:${DEFAULT_SERVER_PORT}`;
}

function serverWsEndpoint(): string {
  const host = location.hostname || "localhost";
  // Colyseus 0.15 expects the ws(s) endpoint of the server.
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${host}:${DEFAULT_SERVER_PORT}`;
}

type MessageHandler<T> = (payload: T) => void;

/** High-level connection lifecycle states surfaced to the UI (e.g. a banner). */
export type ConnectionState =
  | "connecting" // initial join in flight
  | "online" // joined and healthy
  | "reconnecting" // dropped unexpectedly; backoff retry loop running
  | "offline"; // gave up / closed cleanly (no auto-reconnect)

export type ConnectionStateHandler = (state: ConnectionState) => void;

export interface ConnectionReconnectOptions {
  /** Start auto-reconnect after an unexpected drop. Default: true. */
  autoReconnect?: boolean;
  /** First backoff delay in ms. Default 1000. */
  baseDelayMs?: number;
  /** Max backoff delay in ms (cap). Default 15000. */
  maxDelayMs?: number;
  /** Max attempts before giving up (offline). Default Infinity. */
  maxAttempts?: number;
}

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 15_000;

// Colyseus 0.15 leave codes: 1000 = normal close (consented). >= 4000 are
// app-defined. We treat a normal/consented close as "do not auto-reconnect".
const NORMAL_CLOSE_CODE = 1000;

export class Connection {
  private client: Client;
  private room: Room | null = null;

  // Re-join material captured on the first successful connect().
  private joinOptions: JoinOptions | null = null;
  private authToken: string | undefined;

  // Registered S2C handlers, retained so we can re-attach after a re-join.
  private readonly handlers = new Map<string, MessageHandler<unknown>>();

  // External lifecycle callbacks (set once; survive reconnects).
  private leaveHandler: ((code: number) => void) | null = null;
  private errorHandler: ((code: number, message?: string) => void) | null = null;
  private stateHandler: ConnectionStateHandler | null = null;

  private readonly reconnectOpts: Required<ConnectionReconnectOptions>;
  private state: ConnectionState = "connecting";
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  constructor(reconnect: ConnectionReconnectOptions = {}) {
    this.client = new Client(serverWsEndpoint());
    this.reconnectOpts = {
      autoReconnect: reconnect.autoReconnect ?? true,
      baseDelayMs: reconnect.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      maxDelayMs: reconnect.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      maxAttempts: reconnect.maxAttempts ?? Number.POSITIVE_INFINITY,
    };
  }

  /** Join the office room with the dev auth profile. Resolves once joined.
   *  An optional auth token is preserved and re-sent on every reconnect. */
  async connect(opts: JoinOptions, authToken?: string): Promise<void> {
    this.joinOptions = opts;
    this.authToken = authToken;
    this.closedByUser = false;
    this.setState("connecting");
    this.room = await this.client.joinOrCreate(ROOM_NAME, this.joinPayload());
    this.attempt = 0;
    this.attachRoomLifecycle(this.room);
    this.setState("online");
  }

  /** This client's Colyseus session id (assigned after connect). Note: this
   *  changes after a reconnect (the server issues a fresh session). */
  get sessionId(): string {
    if (!this.room) throw new Error("Connection.sessionId read before connect()");
    return this.room.sessionId;
  }

  /** Current high-level connection state. */
  get connectionState(): ConnectionState {
    return this.state;
  }

  /** Register a typed handler for a server -> client message (S2C constant).
   *  Handlers are retained and re-attached automatically after a reconnect, so
   *  callers register once. Re-registering the same type replaces the handler. */
  on<T>(type: string, handler: MessageHandler<T>): void {
    this.handlers.set(type, handler as MessageHandler<unknown>);
    if (this.room) this.bindHandler(this.room, type, handler as MessageHandler<unknown>);
  }

  /** Send a typed client -> server message (C2S constant). Silently drops while
   *  disconnected (e.g. mid-reconnect) so callers never throw on a transient gap. */
  send<T>(type: string, payload: T): void {
    if (!this.room) return;
    this.room.send(type, payload);
  }

  /** Called whenever the room is left. Fires for every drop (including those
   *  that trigger an auto-reconnect) — use onState for UI banners instead if you
   *  only care about the user-visible state. */
  onLeave(handler: (code: number) => void): void {
    this.leaveHandler = handler;
  }

  onError(handler: (code: number, message?: string) => void): void {
    this.errorHandler = handler;
  }

  /** Subscribe to high-level connection-state transitions (UI banner driver). */
  onState(handler: ConnectionStateHandler): void {
    this.stateHandler = handler;
    // Emit current state immediately so the UI can render without waiting.
    handler(this.state);
  }

  /** Permanently close the connection and stop any reconnect attempts. */
  close(): void {
    this.closedByUser = true;
    this.clearReconnectTimer();
    this.setState("offline");
    if (this.room) {
      try {
        this.room.leave(true);
      } catch {
        /* already gone */
      }
      this.room = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private joinPayload(): JoinOptions & { token?: string } {
    const base = this.joinOptions as JoinOptions;
    return this.authToken ? { ...base, token: this.authToken } : { ...base };
  }

  private attachRoomLifecycle(room: Room): void {
    // Re-attach all retained message handlers to the new room.
    for (const [type, handler] of this.handlers) {
      this.bindHandler(room, type, handler);
    }

    room.onError((code: number, message?: string) => {
      this.errorHandler?.(code, message);
    });

    room.onLeave((code: number) => {
      this.leaveHandler?.(code);
      this.room = null;
      const consented = code === NORMAL_CLOSE_CODE;
      if (this.closedByUser || consented || !this.reconnectOpts.autoReconnect) {
        this.setState("offline");
        return;
      }
      this.scheduleReconnect();
    });
  }

  private bindHandler(room: Room, type: string, handler: MessageHandler<unknown>): void {
    room.onMessage(type, (payload: unknown) => handler(payload));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.attempt >= this.reconnectOpts.maxAttempts) {
      this.setState("offline");
      return;
    }
    this.setState("reconnecting");
    const delay = this.backoffDelay(this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.tryReconnect();
    }, delay);
  }

  private async tryReconnect(): Promise<void> {
    if (this.closedByUser || !this.joinOptions) return;
    try {
      this.room = await this.client.joinOrCreate(ROOM_NAME, this.joinPayload());
      this.attempt = 0;
      this.attachRoomLifecycle(this.room);
      this.setState("online");
    } catch {
      // Still down — schedule the next attempt (state stays "reconnecting").
      this.scheduleReconnect();
    }
  }

  /** Exponential backoff with full jitter: base*2^n capped at max, +/- jitter. */
  private backoffDelay(attempt: number): number {
    const exp = Math.min(
      this.reconnectOpts.maxDelayMs,
      this.reconnectOpts.baseDelayMs * 2 ** attempt,
    );
    // Full jitter in [exp/2, exp] keeps a floor while spreading reconnects.
    const jittered = exp / 2 + Math.random() * (exp / 2);
    return Math.round(jittered);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.stateHandler?.(state);
  }
}
