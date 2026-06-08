#!/usr/bin/env node
// PixelOffice floor-sync companion.
//
// Reads the current WiFi SSID from the OS and POSTs it to the PixelOffice
// floor-report endpoint, so an opted-in user's in-office floor auto-updates to
// match where they're physically sitting.
//
// PRIVACY: this only reads the WiFi network name (SSID). It is sent to your
// PixelOffice server, mapped to a floor, and discarded. Nothing is stored on
// disk. It has no effect at all unless you enable "Sync my floor" in
// PixelOffice Settings. Must run on the SAME machine as your browser tab.
//
// Zero npm dependencies — Node built-ins only.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const execFileAsync = promisify(execFile);

// ---- Config (env) ----------------------------------------------------------

const SERVER = (process.env.FLOOR_SYNC_SERVER || "http://localhost:2567").replace(/\/+$/, "");
const INTERVAL = clampInterval(parseInt(process.env.FLOOR_SYNC_INTERVAL || "", 10), 20000);
const SECRET = process.env.FLOOR_SYNC_SECRET || "";
// PAIRING CODE: shown in PixelOffice Settings after you enable "Sync my floor".
// When set, it is sent as body.pairCode so the server ties this report to YOUR
// exact session regardless of IP (works behind NAT, a VPN, Docker, or with
// several browser tabs on one machine — where the IP match alone is ambiguous).
const PAIR_CODE = (process.env.FLOOR_SYNC_PAIR_CODE || "").trim();
const FAKE_SSID = process.env.FLOOR_SYNC_FAKE_SSID || "";
const ENDPOINT = SERVER + "/api/location/floor-report";

function clampInterval(value, fallback) {
  if (!Number.isFinite(value) || value < 1000) return fallback;
  return value;
}

// ---- SSID readers (per OS, best-effort) ------------------------------------

async function tryExec(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 8000 });
    return stdout || "";
  } catch {
    return "";
  }
}

async function readSsidLinux() {
  // nmcli -t -f active,ssid dev wifi  ->  lines like "yes:Hustle@KALVIUM2F5G"
  const out = await tryExec("nmcli", ["-t", "-f", "active,ssid", "dev", "wifi"]);
  for (const line of out.split("\n")) {
    if (line.startsWith("yes:")) {
      const ssid = line.slice("yes:".length).trim();
      if (ssid) return ssid;
    }
  }
  return "";
}

async function readSsidMac() {
  // Newer macOS deprecated the airport CLI. Try a few sources, take the first hit.
  // 1) Legacy airport -I (works on older macOS).
  const airport = await tryExec(
    "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport",
    ["-I"]
  );
  const airportMatch = airport.match(/^\s*SSID:\s*(.+)$/m);
  if (airportMatch && airportMatch[1].trim()) return airportMatch[1].trim();

  // 2) system_profiler SPAirPortDataType (newer; "Current Network Information:" block).
  const sp = await tryExec("system_profiler", ["SPAirPortDataType"]);
  const spMatch = sp.match(/Current Network Information:\s*\n\s*(.+?):\s*\n/);
  if (spMatch && spMatch[1].trim()) return spMatch[1].trim();

  // 3) wdutil info (very new macOS; may require sudo, so best-effort).
  const wd = await tryExec("wdutil", ["info"]);
  const wdMatch = wd.match(/^\s*SSID\s*:\s*(.+)$/m);
  if (wdMatch) {
    const ssid = wdMatch[1].trim();
    if (ssid && ssid !== "<redacted>") return ssid;
  }
  return "";
}

async function readSsidWindows() {
  // netsh wlan show interfaces -> a "SSID" line (must avoid the "BSSID" line).
  const out = await tryExec("netsh", ["wlan", "show", "interfaces"]);
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*SSID\s*:\s*(.+)$/);
    if (m && !/BSSID/i.test(line)) {
      const ssid = m[1].trim();
      if (ssid) return ssid;
    }
  }
  return "";
}

async function readSsid() {
  if (FAKE_SSID) return FAKE_SSID;
  switch (process.platform) {
    case "linux":
      return readSsidLinux();
    case "darwin":
      return readSsidMac();
    case "win32":
      return readSsidWindows();
    default:
      return "";
  }
}

// ---- HTTP report -----------------------------------------------------------

function postReport(ssid) {
  return new Promise((resolve, reject) => {
    const url = new URL(ENDPOINT);
    const payload = { ssid };
    if (PAIR_CODE) payload.pairCode = PAIR_CODE;
    if (SECRET) payload.secret = SECRET;
    const body = JSON.stringify(payload);
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 8000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch {
            // non-JSON body; surface status only
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("request timed out"));
    });
    req.write(body);
    req.end();
  });
}

// ---- Loop ------------------------------------------------------------------

let lastSsid = null;
let stopped = false;

async function tick() {
  let ssid = "";
  try {
    ssid = (await readSsid()).trim();
  } catch {
    ssid = "";
  }

  // Only act when the SSID changed since last tick (reduce noise).
  if (ssid === lastSsid) return;
  lastSsid = ssid;

  if (!ssid) {
    // Not on WiFi (or couldn't read it). Stay quiet but keep looping.
    return;
  }

  try {
    const res = await postReport(ssid);
    if (res.status === 200 && res.body) {
      const floor = res.body.floorId ? res.body.floorId : "no matching floor";
      console.log(`On ${ssid} -> reported (${floor}, applied to ${res.body.matched ?? 0})`);
    } else if (res.status === 401) {
      console.warn(`On ${ssid} -> rejected (401): FLOOR_SYNC_SECRET is required or wrong.`);
    } else if (res.status === 400) {
      console.warn(`On ${ssid} -> rejected (400): server says the SSID was empty/invalid.`);
    } else {
      console.warn(`On ${ssid} -> unexpected response (status ${res.status}).`);
    }
  } catch (err) {
    // Network down / server unreachable: warn once for this change, keep looping.
    console.warn(`On ${ssid} -> could not reach ${SERVER} (${err.message}). Will retry.`);
    // Reset so the next successful tick re-reports the same SSID.
    lastSsid = null;
  }
}

function startupHelp() {
  console.log("PixelOffice floor-sync companion");
  console.log(`  server   : ${SERVER}`);
  console.log(`  endpoint : ${ENDPOINT}`);
  console.log(`  interval : ${INTERVAL} ms`);
  console.log(`  secret   : ${SECRET ? "set" : "(none)"}`);
  console.log(`  pairCode : ${PAIR_CODE ? `set (${PAIR_CODE}) — ties reports to your session, any IP` : "(none) — falls back to matching by your machine's IP"}`);
  if (FAKE_SSID) console.log(`  FAKE SSID: ${FAKE_SSID} (testing override; OS WiFi not read)`);
  console.log("  privacy  : reads only the WiFi name; nothing is stored. Enable");
  console.log('             "Sync my floor" in PixelOffice Settings for it to take effect.');
  if (!PAIR_CODE) {
    console.log("  tip      : after enabling floor sync, copy the PAIRING CODE shown in");
    console.log("             Settings and re-run with FLOOR_SYNC_PAIR_CODE=<code> so this");
    console.log("             works behind NAT / a VPN / Docker / multiple browser tabs.");
  }
  console.log("  note     : run this on the SAME machine as your PixelOffice browser tab");
  console.log("             (or set FLOOR_SYNC_PAIR_CODE to pair without sharing an IP).");
  console.log("  (Ctrl+C to stop.)");
}

async function loop() {
  while (!stopped) {
    await tick();
    if (stopped) break;
    await sleep(INTERVAL);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });
}

process.on("SIGINT", () => {
  stopped = true;
  console.log("\nStopping floor-sync companion. Bye.");
  process.exit(0);
});

startupHelp();
loop();
