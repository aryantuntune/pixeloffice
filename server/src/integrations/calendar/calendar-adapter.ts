// ---------------------------------------------------------------------------
// Calendar integration boundary (Adapter Pattern, plan Layer 3).
//
// The presence service depends ONLY on this interface. A real
// GoogleCalendarAdapter (V1) / Microsoft365Adapter (V2) implements the same
// two methods. Integrations are optional: the service wraps every call in
// try/catch so a failing calendar never breaks the office (plan Principle 4).
// ---------------------------------------------------------------------------

import type { MeetingInfo } from "@pixeloffice/shared";

export interface CalendarAdapter {
  /**
   * The user's currently-active meeting, or null. `nowMs` supplied by caller.
   *
   * IDENTITY: `userId` MUST be a STABLE user identity — `identity.userId` in the
   * office (the IdP subject / dev slug), NOT a Colyseus sessionId (which changes
   * on every reconnect). A real GoogleCalendarAdapter keys events by the
   * authenticated user's account/email, so the seam must carry a stable id.
   */
  getCurrentMeeting(userId: string, nowMs: number): MeetingInfo | null;
  /**
   * Upcoming (not yet started) meetings for the user, soonest first.
   * `userId` is the same stable identity as `getCurrentMeeting`.
   */
  getUpcomingMeetings(userId: string, nowMs: number): MeetingInfo[];
}

export interface CreateMeetingInput {
  title: string;
  /**
   * Absolute meeting start time (epoch ms). Preferred for real scheduling.
   * `startsInMinutes` remains for backward-compatible local/dev callers.
   */
  startTime?: number;
  startsInMinutes?: number;
  durationMinutes: number;
  /** Optional office meeting room override for admin-scheduled mock meetings. */
  roomName?: string;
  /**
   * Stable user identities (identity.userId) invited. Empty/omitted = everyone
   * in the office.
   */
  participantIds?: string[];
}
