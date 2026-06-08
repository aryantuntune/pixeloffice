// ---------------------------------------------------------------------------
// Settings popover. A ⚙ button in the top bar (distinct from the bottom-right
// Admin button) opens a small popover with three preferences:
//   • camera zoom slider (1.0–2.0) → game.setZoom
//   • reduced-motion toggle → body.reduced-motion class (CSS) + game.setReducedMotion
//   • hide-NPCs toggle → game.setNpcVisibility + filter roster + minimap dots
// All three persist in localStorage and are applied on boot. A "Show tour" link
// re-arms the onboarding tour. Pure preferences UI: it stores/forwards intents
// through callbacks; no presence/meeting business logic lives here.
// ---------------------------------------------------------------------------

import { CAMERA_ZOOM, ZOOM_MAX as ZOOM_MAX_CONST, ZOOM_MIN as ZOOM_MIN_CONST } from "../game/constants";
import { serverHttpBase } from "../net/connection";

// v2: reset stale stored zooms so the 1.5x default takes effect for everyone.
const ZOOM_KEY = "pixeloffice.settings.zoom.v2";
const MOTION_KEY = "pixeloffice.settings.reducedMotion";
const HIDE_NPC_KEY = "pixeloffice.settings.hideNpcs";
// OPT-IN physical-floor sync. OFF by default; never set without the user flipping
// the toggle (the constitution forbids employer-forced location tracking).
const LOCATION_SYNC_KEY = "pixeloffice.settings.locationSync";

// Slider bounds + default mirror the scene's camera constants.
const ZOOM_MIN = ZOOM_MIN_CONST;
const ZOOM_MAX = ZOOM_MAX_CONST;
const ZOOM_DEFAULT = CAMERA_ZOOM;

export interface SettingsValues {
  zoom: number;
  reducedMotion: boolean;
  hideNpcs: boolean;
  /** OPT-IN: sync my floor to the office network I'm on. OFF by default. */
  locationSync: boolean;
}

export interface SettingsCallbacks {
  onZoom(zoom: number): void;
  onReducedMotion(on: boolean): void;
  onHideNpcs(hidden: boolean): void;
  /**
   * The OPT-IN floor-sync toggle changed. Forwards the intent only — the actual
   * C2S.SET_LOCATION_SYNC send + any consented floor move happen server-side via
   * the wiring in main.ts. `enabled: true` may result in the server moving the
   * avatar to the detected floor (consented because the user flipped this switch).
   */
  onLocationSync(enabled: boolean): void;
  /** Re-arm + start the onboarding tour ("Show tour" link). */
  onShowTour(): void;
}

export interface SettingsHandle {
  /** Re-apply the persisted values to the game/body (call after each (re)boot
   *  since the game handle is recreated). Does NOT toggle the popover. */
  applyToGame(): void;
  /** Current persisted values (used to seed minimap/roster NPC filtering). */
  values(): SettingsValues;
  /**
   * Surface the companion PAIRING CODE the server minted for this session
   * (S2C.FLOOR_SYNC_CODE), received after the user enabled floor sync. The WiFi
   * help block then shows the exact companion command WITH the code, so a report
   * is tied to THIS session regardless of IP (NAT / VPN / Docker / multi-tab).
   * Per-session + transient: not persisted. Pass null to clear it (sync off).
   */
  setPairCode(code: string | null): void;
  destroy(): void;
}

function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return ZOOM_DEFAULT;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

function readValues(): SettingsValues {
  const read = (k: string): string | null => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  return {
    zoom: clampZoom(Number(read(ZOOM_KEY) ?? ZOOM_DEFAULT)),
    reducedMotion: read(MOTION_KEY) === "1",
    hideNpcs: read(HIDE_NPC_KEY) === "1",
    locationSync: read(LOCATION_SYNC_KEY) === "1",
  };
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — preference just won't persist */
  }
}

/** Read-only accessor used by other widgets (minimap/roster) without mounting. */
export function readHideNpcs(): boolean {
  try {
    return localStorage.getItem(HIDE_NPC_KEY) === "1";
  } catch {
    return false;
  }
}

export function mountSettings(parent: HTMLElement, cb: SettingsCallbacks): SettingsHandle {
  const state = readValues();
  // Apply the reduced-motion body class immediately on mount so CSS animations
  // are suppressed from the first paint when the user previously opted in.
  document.body.classList.toggle("reduced-motion", state.reducedMotion);

  // Trigger button in the top bar.
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "settings-trigger";
  trigger.setAttribute("aria-label", "Settings");
  trigger.textContent = "⚙";

  const pop = document.createElement("div");
  pop.className = "settings-pop";
  pop.hidden = true;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Settings");

  const heading = document.createElement("div");
  heading.className = "settings-heading";
  heading.textContent = "Settings";

  // --- Zoom slider --------------------------------------------------------
  const zoomField = document.createElement("label");
  zoomField.className = "settings-field";
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "settings-label";
  const zoomValueLabel = (): string => `Camera zoom · ${state.zoom.toFixed(1)}×`;
  zoomLabel.textContent = zoomValueLabel();
  const zoomInput = document.createElement("input");
  zoomInput.type = "range";
  zoomInput.min = String(ZOOM_MIN);
  zoomInput.max = String(ZOOM_MAX);
  zoomInput.step = "0.1";
  zoomInput.value = String(state.zoom);
  zoomInput.className = "settings-slider";
  zoomInput.addEventListener("input", () => {
    state.zoom = clampZoom(Number(zoomInput.value));
    zoomLabel.textContent = zoomValueLabel();
    write(ZOOM_KEY, String(state.zoom));
    cb.onZoom(state.zoom);
  });
  zoomField.append(zoomLabel, zoomInput);

  // --- Reduced motion toggle ---------------------------------------------
  const motionField = document.createElement("label");
  motionField.className = "settings-field settings-toggle";
  const motionText = document.createElement("span");
  motionText.className = "settings-label";
  motionText.textContent = "Reduce motion";
  const motionInput = document.createElement("input");
  motionInput.type = "checkbox";
  motionInput.checked = state.reducedMotion;
  motionInput.addEventListener("change", () => {
    state.reducedMotion = motionInput.checked;
    write(MOTION_KEY, state.reducedMotion ? "1" : "0");
    document.body.classList.toggle("reduced-motion", state.reducedMotion);
    cb.onReducedMotion(state.reducedMotion);
  });
  motionField.append(motionText, motionInput);

  // --- Hide NPCs toggle ---------------------------------------------------
  const npcField = document.createElement("label");
  npcField.className = "settings-field settings-toggle";
  const npcText = document.createElement("span");
  npcText.className = "settings-label";
  npcText.textContent = "Hide office bots";
  const npcInput = document.createElement("input");
  npcInput.type = "checkbox";
  npcInput.checked = state.hideNpcs;
  npcInput.addEventListener("change", () => {
    state.hideNpcs = npcInput.checked;
    write(HIDE_NPC_KEY, state.hideNpcs ? "1" : "0");
    cb.onHideNpcs(state.hideNpcs);
  });
  npcField.append(npcText, npcInput);

  // --- Floor sync toggle (OPT-IN physical-location) -----------------------
  // OFF by default. Browsers cannot read the WiFi SSID — detection is SERVER-SIDE
  // from the client IP only. Turning it ON tags the user Office/Remote and, if
  // their IP maps to a real floor, the server moves them there (consented: they
  // flipped the switch). Privacy: we never store a location history. Fully
  // revocable — turning it off clears the badge and never moves the avatar.
  const locField = document.createElement("label");
  locField.className = "settings-field settings-toggle settings-loc";
  const locTextWrap = document.createElement("span");
  locTextWrap.className = "settings-loc-text";
  const locText = document.createElement("span");
  locText.className = "settings-label";
  locText.textContent = "📍 Sync my floor to where I'm sitting";
  const locNote = document.createElement("span");
  locNote.className = "settings-note";
  locNote.textContent =
    "Uses your office network to set your floor. Off when you're remote. We never store your location history.";
  locTextWrap.append(locText, locNote);
  const locInput = document.createElement("input");
  locInput.type = "checkbox";
  locInput.checked = state.locationSync;
  locField.append(locTextWrap, locInput);

  // --- WiFi auto-detect help (companion helper) ---------------------------
  // Informational only: floor sync works purely from the user's opt-in toggle
  // (the server detects from the client IP). But on a flat office subnet the IP
  // can't separate floors, so an OPTIONAL tiny companion helper on this machine
  // reads the WiFi name and reports it. This block just explains how to run it.
  // It adds NO network calls — the companion does the reporting. We surface it
  // only while floor sync is ON, since it's meaningless when opted out.
  // The command derives its server origin from serverHttpBase() (the same value
  // the app already dials), so it's correct in dev, LAN, and same-origin deploys.
  const wifi = document.createElement("details");
  wifi.className = "settings-wifi";
  const wifiSummary = document.createElement("summary");
  wifiSummary.className = "settings-wifi-summary";
  wifiSummary.textContent = "WiFi auto-detect (optional)";
  const wifiBody = document.createElement("div");
  wifiBody.className = "settings-wifi-body";
  const wifiHelp = document.createElement("p");
  wifiHelp.className = "settings-wifi-help";
  wifiHelp.textContent =
    "Your floor updates automatically if you run the tiny companion helper on this machine:";
  const wifiCmd = document.createElement("code");
  wifiCmd.className = "settings-wifi-cmd";
  // Copy hint: the box is `user-select: all` (click selects all) as a no-JS
  // fallback; clicking also copies to the clipboard when available, flashing a
  // brief "Copied" confirmation. Pure UI sugar — no network, no business logic.
  wifiCmd.title = "Click to copy";
  let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
  wifiCmd.addEventListener("click", () => {
    const text = wifiCmd.textContent ?? "";
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(
      () => {
        wifiCmd.classList.add("is-copied");
        if (copyResetTimer) clearTimeout(copyResetTimer);
        copyResetTimer = setTimeout(() => wifiCmd.classList.remove("is-copied"), 1400);
      },
      () => {
        /* clipboard blocked (insecure context / denied) — user-select:all still
           lets them copy manually; no error surfaced. */
      },
    );
  });
  // The per-session PAIRING CODE the server minted (S2C.FLOOR_SYNC_CODE). When
  // present, fold it into the command (FLOOR_SYNC_PAIR_CODE=...) so the report is
  // tied to THIS session regardless of IP — the fix for NAT / VPN / Docker /
  // multiple localhost tabs sharing one egress IP. Null = no code yet (the user
  // just enabled, or sync is off): show the plain IP-fallback command.
  let pairCode: string | null = null;
  const renderWifiCmd = (): void => {
    const base = `FLOOR_SYNC_SERVER=${serverHttpBase()}`;
    wifiCmd.textContent = pairCode
      ? `${base} FLOOR_SYNC_PAIR_CODE=${pairCode} node companion/floor-sync.mjs`
      : `${base} node companion/floor-sync.mjs`;
  };
  renderWifiCmd();
  const wifiPair = document.createElement("p");
  wifiPair.className = "settings-wifi-pair";
  const renderPairNote = (): void => {
    wifiPair.textContent = pairCode
      ? `Pairing code ${pairCode} — included above so this works even behind shared WiFi/NAT, a VPN, Docker, or multiple tabs.`
      : "";
    wifiPair.hidden = !pairCode;
  };
  renderPairNote();
  const wifiPrivacy = document.createElement("p");
  wifiPrivacy.className = "settings-wifi-privacy";
  wifiPrivacy.textContent =
    "Only your WiFi name is read on your machine; nothing is stored.";
  wifiBody.append(wifiHelp, wifiCmd, wifiPair, wifiPrivacy);
  wifi.append(wifiSummary, wifiBody);
  // Visibility tracks the opt-in toggle; collapse when hidden so reopening the
  // section is a deliberate act each time it's shown.
  const syncWifiVisibility = (): void => {
    wifi.hidden = !state.locationSync;
    if (!state.locationSync) wifi.open = false;
  };
  syncWifiVisibility();

  locInput.addEventListener("change", () => {
    state.locationSync = locInput.checked;
    write(LOCATION_SYNC_KEY, state.locationSync ? "1" : "0");
    syncWifiVisibility();
    cb.onLocationSync(state.locationSync);
  });

  // --- Show tour link -----------------------------------------------------
  const tourRow = document.createElement("div");
  tourRow.className = "settings-field";
  const tourLink = document.createElement("button");
  tourLink.type = "button";
  tourLink.className = "settings-tour-link";
  tourLink.textContent = "Show tour again";
  tourLink.addEventListener("click", () => {
    pop.hidden = true;
    cb.onShowTour();
  });
  tourRow.appendChild(tourLink);

  pop.append(heading, zoomField, motionField, npcField, locField, wifi, tourRow);

  const wrap = document.createElement("div");
  wrap.className = "settings-wrap";
  wrap.append(trigger, pop);
  parent.appendChild(wrap);

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
  });
  const onDocClick = (e: MouseEvent): void => {
    if (!pop.hidden && !wrap.contains(e.target as Node)) pop.hidden = true;
  };
  const onKey = (e: KeyboardEvent): void => {
    if (!pop.hidden && e.key === "Escape") pop.hidden = true;
  };
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);

  return {
    applyToGame(): void {
      cb.onZoom(state.zoom);
      cb.onReducedMotion(state.reducedMotion);
      cb.onHideNpcs(state.hideNpcs);
      // Re-assert the persisted floor-sync preference on every (re)boot: each new
      // server session starts the user untagged, so if they previously opted IN we
      // re-send the consent to restore their badge (and any consented floor move).
      // We only re-send when ON — never auto-disable on the server (it's already
      // off there by default), keeping reconnects idempotent and honest.
      if (state.locationSync) cb.onLocationSync(true);
    },
    values(): SettingsValues {
      return { ...state };
    },
    setPairCode(code: string | null): void {
      pairCode = code && code.trim().length > 0 ? code.trim() : null;
      renderWifiCmd();
      renderPairNote();
    },
    destroy(): void {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
      wrap.remove();
    },
  };
}
