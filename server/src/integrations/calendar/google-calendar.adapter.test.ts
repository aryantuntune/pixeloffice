// ---------------------------------------------------------------------------
// GoogleCalendarAdapter — filtering rules, windowing, token mint/retry/disconnect,
// meetLink extraction, titles-off. All fetch is mocked; no network.
// ---------------------------------------------------------------------------

import { describe, expect, it, beforeEach } from "vitest";
import { GoogleCalendarAdapter } from "./google-calendar.adapter";
import {
  InMemoryGoogleTokenStore,
  type GoogleTokenStore,
} from "../../auth/google-token.store";
import type { FetchLike } from "../../auth/oauth-provider";

const NOW = 1_700_000_000_000;
const USER = "google:abc";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A scripted fetch: token endpoint returns a token, events endpoint returns items. */
interface FetchScript {
  /** Response for the token-mint POST (default: a valid access token). */
  token?: () => { ok: boolean; status: number; body: unknown };
  /** Response for the events.list GET (default: empty list). */
  events?: (callIndex: number) => { ok: boolean; status: number; body: unknown };
}

function makeFetch(script: FetchScript): { fetchImpl: FetchLike; calls: () => { token: number; events: number } } {
  let tokenCalls = 0;
  let eventsCalls = 0;
  const fetchImpl: FetchLike = async (input: string) => {
    if (input.includes("/token")) {
      tokenCalls++;
      const r = script.token
        ? script.token()
        : { ok: true, status: 200, body: { access_token: `AT${tokenCalls}`, expires_in: 3600 } };
      return resp(r);
    }
    // events.list
    const idx = eventsCalls++;
    const r = script.events
      ? script.events(idx)
      : { ok: true, status: 200, body: { items: [] } };
    return resp(r);
  };
  return { fetchImpl, calls: () => ({ token: tokenCalls, events: eventsCalls }) };
}

function resp(r: { ok: boolean; status: number; body: unknown }) {
  return {
    ok: r.ok,
    status: r.status,
    json: async () => r.body,
    text: async () => JSON.stringify(r.body),
  };
}

function adapter(
  fetchImpl: FetchLike,
  tokens: GoogleTokenStore,
  opts: Partial<ConstructorParameters<typeof GoogleCalendarAdapter>[0]> = {},
): GoogleCalendarAdapter {
  return new GoogleCalendarAdapter(
    {
      clientId: "cid",
      clientSecret: "sec",
      tokenBase: "https://token.test",
      apiBase: "https://api.test",
      now: () => NOW,
      warn: () => {},
      ...opts,
    },
    tokens,
    fetchImpl,
  );
}

function connectedStore(): GoogleTokenStore {
  const s = new InMemoryGoogleTokenStore();
  s.save(USER, { refreshToken: "RT" });
  return s;
}

function eventsBody(items: unknown[]) {
  return { ok: true, status: 200, body: { items } };
}

describe("GoogleCalendarAdapter — filtering", () => {
  let tokens: GoogleTokenStore;
  beforeEach(() => {
    tokens = connectedStore();
  });

  async function refreshWith(items: unknown[], opts = {}): Promise<GoogleCalendarAdapter> {
    const { fetchImpl } = makeFetch({ events: () => eventsBody(items) });
    const a = adapter(fetchImpl, tokens, opts);
    await a.refreshUser(USER);
    return a;
  }

  const live = {
    id: "ev1",
    status: "confirmed",
    summary: "Standup",
    start: { dateTime: iso(NOW - 60_000) },
    end: { dateTime: iso(NOW + 60_000) },
  };

  it("keeps a live busy timed meeting (start<=now<end)", async () => {
    const a = await refreshWith([live]);
    const cur = a.getCurrentMeeting(USER, NOW);
    expect(cur?.id).toBe("ev1");
    expect(cur?.title).toBe("Standup");
    expect(cur?.participantIds).toEqual([USER]);
    expect(cur?.roomName).toBe("Meeting Room A");
  });

  it("drops status=cancelled", async () => {
    const a = await refreshWith([{ ...live, status: "cancelled" }]);
    expect(a.getCurrentMeeting(USER, NOW)).toBeNull();
  });

  it("drops all-day events (start.date, no dateTime)", async () => {
    const a = await refreshWith([
      { id: "ad", status: "confirmed", summary: "Holiday", start: { date: "2023-11-14" }, end: { date: "2023-11-15" } },
    ]);
    expect(a.getCurrentMeeting(USER, NOW)).toBeNull();
  });

  it("drops transparency=transparent (free, not busy)", async () => {
    const a = await refreshWith([{ ...live, transparency: "transparent" }]);
    expect(a.getCurrentMeeting(USER, NOW)).toBeNull();
  });

  it("drops events where self responseStatus=declined", async () => {
    const a = await refreshWith([
      { ...live, attendees: [{ self: true, responseStatus: "declined" }] },
    ]);
    expect(a.getCurrentMeeting(USER, NOW)).toBeNull();
  });

  it("keeps events where self responseStatus=accepted", async () => {
    const a = await refreshWith([
      { ...live, attendees: [{ self: true, responseStatus: "accepted" }] },
    ]);
    expect(a.getCurrentMeeting(USER, NOW)?.id).toBe("ev1");
  });
});

describe("GoogleCalendarAdapter — current vs upcoming windowing", () => {
  it("separates a live meeting from an upcoming one", async () => {
    const tokens = connectedStore();
    const items = [
      {
        id: "now",
        status: "confirmed",
        summary: "Now",
        start: { dateTime: iso(NOW - 1000) },
        end: { dateTime: iso(NOW + 1000) },
      },
      {
        id: "soon",
        status: "confirmed",
        summary: "Soon",
        start: { dateTime: iso(NOW + 3_600_000) },
        end: { dateTime: iso(NOW + 7_200_000) },
      },
    ];
    const { fetchImpl } = makeFetch({ events: () => eventsBody(items) });
    const a = adapter(fetchImpl, tokens);
    await a.refreshUser(USER);

    expect(a.getCurrentMeeting(USER, NOW)?.id).toBe("now");
    const up = a.getUpcomingMeetings(USER, NOW);
    expect(up.map((m) => m.id)).toEqual(["soon"]);
  });

  it("returns empty cache for an unconnected user", () => {
    const { fetchImpl } = makeFetch({});
    const a = adapter(fetchImpl, new InMemoryGoogleTokenStore());
    expect(a.getCurrentMeeting("nobody", NOW)).toBeNull();
    expect(a.getUpcomingMeetings("nobody", NOW)).toEqual([]);
  });
});

describe("GoogleCalendarAdapter — token mint, 401 retry, invalid_grant", () => {
  const live = {
    id: "ev1",
    status: "confirmed",
    summary: "Standup",
    start: { dateTime: iso(NOW - 60_000) },
    end: { dateTime: iso(NOW + 60_000) },
  };

  it("mints an access token from the refresh token before listing events", async () => {
    const tokens = connectedStore();
    const { fetchImpl, calls } = makeFetch({ events: () => eventsBody([live]) });
    const a = adapter(fetchImpl, tokens);
    await a.refreshUser(USER);
    expect(calls().token).toBe(1);
    expect(a.getCurrentMeeting(USER, NOW)?.id).toBe("ev1");
  });

  it("retries once with a fresh token after a 401", async () => {
    const tokens = connectedStore();
    const { fetchImpl, calls } = makeFetch({
      events: (i) => (i === 0 ? { ok: false, status: 401, body: {} } : eventsBody([live])),
    });
    const a = adapter(fetchImpl, tokens);
    await a.refreshUser(USER);
    expect(calls().token).toBe(2); // initial + forced refresh
    expect(calls().events).toBe(2); // 401 then success
    expect(a.getCurrentMeeting(USER, NOW)?.id).toBe("ev1");
  });

  it("disconnects the user on invalid_grant (token mint rejected)", async () => {
    const tokens = connectedStore();
    const { fetchImpl } = makeFetch({
      token: () => ({ ok: false, status: 400, body: { error: "invalid_grant" } }),
    });
    const a = adapter(fetchImpl, tokens);
    await a.refreshUser(USER);
    expect(await tokens.get(USER)).toBeNull(); // grant deleted
    expect(a.getCurrentMeeting(USER, NOW)).toBeNull();
  });

  it("degrades to no meetings (keeps grant) on a transient 5xx", async () => {
    const tokens = connectedStore();
    const { fetchImpl } = makeFetch({
      events: () => ({ ok: false, status: 503, body: {} }),
    });
    const a = adapter(fetchImpl, tokens);
    await a.refreshUser(USER);
    expect(await tokens.get(USER)).not.toBeNull(); // grant preserved
    expect(a.getCurrentMeeting(USER, NOW)).toBeNull();
  });
});

describe("GoogleCalendarAdapter — meetLink extraction", () => {
  const base = {
    id: "ev1",
    status: "confirmed",
    summary: "Sync",
    start: { dateTime: iso(NOW - 1000) },
    end: { dateTime: iso(NOW + 1000) },
  };

  async function linkFor(extra: Record<string, unknown>): Promise<string | undefined> {
    const tokens = connectedStore();
    const { fetchImpl } = makeFetch({ events: () => eventsBody([{ ...base, ...extra }]) });
    const a = adapter(fetchImpl, tokens);
    await a.refreshUser(USER);
    return a.getCurrentMeeting(USER, NOW)?.meetLink;
  }

  it("uses hangoutLink when present", async () => {
    expect(await linkFor({ hangoutLink: "https://meet.google.com/abc-defg-hij" })).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
  });

  it("falls back to a video conferenceData entry point", async () => {
    expect(
      await linkFor({
        conferenceData: {
          entryPoints: [
            { entryPointType: "phone", uri: "tel:+1" },
            { entryPointType: "video", uri: "https://meet.google.com/xyz" },
          ],
        },
      }),
    ).toBe("https://meet.google.com/xyz");
  });

  it("prefers hangoutLink over conferenceData", async () => {
    expect(
      await linkFor({
        hangoutLink: "https://meet.google.com/primary",
        conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/secondary" }] },
      }),
    ).toBe("https://meet.google.com/primary");
  });

  it("omits meetLink when no link exists", async () => {
    expect(await linkFor({})).toBeUndefined();
  });
});

describe("GoogleCalendarAdapter — titles-off mode", () => {
  it("replaces titles with 'Busy' when includeTitles=false", async () => {
    const tokens = connectedStore();
    const items = [
      {
        id: "ev1",
        status: "confirmed",
        summary: "Confidential 1:1",
        start: { dateTime: iso(NOW - 1000) },
        end: { dateTime: iso(NOW + 1000) },
      },
    ];
    const { fetchImpl } = makeFetch({ events: () => eventsBody(items) });
    const a = adapter(fetchImpl, tokens, { includeTitles: false });
    await a.refreshUser(USER);
    expect(a.getCurrentMeeting(USER, NOW)?.title).toBe("Busy");
  });
});

describe("GoogleCalendarAdapter — create Google Meet-backed events", () => {
  it("inserts a primary-calendar event with a unique Meet conference request", async () => {
    const tokens = connectedStore();
    const calls: Array<{ url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
    const fetchImpl: FetchLike = async (input: string, init?: unknown) => {
      const narrowed = init as { method?: string; headers?: Record<string, string>; body?: string } | undefined;
      calls.push({ url: input, init: narrowed ?? {} });
      if (input.includes("/token")) {
        return resp({ ok: true, status: 200, body: { access_token: "AT", expires_in: 3600 } });
      }
      return resp({
        ok: true,
        status: 200,
        body: {
          id: "gcal-created",
          summary: "Design Review",
          start: { dateTime: iso(NOW + 60_000) },
          end: { dateTime: iso(NOW + 31 * 60_000) },
          hangoutLink: "https://meet.google.com/new-link",
        },
      });
    };
    const a = adapter(fetchImpl, tokens);

    const meeting = await a.createMeeting({
      organizerUserId: USER,
      title: "Design Review",
      startTime: NOW + 60_000,
      endTime: NOW + 31 * 60_000,
      roomName: "Meeting Room B",
      attendeeEmails: ["a@example.com", "b@example.com"],
    });

    expect(meeting).toMatchObject({
      id: "gcal-created",
      title: "Design Review",
      startTime: NOW + 60_000,
      endTime: NOW + 31 * 60_000,
      participantIds: [USER],
      roomName: "Meeting Room B",
      meetLink: "https://meet.google.com/new-link",
    });

    const insert = calls.find((c) => c.url.includes("/calendar/v3/calendars/primary/events"));
    expect(insert?.url).toContain("conferenceDataVersion=1");
    expect(insert?.url).toContain("sendUpdates=all");
    expect(insert?.init.method).toBe("POST");
    expect(insert?.init.headers?.Authorization).toBe("Bearer AT");
    const body = JSON.parse(insert?.init.body ?? "{}");
    expect(body).toMatchObject({
      summary: "Design Review",
      location: "PixelOffice - Meeting Room B",
      start: { dateTime: iso(NOW + 60_000) },
      end: { dateTime: iso(NOW + 31 * 60_000) },
      attendees: [{ email: "a@example.com" }, { email: "b@example.com" }],
    });
    expect(body.conferenceData.createRequest.requestId).toMatch(/^pixeloffice-/);
  });
});

describe("GoogleCalendarAdapter — refreshAll prunes disconnected users", () => {
  it("drops cache for a user no longer in connectedUserIds", async () => {
    const tokens = connectedStore();
    const live = {
      id: "ev1",
      status: "confirmed",
      summary: "X",
      start: { dateTime: iso(NOW - 1000) },
      end: { dateTime: iso(NOW + 1000) },
    };
    const { fetchImpl } = makeFetch({ events: () => eventsBody([live]) });
    const a = adapter(fetchImpl, tokens);
    await a.refreshAll();
    expect(a.getCurrentMeeting(USER, NOW)?.id).toBe("ev1");

    await tokens.delete(USER);
    await a.refreshAll();
    expect(a.getCurrentMeeting(USER, NOW)).toBeNull();
  });
});
