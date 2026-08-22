// ---------------------------------------------------------------------------
// In-memory mock calendar. Trivially replaceable by a GoogleCalendarAdapter:
// it holds a plain array of meetings and answers the CalendarAdapter queries
// from it. Admin REST seeds meetings via `createMeeting`.
//
// Identity note: meetings target STABLE user identities (identity.userId), NOT
// Colyseus sessionIds — so a real GoogleCalendarAdapter (which keys events by
// the authenticated user's account) is a drop-in replacement. An empty
// `participantIds` means "everyone in the office". The presence engine queries
// per session but passes that session's userId as the lookup id here. The
// parameter is named `id` to make that explicit.
// ---------------------------------------------------------------------------

import type { MeetingInfo } from "@pixeloffice/shared";
import type { CalendarAdapter, CreateMeetingInput } from "./calendar-adapter";

let meetingSeq = 0;

/** Room assignment by invitee count (CONTRACT.md). 0/empty = everyone -> Room C. */
export function assignMeetingRoom(participantCount: number): string {
  if (participantCount === 0) return "Meeting Room C"; // everyone
  if (participantCount <= 4) return "Meeting Room A";
  if (participantCount <= 8) return "Meeting Room B";
  return "Meeting Room C";
}

export class MockCalendarAdapter implements CalendarAdapter {
  private readonly meetings: MeetingInfo[] = [];

  /** Does this meeting apply to the given identity right now? Empty = everyone. */
  private appliesTo(meeting: MeetingInfo, id: string): boolean {
    return meeting.participantIds.length === 0 || meeting.participantIds.includes(id);
  }

  getCurrentMeeting(id: string, nowMs: number): MeetingInfo | null {
    // Deterministic tie-break when several meetings overlap (CONTRACT.md):
    //   1. prefer a meeting the user is EXPLICITLY invited to over an
    //      "everyone" meeting (specific invites must not be shadowed);
    //   2. among ties, prefer the most-recently-started (max startTime).
    // This mirrors how a real calendar surfaces the user's own event rather
    // than the first one ever inserted.
    let best: MeetingInfo | null = null;
    let bestSpecific = false;
    for (const m of this.meetings) {
      if (m.startTime <= nowMs && nowMs < m.endTime && this.appliesTo(m, id)) {
        const specific = m.participantIds.length > 0;
        if (
          best === null ||
          (specific && !bestSpecific) ||
          (specific === bestSpecific && m.startTime > best.startTime)
        ) {
          best = m;
          bestSpecific = specific;
        }
      }
    }
    return best;
  }

  getUpcomingMeetings(id: string, nowMs: number): MeetingInfo[] {
    return this.meetings
      .filter((m) => m.startTime > nowMs && this.appliesTo(m, id))
      .sort((a, b) => a.startTime - b.startTime);
  }

  /** All meetings active at `nowMs` regardless of participant (room helper). */
  activeMeetings(nowMs: number): MeetingInfo[] {
    return this.meetings.filter((m) => m.startTime <= nowMs && nowMs < m.endTime);
  }

  /** Admin REST entry point. Returns the created meeting. */
  createMeeting(input: CreateMeetingInput, nowMs: number): MeetingInfo {
    // Validate at the adapter boundary so EVERY CalendarAdapter implementation
    // enforces it: a zero/negative-duration meeting could never become active
    // (now < endTime would be false), so reject it instead of silently
    // consuming an id that never fires MEETING_STARTED.
    if (!(input.durationMinutes > 0)) {
      throw new Error("durationMinutes must be greater than 0");
    }
    const hasAbsoluteStart = typeof input.startTime === "number";
    if (!hasAbsoluteStart && !(typeof input.startsInMinutes === "number" && input.startsInMinutes >= 0)) {
      throw new Error("startTime or startsInMinutes must be provided");
    }
    const participantIds = Array.isArray(input.participantIds) ? [...input.participantIds] : [];
    const startTime = hasAbsoluteStart
      ? Math.round(input.startTime!)
      : nowMs + Math.round(input.startsInMinutes! * 60_000);
    if (startTime < nowMs) {
      throw new Error("startTime must not be in the past");
    }
    const endTime = startTime + Math.round(input.durationMinutes * 60_000);
    const meeting: MeetingInfo = {
      id: `meeting_${Date.now()}_${meetingSeq++}`,
      title: input.title,
      startTime,
      endTime,
      participantIds,
      roomName: input.roomName || assignMeetingRoom(participantIds.length),
    };
    this.meetings.push(meeting);
    return meeting;
  }
}
