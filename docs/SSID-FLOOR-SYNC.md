# SSID -> Floor Sync (companion floor reports)

How a per-machine **companion helper** reports the WiFi SSID so the server can
place an **opted-in** user on the right physical floor.

## Why this exists

Browsers cannot read the WiFi SSID, and a typical office is one flat `/16`
subnet, so the IP-based floor detection (`OFFICE_SUBNETS`) cannot tell floors
apart when they share a subnet. A small companion helper on each machine reads
the SSID via the OS and POSTs it to the server, which maps `SSID -> floor` and
applies it to the user sitting at that machine.

## Constitution (non-negotiable)

- **Opt-in only.** A report is **applied** only to a user who has enabled
  "Sync my floor to where I'm sitting" in Settings (the existing
  `SET_LOCATION_SYNC` toggle). A report for a user who has not opted in returns
  `matched: 0` and changes nothing — no move, no tag.
- **Presence, not surveillance.** The server **never logs or persists the SSID
  or the IP**, and keeps **no** location history. It stores only the current
  `place` (`OFFICE`) + current floor.
- **Human agency.** A report may move the avatar **only because the user opted
  in** — that consent is the action. Opting out clears the tag and never moves.

## Endpoint

```
POST /api/location/floor-report
Content-Type: application/json

{ "ssid": "Hustle@KALVIUM2F5G", "pairCode": "<optional>", "secret": "<optional>" }
```

Response (always `200` unless the secret is required and wrong, or the body is
malformed):

```jsonc
{ "floorId": "floor-2", "matched": 1 }   // resolved + applied to 1 opted-in session
{ "floorId": null,      "matched": 0 }   // SSID matched no rule — benign no-op
```

- `floorId` — the resolved floor id, or `null` when the SSID matched no rule.
- `matched` — how many of the **caller's own** live sessions were updated. `0`
  is normal and fine: the user simply has not enabled floor sync (or no browser
  session is open on that machine right now).

Status codes:

- `200` — resolved (whether or not anything was applied; `matched` tells you).
- `400` — missing/empty `ssid`.
- `401` — `FLOOR_SYNC_SECRET` is configured and `body.secret` is missing/wrong.

### Session-matching model (pairing code, then IP fallback)

A report has to land on the **right** session. There are two ways:

**1. Pairing code (preferred — IP-independent).** When a user enables floor sync,
the server mints a short, human-typable code (6 chars, e.g. `FA9UES`) for that
session and pushes it to that client as `S2C.FLOOR_SYNC_CODE`. The client shows
it in **Settings** along with the exact companion command. The user pastes it
into the companion as `FLOOR_SYNC_PAIR_CODE`, and the companion sends it as
`body.pairCode`. The server resolves the code to the **exact session** that
minted it and applies the floor there, **ignoring IP entirely**.

This is the fix for the fragile IP match: multiple clients behind **one egress
IP** (shared office WiFi / NAT, a corporate VPN, Docker, or several browser tabs
on `localhost` during dev) all collide on IP, so without a code a user could
show **Remote** even with the toggle ON. The code makes floor sync work for
**many users on one network** and in **local dev with multiple tabs**.

The code lives only in memory as `code -> { sessionId, userId }` with a TTL, is
re-minted on every enable / re-join, and is **invalidated on disable or leave**.
It is **never logged or persisted** and is never tied to an IP or SSID.

**2. IP fallback (zero-setup, single user).** With **no** `pairCode` (or an
unknown/expired one), the server matches the report against the client IP it
captured for each connected session (the same `X-Forwarded-For`/socket logic the
rest of the app uses, honoring `TRUST_PROXY`) and applies the resolved floor to
that IP's opted-in sessions. The companion and the browser run on the **same
machine**, so they share a LAN IP. You can only ever affect your **own**
machine's sessions, so a self-reported floor has no abuse surface — which is why
the shared secret is optional. This keeps the single-user, one-machine case
working with **no extra setup** (no code to copy).

In both paths, the **opt-in gate is identical**: a report only applies to a
session whose floor sync is ENABLED, so a pairing code (or IP match) for a user
who has not opted in returns `matched: 0` and changes nothing.

If the resolved floor differs from the user's current floor, the server performs
the **same consented floor change** the elevator uses (free landing tile,
`PLAYER_LEFT`/`PLAYER_JOINED` to the two floors, `FLOOR_CHANGED` to the mover)
and broadcasts `S2C.LOCATION` (floor-scoped). If it's the same floor, the user
is just tagged `OFFICE`.

## Companion contract (what to build)

1. Read the current WiFi SSID from the OS:
   - macOS: `networksetup -getairportnetwork <iface>` or the CoreWLAN API.
   - Windows: `netsh wlan show interfaces`.
   - Linux: `nmcli -t -f active,ssid dev wifi`.
2. POST it to `http://<server>:2567/api/location/floor-report` on a small
   interval (e.g. every 30-60 s) and on SSID change. Include `pairCode` when the
   user has supplied one (`FLOOR_SYNC_PAIR_CODE`) and `secret` if the operator
   set `FLOOR_SYNC_SECRET`.
3. Do **not** store the SSID anywhere; just report the current value. The server
   is the same — it never logs/persists it (nor the pair code beyond its
   in-memory TTL entry).

The bundled companion (`companion/floor-sync.mjs`) does all of this. Point it at
your server and, optionally, paste the pairing code:

```sh
FLOOR_SYNC_SERVER=http://<server>:2567 \
FLOOR_SYNC_PAIR_CODE=FA9UES \
node companion/floor-sync.mjs
```

The client/browser surfaces the **pairing code** in Settings (after the user
enables floor sync) and the exact command to copy; the user's in-app
**floor-sync toggle** is what gates whether a report is applied.

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `SSID_FLOOR_MAP` | `KALVIUMGF=ground,KALVIUM1F=floor-1,KALVIUM2F=floor-2` | Comma-separated `substring=floorId` rules. **Case-insensitive substring** match, evaluated in order, **first match wins**. `floorId` must exist in the active building. |
| `FLOOR_SYNC_SECRET` | _(unset)_ | Optional shared secret the companion must send as `body.secret`. Unset = endpoint accepts the report (self-report has no abuse surface). Enforced (when set) even when a `pairCode` is supplied. |
| `FLOOR_SYNC_PAIR_CODE` | _(unset)_ | **Companion-side** env (not a server env). The code shown in PixelOffice Settings after a user enables floor sync. When set, the companion sends it as `body.pairCode` so the report ties to that exact session regardless of IP. There is nothing to configure on the server — codes are minted per session in memory with a TTL. |

Because `SSID_FLOOR_MAP` defaults to the KALVIUM map, SSID sync is effectively
**always available** — but a report still only **applies** to opted-in users, so
a zero-config or fully-remote deploy is unaffected.

Substring matching tolerates band suffixes and prefixes: `KALVIUM2F`,
`Hustle@KALVIUM2F5G`, and `Hustle@KALVIUM2F2.4G` all resolve to `floor-2`.

## Privacy summary

The SSID is resolved to a floor id and **discarded**; the IP is matched and
**discarded**. Nothing about either is logged, persisted, or kept as history.
The pairing code maps only to `{ sessionId, userId }` in memory with a TTL — it
is never logged or persisted, and is invalidated on disable / leave. The only
state retained is the current `place`/floor on the live session, which the user
clears at will by turning floor sync off.
