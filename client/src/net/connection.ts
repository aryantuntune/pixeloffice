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

// The Vite dev server port (client/vite.config.ts server.port). When the page
// is served from here the API/ws lives on a SEPARATE port (DEFAULT_SERVER_PORT).
// In any other topology (SERVE_CLIENT single-container behind an https proxy on
// 443, a LAN preview, etc.) the client is served from the SAME origin as the
// server, so we must dial that same host:port — NOT a hardcoded :2567.
// 5173 = vite dev, 4173 = vite preview — both serve ONLY the client, so the
// API/ws lives on DEFAULT_SERVER_PORT. Anything else is same-origin.
const SEPARATE_API_PORTS = new Set(["5173", "4173"]);

/** True when this page is served by Vite (dev or preview) — separate API. */
function isViteDev(): boolean {
  return SEPARATE_API_PORTS.has(location.port);
}

/** host[:port] to dial. In dev the API runs on DEFAULT_SERVER_PORT; otherwise
 *  the client is same-origin with the server so we reuse the page's host. */
function serverAuthority(): string {
  const hostname = location.hostname || "localhost";
  if (isViteDev()) return `${hostname}:${DEFAULT_SERVER_PORT}`;
  // Same-origin: location.host already includes the port (or none for 80/443).
  return location.host || `${hostname}:${DEFAULT_SERVER_PORT}`;
}

/** Derive the server HTTP base from the page location so the same build works
 *  in dev (Vite on :5173 -> API on :2567), over a LAN IP, and in the
 *  single-container same-origin (SERVE_CLIENT behind https) deployment. */
export function serverHttpBase(): string {
  const proto = location.protocol === "https:" ? "https" : "http";
  return `${proto}://${serverAuthority()}`;
}

function serverWsEndpoint(): string {
  // Colyseus 0.15 expects the ws(s) endpoint of the server.
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${serverAuthority()}`;
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

// Colyseus 0.15 leave codes. A *consented* close (the user left, or the server
// gracefully disconnected the room) must NOT trigger auto-reconnect:
//   - 4000 = CloseCode.CONSENTED (room.leave(true) AND server room.disconnect();
//            graceful shutdown sends this — reconnecting would storm a server
//            that just told everyone it is going away).
//   - 1000 = a plain WS normal close.
// 4010 = DEVMODE_RESTART is intentionally NOT consented: the dev server is
// coming back, so we SHOULD reconnect. (colyseus.js does not re-export these
// constants from its entrypoint, so we mirror them locally.)
const NORMAL_CLOSE_CODE = 1000;
const CONSENTED_CLOSE_CODE = 4000;

/** Extract a (code, message) from a rejected joinOrCreate. colyseus.js rejects
 *  with a ServerError ({ code, message }) for matchmake/auth rejections and a
 *  plain Error for transport failures; normalise both for the error handler. */
function describeJoinError(err: unknown): { code: number; message: string } {
  if (err && typeof err === "object" && "code" in err) {
    const e = err as { code?: unknown; message?: unknown };
    return {
      code: typeof e.code === "number" ? e.code : 0,
      message: typeof e.message === "string" ? e.message : String(err),
    };
  }
  return { code: 0, message: err instanceof Error ? err.message : String(err) };
}

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
    const room = await this.client.joinOrCreate(ROOM_NAME, this.joinPayload());
    // close() may have been called while the join was in flight; honour it
    // instead of resurrecting a connection the caller already abandoned.
    if (this.closedByUser) {
      try {
        room.leave(true);
      } catch {
        /* already gone */
      }
      return;
    }
    this.room = room;
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

  /** Merge profile fields into the retained join options so a reconnect
   *  re-sends the edited values. No-op if not yet connected. */
  updateJoinProfile(partial: Partial<JoinOptions>): void {
    if (!this.joinOptions) return;
    this.joinOptions = { ...this.joinOptions, ...partial };
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
      const consented = code === CONSENTED_CLOSE_CODE || code === NORMAL_CLOSE_CODE;
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
      const room = await this.client.joinOrCreate(ROOM_NAME, this.joinPayload());
      // close() may have fired while the join awaited — do not resurrect it.
      if (this.closedByUser) {
        try {
          room.leave(true);
        } catch {
          /* already gone */
        }
        return;
      }
      this.room = room;
      this.attempt = 0;
      this.attachRoomLifecycle(this.room);
      this.setState("online");
    } catch (err) {
      // Surface the failure (e.g. an expired/invalid auth token rejected by the
      // server) so the UI can react instead of looping silently forever, then
      // schedule the next attempt (state stays "reconnecting").
      const { code, message } = describeJoinError(err);
      this.errorHandler?.(code, message);
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
