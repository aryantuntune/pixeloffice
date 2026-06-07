// ---------------------------------------------------------------------------
// First-join onboarding tour. Three sequential tooltip callouts anchored to:
//   1. the canvas centre — "Walk with WASD / arrows" (auto-advances on the
//      user's first movement, so the hint proves itself)
//   2. the status pill — "Set your status here"
//   3. the events panel — "Join what's happening"
// Each has Next / Skip. Gated by a localStorage flag so it only shows on the
// first ever join; re-armable from Settings ("Show tour again"). Pure UI: it
// observes a movement signal (notifyMoved) and renders hints — no game logic.
// ---------------------------------------------------------------------------

const SEEN_KEY = "pixeloffice.onboarding.seen";

type Anchor = "canvas" | ".hud-status-pill" | ".hud-events";

interface Step {
  anchor: Anchor;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    anchor: "canvas",
    title: "Move around",
    body: "Walk with WASD or the arrow keys. Try it now — give it a step!",
  },
  {
    anchor: ".hud-status-pill",
    title: "Your status",
    body: "Set Available, Focus, Break or Away here. Meetings update it for you.",
  },
  {
    anchor: ".hud-events",
    title: "Happening now",
    body: "Coffee breaks and gatherings show up here. Click Join to walk over.",
  },
];

function hasSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}
function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* private mode */
  }
}

export interface OnboardingHandle {
  /** Signal that the local avatar moved — auto-advances step 1. Safe to call
   *  every move; only acts while the tour is on its first step. */
  notifyMoved(): void;
  /** Force-start the tour (Settings "Show tour again"), ignoring the seen flag. */
  start(): void;
  destroy(): void;
}

export function mountOnboarding(parent: HTMLElement): OnboardingHandle {
  const overlay = document.createElement("div");
  overlay.className = "onboard-overlay";
  overlay.hidden = true;

  const callout = document.createElement("div");
  callout.className = "onboard-callout";

  const titleEl = document.createElement("div");
  titleEl.className = "onboard-title";
  const bodyEl = document.createElement("div");
  bodyEl.className = "onboard-body";
  const footer = document.createElement("div");
  footer.className = "onboard-footer";
  const stepDots = document.createElement("div");
  stepDots.className = "onboard-dots";
  const btns = document.createElement("div");
  btns.className = "onboard-btns";
  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.className = "onboard-skip";
  skipBtn.textContent = "Skip";
  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "onboard-next";
  btns.append(skipBtn, nextBtn);
  footer.append(stepDots, btns);
  callout.append(titleEl, bodyEl, footer);
  overlay.appendChild(callout);
  parent.appendChild(overlay);

  let active = false;
  let stepIndex = 0;

  function anchorRect(anchor: Anchor): DOMRect | null {
    if (anchor === "canvas") {
      // Centre on the game canvas if present, else the viewport.
      const canvas = document.querySelector<HTMLCanvasElement>("#game-root canvas");
      if (canvas) return canvas.getBoundingClientRect();
      return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    }
    const el = document.querySelector<HTMLElement>(anchor);
    return el ? el.getBoundingClientRect() : null;
  }

  function positionCallout(step: Step): void {
    const rect = anchorRect(step.anchor);
    const cw = callout.offsetWidth || 260;
    const ch = callout.offsetHeight || 120;
    const margin = 14;
    let left: number;
    let top: number;
    callout.classList.remove("arrow-up", "arrow-right");

    if (!rect || step.anchor === "canvas") {
      // Centre of the screen.
      left = window.innerWidth / 2 - cw / 2;
      top = window.innerHeight / 2 - ch / 2;
    } else if (step.anchor === ".hud-status-pill") {
      // Below the pill, right-aligned to it.
      left = rect.right - cw;
      top = rect.bottom + margin;
      callout.classList.add("arrow-up");
    } else {
      // Events panel: to the LEFT of the panel.
      left = rect.left - cw - margin;
      top = rect.top;
      callout.classList.add("arrow-right");
    }

    // Clamp into the viewport.
    left = Math.max(margin, Math.min(left, window.innerWidth - cw - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - ch - margin));
    callout.style.left = `${left}px`;
    callout.style.top = `${top}px`;
  }

  function renderStep(): void {
    const step = STEPS[stepIndex];
    titleEl.textContent = step.title;
    bodyEl.textContent = step.body;
    nextBtn.textContent = stepIndex === STEPS.length - 1 ? "Done" : "Next";
    stepDots.innerHTML = "";
    STEPS.forEach((_, i) => {
      const d = document.createElement("span");
      d.className = "onboard-dot" + (i === stepIndex ? " on" : "");
      stepDots.appendChild(d);
    });
    // Position after layout so offsetWidth/Height are accurate.
    requestAnimationFrame(() => positionCallout(step));
  }

  function finish(): void {
    active = false;
    overlay.hidden = true;
    markSeen();
    window.removeEventListener("resize", onResize);
  }

  function advance(): void {
    if (stepIndex >= STEPS.length - 1) {
      finish();
      return;
    }
    stepIndex += 1;
    renderStep();
  }

  const onResize = (): void => {
    if (active) positionCallout(STEPS[stepIndex]);
  };

  nextBtn.addEventListener("click", advance);
  skipBtn.addEventListener("click", finish);

  function begin(): void {
    active = true;
    stepIndex = 0;
    overlay.hidden = false;
    window.addEventListener("resize", onResize);
    renderStep();
  }

  // Auto-start on first ever join (deferred so the HUD anchors exist).
  if (!hasSeen()) {
    setTimeout(begin, 600);
  }

  return {
    notifyMoved(): void {
      if (active && stepIndex === 0) advance();
    },
    start(): void {
      begin();
    },
    destroy(): void {
      window.removeEventListener("resize", onResize);
      overlay.remove();
    },
  };
}
