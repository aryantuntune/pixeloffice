# Google Workspace Integration Plan (Calendar → Presence + Meet)

Status: decision-ready. Target org: **kalvium.com** Google Workspace. Date: 2026-06-07.
Every nontrivial claim is sourced inline like `[1]`; see Sources at the bottom.

## Executive summary

- Ship as a GCP **OAuth consent screen of User Type = Internal** (project owned by the
  kalvium.com Workspace org). Internal apps **skip Google verification entirely** even for
  sensitive/restricted scopes, have no 100-user cap, no unverified-app screen, and no 7-day
  refresh-token expiry `[1][2]`.
- Request exactly one calendar scope: **`calendar.events.readonly`** (least privilege that still
  returns event titles, start/end, attendees, `transparency`, and the Meet link) `[3][4]`.
- Implement a **`GoogleCalendarAdapter`** behind the existing `CalendarAdapter` interface; it is a
  drop-in env-gated swap at `server/src/container.ts` (mirrors the GreytHR pattern already there).
- **Poll with `events.list` + `syncToken`** (incremental sync). Push channels (`events.watch`)
  need a public HTTPS webhook with a valid cert and are unusable on a LAN — offer them only when a
  public URL exists `[5][6]`.
- **Join Meet by opening `event.hangoutLink` in a new tab** (`target=_blank`). Meet cannot be
  iframed (X-Frame-Options/CSP by design); no Meet REST API and no extra scope are needed `[7][8]`.

## How it will work in the game (mapped to existing seams)

1. **Sign in** — unchanged. `GoogleOAuthProvider` (`server/src/auth/google-oauth.provider.ts`,
   scopes `openid email profile`) authenticates the user; identity flows through `AuthProvider`
   (`server/src/auth/auth-provider.ts`) → JWT session.
2. **"Connect Google Calendar"** (new HUD action in `client/src/ui/hud.ts`) triggers an
   **incremental** second authorization-code request to the same endpoint
   `https://accounts.google.com/o/oauth2/v2/auth` with `scope=…/calendar.events.readonly`,
   `include_granted_scopes=true`, `access_type=offline`, `prompt=consent`. `include_granted_scopes`
   keeps the sign-in scopes on the new token `[9]`; `access_type=offline` + `prompt=consent`
   guarantees a **refresh token** `[9][2]`.
3. **Token storage** — the calendar refresh token is persisted per stable `identity.userId`
   (new table/store, sibling to `server/src/persistence/`). NOTE: the current
   `GoogleOAuthProvider` requests `access_type:"online"` and discards tokens — calendar needs a
   **separate offline grant**; do not reuse the sign-in token.
4. **Presence** — `GoogleCalendarAdapter.getCurrentMeeting(userId, nowMs)` returns the active
   meeting; the presence engine already maps a live meeting → `IN_MEETING` (highest live priority,
   `server/src/presence/presence-engine.ts:51-52`). No engine change needed — the adapter just
   stops being the mock.
5. **Join Meet** — `getCurrentMeeting`/`getUpcomingMeetings` surface a new `meetLink` on
   `MeetingInfo` (`shared/src/types.ts:74`). The meeting-room **Join** UI renders an anchor to
   `meetLink` with `target=_blank rel=noopener`. This satisfies the constitution's "user must click
   Join" rule (a click = explicit human action); avatars are never teleported.

## OAuth scopes (minimal set)

| Scope | Why | Classification |
|---|---|---|
| `openid email profile` | sign-in (already used) | non-sensitive |
| `https://www.googleapis.com/auth/calendar.events.readonly` | read events incl. title, start/end, attendees, `transparency`, `hangoutLink`/`conferenceData` | sensitive (see note) `[3][4][10]` |

Do NOT request `calendar.readonly` (broader: adds calendar-list/ACL), the read/write
`calendar`/`calendar.events`, any Meet scope (`meetings.space.*`), or Drive scopes — none are
needed; the Meet link lives on the calendar event `[7]`. `freebusy`-only scopes can't return titles
or Meet links, so they're a degraded fallback only `[3]`.

**Sensitivity note (resolved):** Google's public scopes page does not visibly tag calendar read
scopes as sensitive, but the OAuth verification policy treats reading Calendar events as the
canonical *sensitive* example, and Cloud Console will flag it `[10]`. This is moot for an
**Internal** app — Internal apps skip sensitive/restricted review entirely `[2]`. Plan for sensitive
treatment only if the app ever goes External.

## Internal-app setup — kalvium.com admin walkthrough

1. **GCP project** must be owned by the kalvium.com Workspace org (a personal-gmail project cannot
   be Internal) `[2]`.
2. **OAuth consent screen → Audience → User Type = Internal** `[2]`. Consequence: no verification,
   no 100-user cap, no unverified-app warning, no 7-day token expiry `[1][2]`.
3. **Enable APIs**: Google Calendar API on the project. (No Meet API. People API only if you later
   add directory avatars.)
4. **Create OAuth client** (Web application); register the server's redirect URI.
5. **Admin Console → Security → Access and data control → API controls** `[11]`. If the org blocks
   unconfigured third-party apps, OAuth fails with HTTP 400 `admin_policy_enforced` until the app is
   allowlisted. Admin: *Add app → by OAuth Client ID →* grant **"Specific Google data"** limited to
   `calendar.events.readonly` (least privilege), or tick **Trust internal apps**. Include the
   sign-in scopes when configuring "Specific Google data" or sign-in can break `[11]`.
6. No **Marketplace listing** and no **domain-wide delegation** are required — per-user OAuth with
   user consent is the correct, Google-recommended path for a present user `[12][13]`.

## Calendar polling design

**Recommended (LAN-safe): `events.list` + `syncToken` incremental polling** `[5][6]`.
- Initial full sync per user: `events.list?singleEvents=true&orderBy=startTime&timeMin=<now>` →
  persist `nextSyncToken` from the last page.
- Incremental: `events.list?syncToken=<stored>` returns only changes (incl. cancellations); store
  the new token each round. Query params must be **byte-identical** across calls — do not pass
  `timeMin` alongside `syncToken` (400). On HTTP **410 Gone**, wipe and full-resync `[6]`.
- Cadence ~30–60s/user is far under quota (see below); compute `IN_MEETING` locally from
  start/end windows.

**Current-meeting check** uses a 1-second window: `timeMin=now`, `timeMax=now+1s`,
`singleEvents=true`. `timeMin` filters on event **end** (exclusive), `timeMax` on event **start**
(exclusive) — verified against the official reference `[4]`. In-meeting detection must filter in
code (the API does not): keep only `status!=="cancelled"`, `start.dateTime` present (skip all-day),
`transparency!=="transparent"` (absent = busy), self-attendee `responseStatus!=="declined"`, and
`start<=now<end` `[14]`.

**Push (`events.watch`) — only if a public HTTPS URL exists.** Requires a public webhook with a
valid (non-self-signed, trusted-CA) cert; no localhost/LAN delivery; channels are content-less
(still need `syncToken` to fetch the delta) and expire (default 7-day TTL, manual renew, no
auto-renew) `[5]`. The **Workspace Events API does NOT support Calendar** (Chat/Meet/Drive only) and
needs Pub/Sub + billing — not a fit `[15]`.

## Meet join path

Read the link from the calendar event and open it in a new tab. Prefer `event.hangoutLink`; fall
back to `conferenceData.entryPoints[]` where `entryPointType==="video"` (gate on
`conferenceSolution.key.type==="hangoutsMeet"` if you want Meet specifically) `[7]`. No
`conferenceDataVersion` param is needed for reads. Not every event has a Meet link — the Join button
must degrade gracefully (integrations optional). **Never iframe Meet** (X-Frame-Options/CSP) `[8]`.

## Quotas / limits (new project, post-2026-05-01 regime) `[16][17]`

| Limit | Value |
|---|---|
| Per project | 10,000 requests / minute |
| Per user per project | 600 requests / minute |
| Daily per project | 1,000,000 requests / 24h |
| Cost | Free today; overage billing planned later 2026 with ≥90 days notice |

~30–60s polling = 1–2 req/user/min, comfortably supporting hundreds of users. Handle 403/429
(`rateLimitExceeded`) and 5xx with exponential backoff + jitter regardless `[16]`.

## Privacy (aligns with the no-surveillance constitution)

- **We read:** the user's own primary-calendar events the user already sees — title, start/end,
  busy/free (`transparency`), attendee response, and the Meet join link `[14]`.
- **We never read:** keystrokes, mouse, screenshots; other people's calendars; Gmail/Drive/Chat;
  recordings or transcripts (would require restricted Drive scopes — explicitly excluded) `[7]`.
- **Title reading is optional.** Offer a per-user toggle: if off, drive `IN_MEETING` from busy
  blocks only (store/display "In a meeting", not the title). The narrowest minimal-permission mode
  is `freebusy` (busy/free only, no titles/links), available as a degraded fallback `[3]`.
- Google **Chat presence is not exposed** to third parties — presence stays derived internally,
  never scraped `[18]`.

## Implementation checklist (ordered)

1. **[M]** `GoogleCalendarAdapter implements CalendarAdapter`
   (`server/src/integrations/calendar/google-calendar.adapter.ts`): plain `fetch`,
   `events.list` (1s window for current; 12h window for upcoming), apply the in-code filters `[14]`,
   map to `MeetingInfo`.
2. **[S]** Add `meetLink?: string` to `MeetingInfo` (`shared/src/types.ts`) + fix the stale
   `participantIds` "sessionIds" comment to "stable identityIds". Populate `meetLink` from
   `hangoutLink`/video entrypoint.
3. **[M]** Offline calendar grant: extend the Google OAuth flow with an incremental authorize
   (`include_granted_scopes`, `access_type=offline`, `prompt=consent`) + a per-`userId` refresh-token
   store + token-refresh (`POST https://oauth2.googleapis.com/token`, `grant_type=refresh_token`)
   with reactive refresh on 401 `[9]`.
4. **[S]** Env-gate the swap in `server/src/container.ts:48-49`
   (`const calendar = googleCalConfigured ? new GoogleCalendarAdapter(...) : mockCalendar`),
   mirroring `greytHrConfigured`.
5. **[M]** `syncToken` incremental polling loop (per connected user) with 410→full-resync and
   429/5xx backoff.
6. **[S]** Client "Connect Google Calendar" HUD action + connected/disconnected state
   (`client/src/ui/hud.ts`, `client/src/ui/state.ts`).
7. **[S]** Meeting-room **Join** anchor → `meetLink` `target=_blank rel=noopener`; hide when absent.
8. **[S]** Error UX for `admin_policy_enforced` and `invalid_grant` → "ask your admin to allowlist"
   / "reconnect Google"; office keeps working if calendar fails (Principle 4).
9. **[S]** Optional title-privacy toggle (titles off → busy-only display).
10. **[M]** State-transition tests for the adapter's filter rules and IN_MEETING mapping (CLAUDE.md
    requires tests for state transitions).

## Sources

1. https://developers.google.com/identity/protocols/oauth2/production-readiness/overview — Internal user type: "Verification is not required." (upd 2026-05-22)
2. https://developers.google.com/workspace/guides/configure-oauth-consent — internal apps: restricted/sensitive scopes "doesn't require further review"; Internal needs org-owned project. (upd 2026-04-20)
3. https://developers.google.com/workspace/calendar/api/auth — Calendar scope strings + what each allows; freebusy can't return titles/links.
4. https://developers.google.com/workspace/calendar/api/v3/reference/events/list — timeMin=end(exclusive), timeMax=start(exclusive), singleEvents required for orderBy, nextSyncToken. (upd 2026-05-12)
5. https://developers.google.com/workspace/calendar/api/guides/push — events.watch needs public HTTPS+valid cert, content-less, 7-day TTL, manual renew.
6. https://developers.google.com/workspace/calendar/api/guides/sync — syncToken incremental flow, byte-identical params, 410 → full resync.
7. https://developers.google.com/workspace/calendar/api/v3/reference/events — hangoutLink (read-only) + conferenceData.entryPoints; Meet link lives on the event.
8. https://issuetracker.google.com/issues/289696532 — Meet iframe-embed unsupported (X-Frame-Options/CSP); open in new tab.
9. https://developers.google.com/identity/protocols/oauth2/web-server — incremental auth (include_granted_scopes), access_type=offline + prompt=consent for refresh token.
10. https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification — reading Calendar events is the canonical sensitive-scope example.
11. https://knowledge.workspace.google.com/admin/apps/control-which-apps-access-google-workspace-data — API controls allowlisting; admin_policy_enforced; Trust internal apps. (upd 2026-06-04)
12. https://developers.google.com/workspace/marketplace/configure-oauth-consent-screen — Marketplace not required for internal per-user OAuth.
13. https://support.google.com/a/answer/162106 — domain-wide delegation only for consent-bypass; per-user OAuth preferred.
14. https://developers.google.com/identity/protocols/oauth2/scopes — Calendar scope strings; sensitivity not visibly tagged on this page (see [10]).
15. https://developers.google.com/workspace/events — Workspace Events API supports Chat/Meet/Drive only, via Pub/Sub; not Calendar.
16. https://developers.google.com/workspace/calendar/api/guides/quota — per-project / per-user / daily limits; backoff guidance. (upd 2026-05-01)
17. https://developers.googleblog.com/the-google-calendar-api-has-changed-how-we-manage-api-usage/ — 2026-05-01 quota regime change; new projects get new quotas.
18. https://developers.google.com/workspace/chat/api/reference/rest — no presence/online-status resource exists. (upd 2026-06-01)
