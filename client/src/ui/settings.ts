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

const ZOOM_KEY = "pixeloffice.settings.zoom";
const MOTION_KEY = "pixeloffice.settings.reducedMotion";
const HIDE_NPC_KEY = "pixeloffice.settings.hideNpcs";

const ZOOM_MIN = 1.0;
const ZOOM_MAX = 2.0;
const ZOOM_DEFAULT = 1.0;

export interface SettingsValues {
  zoom: number;
  reducedMotion: boolean;
  hideNpcs: boolean;
}

export interface SettingsCallbacks {
  onZoom(zoom: number): void;
  onReducedMotion(on: boolean): void;
  onHideNpcs(hidden: boolean): void;
  /** Re-arm + start the onboarding tour ("Show tour" link). */
  onShowTour(): void;
}

export interface SettingsHandle {
  /** Re-apply the persisted values to the game/body (call after each (re)boot
   *  since the game handle is recreated). Does NOT toggle the popover. */
  applyToGame(): void;
  /** Current persisted values (used to seed minimap/roster NPC filtering). */
  values(): SettingsValues;
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

  pop.append(heading, zoomField, motionField, npcField, tourRow);

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
    },
    values(): SettingsValues {
      return { ...state };
    },
    destroy(): void {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
      wrap.remove();
    },
  };
}
