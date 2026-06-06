// ---------------------------------------------------------------------------
// Login card. Two paths, decided by the server's /api/auth/config:
//
//   1) OAuth (production): "Sign in with Google" / "Sign in with Microsoft"
//      buttons do a full-page redirect to /api/auth/:provider/login. The IdP
//      redirects back to the client app URL with #token=<jwt>. On load we detect
//      that fragment, store it in sessionStorage, strip it from the URL, then
//      fetch /api/auth/me to prefill name/email and auto-submit the join with
//      { token } in JoinOptions. When AUTH_REQUIRED is set, the dev form hides.
//
//   2) Dev (zero-config): when no providers are configured the card is the SAME
//      byte-for-byte dev sign-in as before (name / department / avatar). No
//      business logic lives here — it only collects a profile / token and hands
//      it back via onSubmit. The plan forbids username/password auth.
// ---------------------------------------------------------------------------

import {
  AVATAR_IDS,
  DEPARTMENTS,
  type AvatarId,
  type Department,
  type JoinOptions,
} from "@pixeloffice/shared";

const STORAGE_KEY = "pixeloffice.login";
const TOKEN_KEY = "pixeloffice.token";

/** Where to reach the auth REST API. Mirrors net/connection.ts derivation but
 *  kept local so login does not depend on the net layer. */
function serverHttpBase(): string {
  const host = location.hostname || "localhost";
  const proto = location.protocol === "https:" ? "https" : "http";
  // Default server port (shared DEFAULT_SERVER_PORT) — 2567.
  return `${proto}://${host}:2567`;
}

/** Palette colors for each avatar swatch (matches the in-game avatar tints). */
const AVATAR_COLORS: Record<AvatarId, string> = {
  ruby: "#c0392b",
  sapphire: "#2e6fd8",
  emerald: "#27ae60",
  amber: "#e67e22",
  violet: "#8e44ad",
  slate: "#7f8c8d",
};

interface SavedProfile {
  name: string;
  department: Department;
  avatarId: AvatarId;
}

/** What onSubmit hands back. `token` rides along in JoinOptions for OAuth joins;
 *  it is harmless extra data on the dev path (server ignores unknown fields). */
export type JoinSubmission = JoinOptions & { token?: string };

interface ProviderConfig {
  id: "google" | "microsoft";
  label: string;
}

interface AuthConfigResponse {
  providers: ProviderConfig[];
  authRequired: boolean;
  defaultDepartment?: string;
  departments?: string[];
}

function loadSaved(): Partial<SavedProfile> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<SavedProfile>) : {};
  } catch {
    return {};
  }
}

function save(profile: SavedProfile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    /* storage may be unavailable; profile persistence is best-effort */
  }
}

/** Read the stored OAuth token (used by main.ts to attach to subsequent joins). */
export function readStoredToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* best-effort */
  }
}

/** Detect a #token= or #error= fragment, store the token, and strip the URL. */
function consumeAuthFragment(): { token?: string; error?: string } {
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  if (!hash) return {};
  const params = new URLSearchParams(hash);
  const token = params.get("token") ?? undefined;
  const error = params.get("error") ?? undefined;
  if (token || error) {
    // Strip the fragment so the token never lingers in the address bar/history.
    history.replaceState(null, "", location.pathname + location.search);
  }
  if (token) storeToken(token);
  return { token: token ?? undefined, error: error ?? undefined };
}

async function fetchAuthConfig(): Promise<AuthConfigResponse | null> {
  try {
    const res = await fetch(`${serverHttpBase()}/api/auth/config`);
    if (!res.ok) return null;
    return (await res.json()) as AuthConfigResponse;
  } catch {
    return null;
  }
}

async function fetchMe(token: string): Promise<{ name?: string; email?: string } | null> {
  try {
    const res = await fetch(`${serverHttpBase()}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as { name?: string; email?: string };
  } catch {
    return null;
  }
}

export interface LoginHandle {
  hide(): void;
  show(): void;
  showError(message: string): void;
}

export interface LoginOptions {
  parent: HTMLElement;
  onSubmit(opts: JoinSubmission): void;
}

export function createLogin(opts: LoginOptions): LoginHandle {
  const saved = loadSaved();
  let selectedAvatar: AvatarId =
    saved.avatarId && AVATAR_IDS.includes(saved.avatarId) ? saved.avatarId : AVATAR_IDS[0];

  const root = opts.parent;
  root.innerHTML = "";

  const card = document.createElement("div");
  card.className = "login-card";

  const title = document.createElement("h1");
  title.className = "login-title";
  title.textContent = "PixelOffice";

  const subtitle = document.createElement("p");
  subtitle.className = "login-subtitle";
  subtitle.textContent = "Step into the office";

  // Name field
  const nameLabel = document.createElement("label");
  nameLabel.className = "login-label";
  nameLabel.textContent = "Display name";
  const nameInput = document.createElement("input");
  nameInput.className = "login-input";
  nameInput.type = "text";
  nameInput.maxLength = 24;
  nameInput.placeholder = "e.g. Aryan";
  nameInput.value = saved.name ?? "";
  nameLabel.appendChild(nameInput);

  // Department select
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
  if (saved.department && DEPARTMENTS.includes(saved.department)) {
    deptSelect.value = saved.department;
  }
  deptLabel.appendChild(deptSelect);

  // Avatar swatch picker
  const avatarLabel = document.createElement("span");
  avatarLabel.className = "login-label";
  avatarLabel.textContent = "Avatar";
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

  // Error line
  const errorLine = document.createElement("div");
  errorLine.className = "login-error";
  errorLine.hidden = true;

  // Submit button
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "login-submit";
  submit.textContent = "Enter Office";

  const footer = document.createElement("p");
  footer.className = "login-footer";
  footer.textContent = "Dev sign-in — Google/Microsoft OAuth in production";

  const form = document.createElement("form");
  form.className = "login-form";
  form.append(nameLabel, deptLabel, avatarLabel, swatches, errorLine, submit);

  // OAuth area (populated only when providers are configured). Sits above the
  // dev form. Reuses existing login-* classes so no styles.css change is needed.
  const oauthArea = document.createElement("div");
  oauthArea.className = "login-form";
  oauthArea.style.marginBottom = "8px";
  oauthArea.hidden = true;

  const divider = document.createElement("p");
  divider.className = "login-footer";
  divider.style.margin = "8px 0";
  divider.textContent = "— or continue as a guest —";
  divider.hidden = true;

  const setBusy = (busy: boolean) => {
    submit.disabled = busy;
    submit.textContent = busy ? "Connecting…" : "Enter Office";
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      errorLine.hidden = false;
      errorLine.textContent = "Please enter a display name.";
      nameInput.focus();
      return;
    }
    const department = deptSelect.value as Department;
    const profile: SavedProfile = { name, department, avatarId: selectedAvatar };
    save(profile);
    errorLine.hidden = true;
    setBusy(true);
    opts.onSubmit({ ...profile });
  });

  // The dev department picker also feeds the OAuth login (carried via state).
  const buildOAuthButton = (provider: ProviderConfig) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "login-submit";
    btn.style.background = provider.id === "google" ? "#4285f4" : "#2f2f2f";
    btn.style.color = "#fff";
    btn.textContent = `Sign in with ${provider.label}`;
    btn.addEventListener("click", () => {
      const dept = encodeURIComponent(deptSelect.value);
      // Full-page redirect to the server's OAuth entry point.
      location.assign(
        `${serverHttpBase()}/api/auth/${provider.id}/login?department=${dept}`,
      );
    });
    return btn;
  };

  card.append(title, subtitle, oauthArea, divider, form, footer);
  root.appendChild(card);

  // ------------------------------------------------------------------------
  // Async init: consume any returning #token, then load the provider config.
  // ------------------------------------------------------------------------
  const fragment = consumeAuthFragment();
  if (fragment.error) {
    errorLine.hidden = false;
    errorLine.textContent = `Sign-in failed: ${fragment.error}`;
  }

  void (async () => {
    // If we just came back from OAuth (or already have a token), auto-join.
    const token = fragment.token ?? readStoredToken();
    if (token) {
      setBusy(true);
      const me = await fetchMe(token);
      if (me) {
        const name = (me.name && me.name.trim()) || (me.email ?? "User");
        const department = (saved.department as Department) ?? DEPARTMENTS[0];
        opts.onSubmit({ name, department, avatarId: selectedAvatar, token });
        return; // main.ts will hide the card on a successful join
      }
      // Token was rejected (expired) — clear it and fall through to the form.
      try {
        sessionStorage.removeItem(TOKEN_KEY);
      } catch {
        /* ignore */
      }
      setBusy(false);
    }

    const config = await fetchAuthConfig();
    if (config && config.providers.length > 0) {
      for (const p of config.providers) oauthArea.appendChild(buildOAuthButton(p));
      oauthArea.hidden = false;
      footer.textContent = "Sign in with your work account";
      if (config.authRequired) {
        // Lock down: OAuth only. Hide the dev guest form entirely.
        form.hidden = true;
        divider.hidden = true;
      } else {
        divider.hidden = false;
        nameInput.focus();
      }
    } else {
      // Zero-config dev path: identical to the original dev card.
      nameInput.focus();
    }
  })();

  return {
    hide() {
      root.style.display = "none";
    },
    show() {
      root.style.display = "";
      setBusy(false);
    },
    showError(message: string) {
      errorLine.hidden = false;
      errorLine.textContent = message;
      setBusy(false);
    },
  };
}
