// ---------------------------------------------------------------------------
// Emote bar. Four small emoji buttons docked beside the chat input. Clicking a
// button (or pressing keys 1-4 — wired globally in main.ts so it can defer to
// chat-focus/modal state) sends C2S.EMOTE. We never echo locally: the game-side
// bubble appears when S2C.EMOTE comes back from the server (one code path for
// self + everyone). No business logic here — it just forwards an explicit user
// intent through a callback (human-agency rule).
// ---------------------------------------------------------------------------

import { EMOTES, EMOTE_EMOJI, type Emote } from "@pixeloffice/shared";

export interface EmoteBarCallbacks {
  /** Send the chosen emote to the server (C2S.EMOTE). */
  onEmote(emote: Emote): void;
}

export interface EmoteBarHandle {
  /** Trigger the emote at index (0..3) as if its button was clicked. Used by the
   *  global keys-1-4 handler in main.ts. No-op for an out-of-range index. */
  triggerIndex(index: number): void;
  destroy(): void;
}

/** Stable mapping of keys 1-4 → emote, shared with the global key handler. */
export function emoteForIndex(index: number): Emote | null {
  return EMOTES[index] ?? null;
}

export function mountEmoteBar(parent: HTMLElement, cb: EmoteBarCallbacks): EmoteBarHandle {
  const bar = document.createElement("div");
  bar.className = "emote-bar";

  const buttons: HTMLButtonElement[] = [];
  EMOTES.forEach((emote, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "emote-btn";
    btn.textContent = EMOTE_EMOJI[emote];
    btn.title = `${emote.replace("_", " ").toLowerCase()} (press ${i + 1})`;
    btn.setAttribute("aria-label", `Send ${emote} emote`);
    btn.addEventListener("click", () => fire(btn, emote));
    buttons.push(btn);
    bar.appendChild(btn);
  });

  function fire(btn: HTMLButtonElement, emote: Emote): void {
    cb.onEmote(emote);
    // Tiny press feedback (CSS handles the keyframe; reduced-motion disables it).
    btn.classList.remove("emote-pop");
    // Reflow so re-adding the class restarts the animation.
    void btn.offsetWidth;
    btn.classList.add("emote-pop");
  }

  parent.appendChild(bar);

  return {
    triggerIndex(index: number): void {
      const emote = emoteForIndex(index);
      const btn = buttons[index];
      if (emote && btn) fire(btn, emote);
    },
    destroy(): void {
      bar.remove();
    },
  };
}
