# Floor Detection Notes

Status: planning notes for the next pass.

## Goal

PixelOffice should show whether an opted-in user is in office or remote, and when
in office, which floor they are on.

Kalvium office SSIDs:

- `Hustle@KALVIUMGF`
- `Hustle@KALVIUM1F5G`
- `Hustle@KALVIUM2F5G`
- same pattern for 2.4G networks

Expected product behavior:

- Ground floor Wi-Fi should map to `ground`.
- First floor Wi-Fi should map to `floor-1`.
- Second floor Wi-Fi should map to `floor-2`.
- Any other network should be treated as `REMOTE`.
- Detection must remain opt-in.
- Store only the current `OFFICE` / `REMOTE` tag and current floor.
- Do not store SSID history, IP history, movement history, or who-was-where-when.

## Important Constraint

A normal browser app cannot read the connected Wi-Fi SSID. Without a companion
client/native helper, browser-only detection must be based on request metadata
available to the server, mainly the client IP.

That means the next implementation should use the per-floor IP ranges/patterns
instead of trying to read SSID in the browser.

## Next Input Needed

Collect sample IPs for each floor:

- Ground floor: several connected client IPs
- First floor: several connected client IPs
- Second floor: several connected client IPs
- Remote / non-office: a few examples if available

Once we have those, inspect the pattern:

- Are floors separate subnets, for example `/24` ranges?
- Are all floors inside one shared subnet?
- Is there a stable gateway, VLAN, or DHCP range distinction?
- Are IPs hidden behind NAT/proxy/VPN before reaching PixelOffice?

## Likely Implementation Path

If the IP pattern is reliable:

1. Configure floor mapping through `OFFICE_SUBNETS`.
2. Keep `OFFICE_CIDRS` for office-but-floor-unknown ranges.
3. Update docs and `.env.example` with the actual Kalvium values.
4. Add tests for each floor range and for remote fallback.
5. Verify the Settings floor-sync toggle updates the location pill and moves the
   avatar only after explicit opt-in.

If the IP pattern is not reliable:

- Browser-only floor detection will not be technically reliable.
- The fallback should be explicit user-selected floor, still opt-in and
  reversible.
- A native/helper client remains the only way to read SSID automatically.

## Current Code Areas

- `server/src/location/floor-location.adapter.ts`
- `server/src/location/ssid-floor.ts`
- `server/src/http/location.routes.ts`
- `server/src/rooms/office.room.ts`
- `client/src/ui/settings.ts`
- `docs/SSID-FLOOR-SYNC.md`

