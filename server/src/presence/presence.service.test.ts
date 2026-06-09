import { beforeEach, describe, expect, it } from "vitest";
import { PresenceState, type MeetingInfo } from "@pixeloffice/shared";
import { PresenceService, type PresenceChange } from "./presence.service";
import type { CalendarAdapter } from "../integrations/calendar/calendar-adapter";
import type { EventService } from "../events/event.service";

const NOW = 1_000_000;
const AWAY = 90_000;

/** Controllable calendar stub keyed by USER id (the stable identity). */
class FakeCalendar implements CalendarAdapter {
  current: MeetingInfo | null = null;
  throwIt = false;
  getCurrentMeeting(_userId: string, _now: number): MeetingInfo | null {
    if (this.throwIt) throw new Error("calendar down");
    return this.current;
  }
  getUpcomingMeetings(): MeetingInfo[] {
    return [];
  }
}

/** Minimal EventService stand-in (only isInActiveEvent is used by tick). */
class FakeEvents {
  inEvent = false;
  throwIt = false;
  isInActiveEvent(_sessionId: string, _now: number): boolean {
    if (this.throwIt) throw new Error("events down");
    return this.inEvent;
  }
}

function meeting(id: string): MeetingInfo {
  return {
    id,
    title: id,
    startTime: NOW,
    endTime: NOW + 60_000,
    participantIds: [],
    roomName: "Meeting Room C",
  };
}

function setup() {
  const cal = new FakeCalendar();
  const events = new FakeEvents();
  const svc = new PresenceService(cal, events as unknown as EventService, AWAY);
  const changes: PresenceChange[] = [];
  const started: Array<{ sessionId: string; meeting: MeetingInfo }> = [];
  const ended: Array<{ sessionId: string; meetingId: string }> = [];
  svc.on("change", (c: PresenceChange) => changes.push(c));
  svc.on("meeting-started", (e) => started.push(e));
  svc.on("meeting-ended", (e) => ended.push(e));
  return { cal, events, svc, changes, started, ended };
}

describe("PresenceService — initial tracking", () => {
  it("tracks a session as OFFLINE and resolves to AVAILABLE on the first tick", () => {
    const { svc, changes } = setup();
    svc.track("s1", "u1", NOW);
    expect(svc.getPresence("s1")).toEqual({ state: PresenceState.OFFLINE, source: "SYSTEM" });
    svc.tick(NOW);
    expect(svc.getPresence("s1")).toEqual({ state: PresenceState.AVAILABLE, source: "SYSTEM" });
    expect(changes).toEqual([{ sessionId: "s1", state: PresenceState.AVAILABLE, source: "SYSTEM" }]);
  });

  it("untrack removes the session", () => {
    const { svc } = setup();
    svc.track("s1", "u1", NOW);
    svc.untrack("s1");
    expect(svc.getPresence("s1")).toBeNull();
  });
});

describe("PresenceService — change dedup", () => {
  it("emits 'change' only on an actual state/source transition", () => {
    const { svc, changes } = setup();
    svc.track("s1", "u1", NOW);
    svc.tick(NOW); // OFFLINE -> AVAILABLE (1 change)
    svc.tick(NOW); // identical inputs -> no change
    svc.tick(NOW);
    expect(changes.length).toBe(1);
  });
});

describe("PresenceService — meeting start/end detection", () => {
  it("emits 'meeting-started' once when the meeting begins and 'meeting-ended' once when it ends", () => {
    const { cal, svc, started, ended } = setup();
    svc.track("s1", "u1", NOW);

    cal.current = meeting("m1");
    svc.tick(NOW);
    svc.tick(NOW); // still in m1 -> no duplicate start
    expect(started).toEqual([{ sessionId: "s1", meeting: cal.current }]);
    expect(svc.getPresence("s1")).toEqual({ state: PresenceState.IN_MEETING, source: "CALENDAR" });

    cal.current = null;
    svc.tick(NOW);
    svc.tick(NOW);
    expect(ended).toEqual([{ sessionId: "s1", meetingId: "m1" }]);
  });
});

describe("PresenceService — 'everyone' meeting does not auto-catch a newcomer (human agency)", () => {
  function everyoneMeeting(id: string, startTime: number): MeetingInfo {
    return { id, title: id, startTime, endTime: startTime + 60_000, participantIds: [], roomName: "Meeting Room C" };
  }

  it("an all-hands meeting already in progress when the user joins does NOT flip them to IN_MEETING", () => {
    const { cal, svc, started } = setup();
    // Meeting started BEFORE this session joined the office.
    cal.current = everyoneMeeting("m1", NOW - 10_000);
    svc.track("s1", "u1", NOW);
    svc.tick(NOW);
    expect(svc.getPresence("s1")).toEqual({ state: PresenceState.AVAILABLE, source: "SYSTEM" });
    expect(started).toEqual([]); // no silent meeting-started either
  });

  it("flips to IN_MEETING after the user EXPLICITLY joins that meeting", () => {
    const { cal, svc } = setup();
    cal.current = everyoneMeeting("m1", NOW - 10_000);
    svc.track("s1", "u1", NOW);
    svc.tick(NOW);
    expect(svc.getPresence("s1")?.state).toBe(PresenceState.AVAILABLE);
    svc.markMeetingJoined("s1", "m1"); // explicit Join click
    svc.tick(NOW);
    expect(svc.getPresence("s1")).toEqual({ state: PresenceState.IN_MEETING, source: "CALENDAR" });
  });

  it("an all-hands meeting that STARTS while the user is present still applies (no explicit join needed)", () => {
    const { cal, svc } = setup();
    svc.track("s1", "u1", NOW);
    svc.tick(NOW);
    cal.current = everyoneMeeting("m2", NOW + 5_000); // begins after join
    svc.tick(NOW + 5_000);
    expect(svc.getPresence("s1")).toEqual({ state: PresenceState.IN_MEETING, source: "CALENDAR" });
  });

  it("a SPECIFIC invite (the user is named) always applies regardless of join time", () => {
    const { cal, svc } = setup();
    cal.current = { id: "m3", title: "m3", startTime: NOW - 10_000, endTime: NOW + 60_000, participantIds: ["u1"], roomName: "Meeting Room A" };
    svc.track("s1", "u1", NOW);
    svc.tick(NOW);
    expect(svc.getPresence("s1")).toEqual({ state: PresenceState.IN_MEETING, source: "CALENDAR" });
  });
});

describe("PresenceService — graceful degradation", () => {
  it("a throwing calendar does NOT throw out of tick and degrades to no-meeting", () => {
    const { cal, svc } = setup();
    svc.track("s1", "u1", NOW);
    cal.throwIt = true;
    expect(() => svc.tick(NOW)).not.toThrow();
    expect(svc.getPresence("s1")?.state).toBe(PresenceState.AVAILABLE);
  });

  it("a throwing event service does NOT throw out of tick and degrades to no-event", () => {
    const { events, svc } = setup();
    svc.track("s1", "u1", NOW);
    events.throwIt = true;
    expect(() => svc.tick(NOW)).not.toThrow();
    expect(svc.getPresence("s1")?.state).toBe(PresenceState.AVAILABLE);
  });
});

describe("PresenceService — manual override + activity", () => {
  it("setManual('FOCUS') wins, and setManual('AVAILABLE') clears it on the next tick", () => {
    const { svc } = setup();
    svc.track("s1", "u1", NOW);
    svc.setManual("s1", "FOCUS");
    svc.tick(NOW);
    expect(svc.getPresence("s1")).toEqual({ state: PresenceState.FOCUS, source: "MANUAL" });
    svc.setManual("s1", "AVAILABLE"); // clears override
    svc.tick(NOW);
    expect(svc.getPresence("s1")).toEqual({ state: PresenceState.AVAILABLE, source: "SYSTEM" });
  });

  it("auto-AWAY after inactivity, and activity() clears it on the next tick", () => {
    const { svc } = setup();
    svc.track("s1", "u1", NOW);
    svc.tick(NOW + AWAY); // inactive for the full timeout -> AWAY/AUTO
    expect(svc.getPresence("s1")).toEqual({ state: PresenceState.AWAY, source: "AUTO" });
    svc.activity("s1", NOW + AWAY);
    svc.tick(NOW + AWAY);
    expect(svc.getPresence("s1")).toEqual({ state: PresenceState.AVAILABLE, source: "SYSTEM" });
  });
});
