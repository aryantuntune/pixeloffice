// ---------------------------------------------------------------------------
// GoogleCalendarAdapter — real CalendarAdapter backed by the Google Calendar
// API (events.list on the user's primary calendar). Plain `fetch`, no SDK.
//
// DESIGN (see docs/google-workspace-integration.md):
//   * The CalendarAdapter interface is SYNCHRONOUS (getCurrentMeeting /
//     getUpcomingMeetings). Google is async, so this adapter owns a BACKGROUND
//     refresh loop: it polls per connected user on an interval and answers
//     queries from an in-memory CACHE. The room tick stays untouched — start()
//     and stop() own the loop explicitly.
//   * Per-user access tokens are minted from the stored refresh token
//     (grant_type=refresh_token) and cached until ~60s before expiry.
//   * On `invalid_grant` the user's stored grant is deleted (disconnected); the
//     status endpoint then reflects connected:false.
//   * Integrations are OPTIONAL: any failure degrades silently to "no meetings"
//     with a single warn — the office keeps working (plan Principle 4).
//
// PRIVACY (no-surveillance constitution): we read ONLY the user's own primary
// calendar — exactly the title / start / end / busy-or-free / Meet link the
// presence product displays. We do NOT persist event bodies or attendee lists;
// the cache holds only the mapped MeetingInfo the UI shows. With
// GOOGLE_CAL_TITLES=false, titles are never even kept ("Busy").
//
// ENDPOINT BASES are env-overridable so a local stub can stand in for Google:
//   GOOGLE_TOKEN_BASE (default https://oauth2.googleapis.com)
//   GOOGLE_API_BASE   (default https://www.googleapis.com)
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { MeetingInfo } from "@pixeloffice/shared";
import type { CalendarAdapter } from "./calendar-adapter";
import { assignMeetingRoom } from "./mock-calendar.adapter";
import type {
  GoogleTokenRecord,
  GoogleTokenStore,
} from "../../auth/google-token.store";
import type { FetchLike } from "../../auth/oauth-provider";

const DEFAULT_TOKEN_BASE = "https://oauth2.googleapis.com";
const DEFAULT_API_BASE = "https://www.googleapis.com";
const CAL_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.events.owned",
] as const;

/** Default poll cadence (ms) — 1–2 req/user/min, far under quota. */
const DEFAULT_POLL_MS = 45_000;
/** Forward window for "upcoming" meetings. */
const DEFAULT_WINDOW_MS = 12 * 60 * 60 * 1000; // ~12h
/** Per-request network timeout. */
const REQUEST_TIMEOUT_MS = 5_000;
/** Refresh the access token this long before it actually expires. */
const TOKEN_SKEW_MS = 60_000;

export interface GoogleCalendarConfig {
  clientId: string;
  clientSecret: string;
  /** Override https://oauth2.googleapis.com (refresh-token mint). */
  tokenBase?: string;
  /** Override https://www.googleapis.com (events.list). */
  apiBase?: string;
  /** Poll interval in ms (env GOOGLE_CAL_POLL_MS). Default 45000. */
  pollIntervalMs?: number;
  /** When false, titles are replaced with "Busy" (env GOOGLE_CAL_TITLES=false). */
  includeTitles?: boolean;
  /** Forward window for upcoming meetings (ms). Default ~12h. */
  windowMs?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** Injectable warn sink (tests). Defaults to console.warn. */
  warn?: (msg: string) => void;
}

/** Cached, minted access token for a single user. */
interface AccessToken {
  token: string;
  expiresAtMs: number;
}

// --- Minimal shapes of the Google Calendar event resource we consume --------
interface GEventDateTime {
  dateTime?: string; // RFC3339 — present for timed events
  date?: string; // YYYY-MM-DD — present for ALL-DAY events
}
interface GEventAttendee {
  email?: string;
  resource?: boolean;
  self?: boolean;
  responseStatus?: string; // "declined" | "accepted" | ...
}
interface GEventEntryPoint {
  entryPointType?: string; // "video" | "phone" | ...
  uri?: string;
}
interface GEvent {
  id?: string;
  status?: string; // "cancelled" | "confirmed" | ...
  summary?: string;
  start?: GEventDateTime;
  end?: GEventDateTime;
  transparency?: string; // "transparent" => free/not-busy
  attendees?: GEventAttendee[];
  hangoutLink?: string;
  conferenceData?: { entryPoints?: GEventEntryPoint[] };
}
interface GEventsListResponse {
  items?: GEvent[];
}

export interface GoogleCreateMeetingInput {
  organizerUserId: string;
  title: string;
  startTime: number;
  endTime: number;
  roomName: string;
  attendeeEmails?: string[];
  roomEmail?: string;
}

export class GoogleCalendarAdapter implements CalendarAdapter {
  private readonly tokenBase: string;
  private readonly apiBase: string;
  private readonly pollIntervalMs: number;
  private readonly includeTitles: boolean;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly warn: (msg: string) => void;

  /** Per-user mapped-meeting cache (what the UI shows — no raw event bodies). */
  private readonly cache = new Map<string, MeetingInfo[]>();
  /** Per-user minted access tokens. */
  private readonly accessTokens = new Map<string, AccessToken>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: GoogleCalendarConfig,
    private readonly tokens: GoogleTokenStore,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  ) {
    this.tokenBase = (config.tokenBase ?? DEFAULT_TOKEN_BASE).replace(/\/+$/, "");
    this.apiBase = (config.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.includeTitles = config.includeTitles ?? true;
    this.windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = config.now ?? (() => Date.now());
    this.warn = config.warn ?? ((m) => console.warn(m));
  }

  // --- CalendarAdapter (synchronous cache reads) ---------------------------

  getCurrentMeeting(userId: string, nowMs: number): MeetingInfo | null {
    const meetings = this.cache.get(userId);
    if (!meetings) return null;
    // current = start <= now < end. Prefer the most-recently-started on overlap.
    let best: MeetingInfo | null = null;
    for (const m of meetings) {
      if (m.startTime <= nowMs && nowMs < m.endTime) {
        if (best === null || m.startTime > best.startTime) best = m;
      }
    }
    return best;
  }

  getUpcomingMeetings(userId: string, nowMs: number): MeetingInfo[] {
    const meetings = this.cache.get(userId);
    if (!meetings) return [];
    return meetings
      .filter((m) => m.startTime > nowMs)
      .sort((a, b) => a.startTime - b.startTime);
  }

  async createMeeting(input: GoogleCreateMeetingInput): Promise<MeetingInfo> {
    if (!(input.endTime > input.startTime)) {
      throw new Error("endTime must be after startTime");
    }
    const accessToken = await this.accessTokenFor(input.organizerUserId);
    const params = new URLSearchParams({
      conferenceDataVersion: "1",
      sendUpdates: "all",
    });
    const attendees = [...new Set(input.attendeeEmails ?? [])]
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0)
      .map((email) => ({ email }));
    const roomEmail = input.roomEmail?.trim().toLowerCase();
    if (roomEmail) attendees.push({ email: roomEmail, resource: true });
    const requestId = `pixeloffice-${randomUUID()}`;
    const res = await this.timedFetch(
      `${this.apiBase}/calendar/v3/calendars/primary/events?${params.toString()}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          summary: input.title,
          location: `PixelOffice - ${input.roomName}`,
          start: { dateTime: new Date(input.startTime).toISOString() },
          end: { dateTime: new Date(input.endTime).toISOString() },
          ...(attendees.length > 0 ? { attendees } : {}),
          conferenceData: {
            createRequest: {
              requestId,
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`events.insert failed (${res.status})`);
    }
    const ev = (await res.json()) as GEvent;
    const startTime = ev.start?.dateTime ? Date.parse(ev.start.dateTime) : input.startTime;
    const endTime = ev.end?.dateTime ? Date.parse(ev.end.dateTime) : input.endTime;
    const meeting: MeetingInfo = {
      id: ev.id ?? `gcal_created_${input.startTime}`,
      title: this.includeTitles ? (ev.summary ?? input.title) : "Busy",
      startTime: Number.isFinite(startTime) ? startTime : input.startTime,
      endTime: Number.isFinite(endTime) ? endTime : input.endTime,
      participantIds: [input.organizerUserId],
      roomName: input.roomName,
      ...(extractMeetLink(ev) ? { meetLink: extractMeetLink(ev)! } : {}),
    };
    const cached = this.cache.get(input.organizerUserId) ?? [];
    this.cache.set(input.organizerUserId, [...cached.filter((m) => m.id !== meeting.id), meeting]);
    return meeting;
  }

  // --- Background refresh loop --------------------------------------------

  /** Start the per-user poll loop. Idempotent. Does an immediate refresh. */
  start(): void {
    if (this.timer) return;
    void this.refreshAll();
    this.timer = setInterval(() => {
      void this.refreshAll();
    }, this.pollIntervalMs);
    // Do not keep the process alive solely for the calendar poll.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Stop the poll loop. Safe to call when not started. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Refresh every connected user's cache once (best-effort, never throws). */
  async refreshAll(): Promise<void> {
    let userIds: string[];
    try {
      userIds = await this.tokens.connectedUserIds();
    } catch (err) {
      this.warn(`[google-calendar] could not list connected users: ${asMsg(err)}`);
      return;
    }
    // Drop cache entries for users who disconnected since the last round.
    const live = new Set(userIds);
    for (const cached of [...this.cache.keys()]) {
      if (!live.has(cached)) this.cache.delete(cached);
    }
    for (const userId of userIds) {
      await this.refreshUser(userId);
    }
  }

  /** Refresh one user's cache. Degrades to "no meetings" on any failure. */
  async refreshUser(userId: string): Promise<void> {
    try {
      const events = await this.fetchEvents(userId);
      this.cache.set(userId, this.mapEvents(userId, events));
    } catch (err) {
      if (err instanceof InvalidGrantError) {
        // The refresh token is dead — disconnect the user so status reflects it.
        this.accessTokens.delete(userId);
        this.cache.delete(userId);
        try {
          await this.tokens.delete(userId);
        } catch {
          /* best-effort */
        }
        this.warn(`[google-calendar] invalid_grant for ${userId}; disconnected`);
        return;
      }
      // Integrations are optional: degrade silently to "no meetings".
      this.cache.set(userId, []);
      this.warn(`[google-calendar] refresh failed for ${userId}: ${asMsg(err)}`);
    }
  }

  // --- Events fetch (one retry after token refresh on 401) ----------------

  private async fetchEvents(userId: string): Promise<GEvent[]> {
    const accessToken = await this.accessTokenFor(userId);
    let res = await this.listEvents(accessToken);
    if (res.status === 401) {
      // Token may have been revoked/expired early — mint a fresh one once.
      const fresh = await this.accessTokenFor(userId, /* force */ true);
      res = await this.listEvents(fresh);
    }
    if (!res.ok) {
      throw new Error(`events.list failed (${res.status})`);
    }
    const body = (await res.json()) as GEventsListResponse;
    return Array.isArray(body.items) ? body.items : [];
  }

  private async listEvents(
    accessToken: string,
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
    const now = this.now();
    // VERIFIED semantics: timeMin filters event END (exclusive), timeMax filters
    // event START (exclusive). To include in-progress meetings (start<=now<end)
    // AND upcoming ones in the forward window, ask for events ending after now
    // and starting before now+window.
    const params = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: new Date(now).toISOString(),
      timeMax: new Date(now + this.windowMs).toISOString(),
      maxResults: "50",
    });
    const url = `${this.apiBase}/calendar/v3/calendars/primary/events?${params.toString()}`;
    return this.timedFetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  // --- Access-token minting from the refresh token ------------------------

  private async accessTokenFor(userId: string, force = false): Promise<string> {
    const cached = this.accessTokens.get(userId);
    if (!force && cached && cached.expiresAtMs - TOKEN_SKEW_MS > this.now()) {
      return cached.token;
    }
    const record = await this.tokens.get(userId);
    if (!record || !record.refreshToken) {
      throw new InvalidGrantError("no refresh token for user");
    }
    const minted = await this.mintAccessToken(record);
    this.accessTokens.set(userId, minted);
    return minted.token;
  }

  private async mintAccessToken(record: GoogleTokenRecord): Promise<AccessToken> {
    const res = await this.timedFetch(`${this.tokenBase}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: record.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    if (!res.ok) {
      // Distinguish a dead grant (do not retry) from transient failures.
      let errCode = "";
      try {
        const body = (await res.json()) as { error?: string };
        errCode = body.error ?? "";
      } catch {
        /* ignore parse errors */
      }
      if (errCode === "invalid_grant") {
        throw new InvalidGrantError("refresh token rejected");
      }
      throw new Error(`token refresh failed (${res.status})`);
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      throw new Error("token refresh returned no access_token");
    }
    const ttlMs = (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000;
    return { token: body.access_token, expiresAtMs: this.now() + ttlMs };
  }

  // --- Filtering + mapping (the API does NOT filter — we do, in code) -------

  private mapEvents(userId: string, events: GEvent[]): MeetingInfo[] {
    const out: MeetingInfo[] = [];
    for (const ev of events) {
      if (!this.isBusyMeeting(ev)) continue;
      const startTime = Date.parse(ev.start!.dateTime!);
      const endTime = ev.end?.dateTime ? Date.parse(ev.end.dateTime) : NaN;
      if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) continue;
      out.push({
        id: ev.id ?? `gcal_${startTime}`,
        title: this.includeTitles ? (ev.summary ?? "Meeting") : "Busy",
        startTime,
        endTime,
        // A real calendar event maps to the connected user's own identity.
        participantIds: [userId],
        // Size-based room assignment, reusing the mock adapter's helper. A
        // single-user Google meeting -> "Meeting Room A" (1-2 -> A).
        roomName: assignMeetingRoom(1),
        ...(extractMeetLink(ev) ? { meetLink: extractMeetLink(ev)! } : {}),
      });
    }
    return out;
  }

  /** Apply the doc's in-code filters; keep only real, busy, timed meetings. */
  private isBusyMeeting(ev: GEvent): boolean {
    if (ev.status === "cancelled") return false; // dropped/deleted
    if (!ev.start?.dateTime) return false; // all-day (start.date) — skip
    if (ev.transparency === "transparent") return false; // free, not busy
    // Self responseStatus=declined => the user is not in this meeting.
    const self = ev.attendees?.find((a) => a.self);
    if (self && self.responseStatus === "declined") return false;
    return true;
  }

  // --- Networking with an AbortController timeout --------------------------

  private async timedFetch(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      // The injected FetchLike (and global fetch) accepts a `signal`; it is not
      // part of the narrow FetchLike type, so widen the init for this call.
      return await this.fetchImpl(url, { ...init, signal: controller.signal } as never);
    } finally {
      clearTimeout(t);
    }
  }
}

/** Sentinel: the refresh token is permanently dead — disconnect the user. */
class InvalidGrantError extends Error {}

/** Prefer hangoutLink; fall back to a video conferenceData entry point. */
function extractMeetLink(ev: GEvent): string | undefined {
  if (ev.hangoutLink) return ev.hangoutLink;
  const video = ev.conferenceData?.entryPoints?.find(
    (e) => e.entryPointType === "video" && typeof e.uri === "string" && e.uri.length > 0,
  );
  return video?.uri;
}

function asMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export { CAL_SCOPES };
