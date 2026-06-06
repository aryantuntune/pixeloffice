// Profile modal (opened by double-clicking your own avatar): edit display name,
// department, and avatar. Returns the edit via onSave/onLogout; no logic here.

import { AVATAR_IDS, DEPARTMENTS, type AvatarId, type Department } from "@pixeloffice/shared";

/** Avatar swatch colors — must match the in-game avatar tints (login.ts/scene). */
const AVATAR_COLORS: Record<AvatarId, string> = {
  ruby: "#c0392b",
  sapphire: "#2e6fd8",
  emerald: "#27ae60",
  amber: "#e67e22",
  violet: "#8e44ad",
  slate: "#7f8c8d",
};

export interface ProfileDraft {
  name: string;
  department: Department;
  avatarId: AvatarId;
}

export interface ProfileModalOptions {
  parent: HTMLElement;
  current: ProfileDraft;
  onSave(profile: ProfileDraft): void;
  /** Log out: end the greytHR session and return to the sign-in screen. */
  onLogout?(): void;
}

/** Open the profile modal. Single-instance: a second call is a no-op while open. */
export function openProfileModal(opts: ProfileModalOptions): void {
  if (opts.parent.querySelector(".profile-overlay")) return; // already open

  let selectedAvatar: AvatarId = AVATAR_IDS.includes(opts.current.avatarId)
    ? opts.current.avatarId
    : AVATAR_IDS[0];

  // --- overlay + card (inline styles so no styles.css change is required) ---
  const overlay = document.createElement("div");
  overlay.className = "profile-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(8,11,16,0.62)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: "1000",
  } satisfies Partial<CSSStyleDeclaration>);

  const card = document.createElement("div");
  card.className = "login-card";
  card.style.maxWidth = "340px";
  card.style.width = "calc(100% - 32px)";

  const title = document.createElement("h1");
  title.className = "login-title";
  title.style.fontSize = "20px";
  title.textContent = "Edit profile";

  const subtitle = document.createElement("p");
  subtitle.className = "login-subtitle";
  subtitle.textContent = "Update your name, department, and avatar";

  // Name
  const nameLabel = document.createElement("label");
  nameLabel.className = "login-label";
  nameLabel.textContent = "Display name";
  const nameInput = document.createElement("input");
  nameInput.className = "login-input";
  nameInput.type = "text";
  nameInput.maxLength = 24;
  nameInput.value = opts.current.name;
  nameLabel.appendChild(nameInput);

  // Department (dropdown — fixes a greytHR mismatch)
  const deptLabel = document.createElement("label");
  deptLabel.className = "login-label";
  deptLabel.textContent = "Department";
  const deptSelect = document.createElement("select");
  deptSelect.className = "login-select";
  for (const d of DEPARTMENTS) {
    const o = document.createElement("option");
    o.value = d;
    o.textContent = d;
    deptSelect.appendChild(o);
  }
  deptSelect.value = DEPARTMENTS.includes(opts.current.department)
    ? opts.current.department
    : DEPARTMENTS[0];
  deptLabel.appendChild(deptSelect);

  // Avatar (color & style)
  const avatarLabel = document.createElement("span");
  avatarLabel.className = "login-label";
  avatarLabel.textContent = "Avatar color & style";
  const swatches = document.createElement("div");
  swatches.className = "login-swatches";
  const swatchEls = new Map<AvatarId, HTMLButtonElement>();
  const syncSwatches = () => {
    for (const [id, el] of swatchEls) {
      el.classList.toggle("selected", id === selectedAvatar);
      el.setAttribute("aria-pressed", id === selectedAvatar ? "true" : "false");
    }
  };
  for (const id of AVATAR_IDS) {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "login-swatch";
    sw.style.background = AVATAR_COLORS[id];
    sw.title = id;
    sw.setAttribute("aria-label", id);
    sw.addEventListener("click", () => {
      selectedAvatar = id;
      syncSwatches();
    });
    swatchEls.set(id, sw);
    swatches.appendChild(sw);
  }
  syncSwatches();

  // Actions
  const actions = document.createElement("div");
  Object.assign(actions.style, { display: "flex", gap: "8px", marginTop: "12px" });

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "login-submit";
  cancel.style.background = "#39424f";
  cancel.textContent = "Cancel";

  const save = document.createElement("button");
  save.type = "submit";
  save.className = "login-submit";
  save.style.flex = "1";
  save.textContent = "Save";

  actions.append(cancel, save);

  // Log out — ends your greytHR session (server-side) and returns to sign-in.
  const logout = document.createElement("button");
  logout.type = "button";
  logout.className = "login-submit";
  logout.style.background = "#7a2f2f";
  logout.style.marginTop = "4px";
  logout.textContent = "Log out";
  logout.addEventListener("click", () => {
    close();
    opts.onLogout?.();
  });

  const form = document.createElement("form");
  form.className = "login-form";
  form.append(nameLabel, deptLabel, avatarLabel, swatches, actions, logout);

  card.append(title, subtitle, form);
  overlay.appendChild(card);
  opts.parent.appendChild(overlay);
  nameInput.focus();
  nameInput.select();

  // --- lifecycle ---
  const close = () => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close(); // click backdrop to dismiss
  });
  cancel.addEventListener("click", close);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = nameInput.value.trim().slice(0, 24) || opts.current.name;
    opts.onSave({
      name,
      department: deptSelect.value as Department,
      avatarId: selectedAvatar,
    });
    close();
  });
}
