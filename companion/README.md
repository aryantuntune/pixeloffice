# PixelOffice floor-sync companion

A tiny, zero-dependency helper that reads your computer's current **WiFi network
name (SSID)** and tells your PixelOffice server which physical floor you're on,
so your in-office avatar lands on the right floor automatically.

It exists because browsers can't read the WiFi SSID, and an office is often one
flat subnet (so the server can't tell floors apart by IP alone). This helper
runs alongside your browser and bridges that gap.

## Privacy

This is deliberately small and boring:

- It reads **only** the WiFi network name (SSID) from your OS — nothing else. No
  keystrokes, no mouse, no screenshots, no productivity tracking.
- The SSID is sent to **your** PixelOffice server, mapped to a floor id, and
  immediately **discarded**. The server never logs or persists the SSID or your
  IP, and keeps no location history.
- It does **nothing** unless you turn on **"Sync my floor to where I'm sitting"**
  in PixelOffice Settings. That opt-in is what lets a report move your avatar.
  Turn it off any time and reports are ignored.

## Requirements

- Node.js 18+ (uses only built-in modules — no `npm install` needed).
- Either run it on the **same machine** as your PixelOffice browser tab (the
  server then matches the report to your session by LAN IP), **or** pass a
  **pairing code** (`FLOOR_SYNC_PAIR_CODE`, below) so it matches by session
  regardless of IP. The pairing code is what makes this work behind shared
  office WiFi / NAT, a VPN, Docker, or with several browser tabs.

## Run it

Linux / macOS:

```sh
FLOOR_SYNC_SERVER=http://<office-server>:2567 node companion/floor-sync.mjs
```

Windows (PowerShell):

```powershell
$env:FLOOR_SYNC_SERVER="http://<office-server>:2567"; node companion/floor-sync.mjs
```

There's also a convenience wrapper for Linux/macOS:

```sh
FLOOR_SYNC_SERVER=http://<office-server>:2567 companion/floor-sync.sh
```

Then open PixelOffice in your browser, go to Settings, and enable
**"Sync my floor to where I'm sitting"**. That's it — when you move floors (and
connect to that floor's WiFi), your avatar follows.

## Pairing code (recommended)

By default the server matches a report to your browser session by **LAN IP**.
That breaks when several people share one egress IP (office WiFi / NAT, a VPN),
in Docker, or when you have multiple browser tabs on `localhost` in dev — you
can show **Remote** even with the toggle on.

To fix that, use a **pairing code**:

1. In PixelOffice **Settings**, enable **"Sync my floor"**. A short code (e.g.
   `FA9UES`) appears under **WiFi auto-detect**, along with the exact command.
2. Run the companion with that code:

   ```sh
   FLOOR_SYNC_SERVER=http://<office-server>:2567 \
   FLOOR_SYNC_PAIR_CODE=FA9UES \
   node companion/floor-sync.mjs
   ```

Now reports are tied to **your** session regardless of IP. The code is minted
per session, expires, and is invalidated when you turn sync off or disconnect.
It is never stored on disk and never logged by the server.

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `FLOOR_SYNC_SERVER` | `http://localhost:2567` | Base URL of your PixelOffice server. |
| `FLOOR_SYNC_INTERVAL` | `20000` | How often (ms) to check the SSID. Min 1000. |
| `FLOOR_SYNC_PAIR_CODE` | _(unset)_ | Pairing code shown in PixelOffice Settings after you enable floor sync. When set, sent as `body.pairCode` so reports match your session by code instead of IP (works behind shared WiFi / NAT / VPN / Docker / multiple tabs). |
| `FLOOR_SYNC_SECRET` | _(unset)_ | Optional shared secret, sent as `body.secret`. Set this only if your operator configured `FLOOR_SYNC_SECRET` on the server. |
| `FLOOR_SYNC_FAKE_SSID` | _(unset)_ | Testing override: report this literal SSID instead of reading WiFi (lets the companion run headless / in CI). |

The companion only POSTs when the SSID **changes** since the last check, so it's
quiet on the network and in your terminal. Press `Ctrl+C` to stop.

## How it reads the SSID

- **Linux:** `nmcli -t -f active,ssid dev wifi` (the active `yes:` line).
- **macOS:** best-effort across `airport -I` (older), `system_profiler
  SPAirPortDataType`, and `wdutil info` (newer macOS deprecated `airport`).
- **Windows:** `netsh wlan show interfaces` (the `SSID` line, not `BSSID`).

If it can't read an SSID (e.g. you're on Ethernet or WiFi is off), it stays
quiet and keeps polling — nothing breaks.

## Troubleshooting

- **`matched: 0` in the logs / nothing happens:** you haven't enabled "Sync my
  floor" in PixelOffice Settings, or no browser tab is open on this machine. If
  you're behind shared WiFi / a VPN / Docker / multiple tabs, set
  `FLOOR_SYNC_PAIR_CODE` to the code shown in Settings (see "Pairing code").
- **`401` rejected:** the server requires `FLOOR_SYNC_SECRET`; set it to match.
- **"could not reach ..." warnings:** the server URL is wrong or the server is
  down. The companion keeps retrying.
