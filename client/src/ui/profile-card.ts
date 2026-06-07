// ---------------------------------------------------------------------------
// Profile card. A small, dismissable card that shows a single player's identity
// and live presence: avatar color swatch, name (+"·bot" for NPCs), department
// chip, presence dot + label + source ("In Meeting · calendar"), current area,
// and a "👋 Wave" button that sends the WAVE emote FROM YOU (your own emote —
// kept enabled even when viewing an NPC, since waving is your action).
//
// Opens from the game's onAvatarClick (clicking an avatar in-scene) and from the
// roster row's ⓘ affordance. Pure display: reads a PlayerSnapshot + area string
// passed in, forwards the Wave intent through a callback. No business logic.
// ---------------------------------------------------------------------------

import {
  AVATAR_IDS,
  PRESENCE_META,
  areaAt,
  buildOfficeMap,
  type AvatarId,
  type PlayerSnapshot,
  type PresenceSource,
} from "@pixeloffice/shared";

const MAP = buildOfficeMap();

// Avatar swatch colors — mirror the in-game palette order (AVATAR_IDS) so the
// card's color swatch reads the same as the avatar on the map. These are gem
// tints matching the avatar id names; purely cosmetic + display-only.
const AVATAR_COLORS: Record<AvatarId, string> = {
  ruby: "#e5544b",
  sapphire: "#2e6fd8",
  emerald: "#3ecf6e",
  amber: "#e8a13c",
  violet: "#8a63e8",
  slate: "#7a8694",
};

function avatarColor(id: AvatarId): string {
  return AVATAR_COLORS[id] ?? AVATAR_COLORS[AVATAR_IDS[0]];
}

/** Human-friendly source label ("calendar", "manual", …) for transparency. */
const SOURCE_LABEL: Record<PresenceSource, string> = {
  MANUAL: "manual",
  CALENDAR: "calendar",
  EVENT: "event",
  AUTO: "auto",
  SYSTEM: "system",
};

export interface ProfileCardCallbacks {
  /** Send the WAVE emote from the local user (always YOUR avatar). */
  onWave(): void;
}

export interface ProfileCardHandle {
  /** Open (or re-target) the card for a player. Closes if player is undefined. */
  open(player: PlayerSnapshot | undefined): void;
  close(): void;
  destroy(): void;
}

export function mountProfileCard(parent: HTMLElement, cb: ProfileCardCallbacks): ProfileCardHandle {
  const card = document.createElement("div");
  card.className = "profile-card";
  card.hidden = true;
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Player profile");
  parent.appendChild(card);

  let open = false;

  function close(): void {
    open = false;
    card.hidden = true;
    card.innerHTML = "";
  }

  function render(player: PlayerSnapshot): void {
    card.innerHTML = "";

    // Header: avatar color swatch + name (+ bot tag).
    const head = document.createElement("div");
    head.className = "profile-head";

    const swatch = document.createElement("span");
    swatch.className = "profile-swatch";
    swatch.style.background = avatarColor(player.avatarId);

    const nameWrap = document.createElement("div");
    nameWrap.className = "profile-name-wrap";
    const nameEl = document.createElement("div");
    nameEl.className = "profile-name";
    nameEl.textContent = player.name;
    nameWrap.appendChild(nameEl);
    if (player.isNpc) {
      const bot = document.createElement("span");
      bot.className = "profile-bot";
      bot.textContent = "· bot";
      nameWrap.appendChild(bot);
    }

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "profile-close";
    closeBtn.setAttribute("aria-label", "Close profile");
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", close);

    head.append(swatch, nameWrap, closeBtn);

    // Department chip.
    const deptRow = document.createElement("div");
    deptRow.className = "profile-row";
    const chip = document.createElement("span");
    chip.className = "dept-chip";
    chip.dataset.dept = player.department;
    chip.textContent = player.department;
    deptRow.appendChild(chip);

    // Presence dot + label + source.
    const meta = PRESENCE_META[player.presence];
    const presRow = document.createElement("div");
    presRow.className = "profile-row profile-presence";
    const dot = document.createElement("span");
    dot.className = "presence-dot";
    dot.style.background = meta.color;
    const presLabel = document.createElement("span");
    presLabel.className = "profile-presence-label";
    presLabel.textContent = `${meta.label} · ${SOURCE_LABEL[player.source] ?? "system"}`;
    presRow.append(dot, presLabel);

    // Current area.
    const areaRow = document.createElement("div");
    areaRow.className = "profile-row profile-area";
    const areaIcon = document.createElement("span");
    areaIcon.className = "profile-area-icon";
    areaIcon.textContent = "📍";
    const areaLabel = document.createElement("span");
    areaLabel.textContent = areaAt(MAP, player.x, player.y)?.name ?? "Hallway";
    areaRow.append(areaIcon, areaLabel);

    // Wave button — always your own emote (enabled for NPCs too; it pops over
    // YOUR avatar, not theirs). Closes the card after sending.
    const waveBtn = document.createElement("button");
    waveBtn.type = "button";
    waveBtn.className = "profile-wave-btn";
    waveBtn.textContent = "👋 Wave";
    waveBtn.addEventListener("click", () => {
      cb.onWave();
      close();
    });

    card.append(head, deptRow, presRow, areaRow, waveBtn);
  }

  // Dismiss on outside click. Capture phase so it runs before the next open's
  // click handler; the avatar click that opened the card originates inside the
  // canvas (not inside the card), so we guard with the `open` flag + a
  // microtask-free check: ignore clicks that land within the card.
  const onDocClick = (e: MouseEvent): void => {
    if (!open) return;
    if (card.contains(e.target as Node)) return;
    close();
  };
  // Defer attaching until the opening click has fully propagated, so the very
  // click that requested open() does not immediately close it.
  const onKey = (e: KeyboardEvent): void => {
    if (open && e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);

  return {
    open(player: PlayerSnapshot | undefined): void {
      if (!player) {
        close();
        return;
      }
      render(player);
      card.hidden = false;
      if (!open) {
        open = true;
        // Attach the outside-click listener on the NEXT tick so the triggering
        // click (which may be a roster ⓘ or a canvas avatar click handled
        // elsewhere) does not bubble into an immediate close.
        setTimeout(() => {
          if (open) document.addEventListener("click", onDocClick, true);
        }, 0);
      }
    },
    close,
    destroy(): void {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onDocClick, true);
      card.remove();
    },
  };
}
