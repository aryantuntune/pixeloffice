// ---------------------------------------------------------------------------
// Admin console modal. Plain `fetch` to the server REST API (CORS-enabled).
// Tabs: Events, Meetings, Broadcast, Users. No client-side business logic — it
// posts intents and renders responses. Admin auth/RBAC arrives with OAuth in
// production (the plan's security section); this dev console is unauthenticated.
// ---------------------------------------------------------------------------

import {
  SOCIAL_EVENT_TYPES,
  buildOfficeMap,
  type SocialEventType,
} from "@pixeloffice/shared";
import { serverHttpBase } from "../net/connection";
import { readStoredToken } from "./login";
import { readHideNpcs } from "./settings";

/** Attach the OAuth bearer token when one exists so admin writes work under
 *  AUTH_REQUIRED. On the dev path no token exists and the header is omitted. */
function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  const token = readStoredToken();
  return token ? { ...base, Authorization: `Bearer ${token}` } : { ...base };
}

/** Friendly labels for the social event type select. */
const EVENT_TYPE_LABELS: Record<SocialEventType, string> = {
  COFFEE_BREAK: "Coffee Break",
  TEA_BREAK: "Tea Break",
  TEAM_GATHERING: "Team Gathering",
  TOWN_HALL: "Town Hall",
};
const MEETING_ROOMS = buildOfficeMap()
  .areas.filter((area) => area.type === "MEETING_ROOM")
  .map((area) => area.name);

type TabId = "events" | "meetings" | "broadcast" | "users";

interface UserRow {
  userId?: string;
  name?: string;
  department?: string;
  presence?: string;
  area?: string;
  isNpc?: boolean;
}

function api(path: string): string {
  return `${serverHttpBase()}${path}`;
}

/** Fetch the connected players, surfacing the server's error message on failure. */
async function fetchUsers(): Promise<{ ok: true; users: UserRow[] } | { ok: false; error: string }> {
  try {
    const res = await fetch(api("/api/users"), { headers: authHeaders() });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: body?.error || `Could not load users (${res.status}).` };
    }
    const data = (await res.json()) as { users?: UserRow[] };
    return { ok: true, users: Array.isArray(data.users) ? data.users : [] };
  } catch (err) {
    return { ok: false, error: `Network error: ${(err as Error).message}` };
  }
}

export function createAdmin(parent: HTMLElement): void {
  // Trigger button (bottom-right).
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "admin-trigger";
  // Distinct glyph from the personal-settings gear (⚙) so a newcomer doesn't read
  // the two as the same control; admin tooling is a separate, labeled affordance.
  trigger.textContent = "🛠 Admin";
  parent.appendChild(trigger);

  // Backdrop + modal.
  const backdrop = document.createElement("div");
  backdrop.className = "admin-backdrop";
  backdrop.hidden = true;

  const modal = document.createElement("div");
  modal.className = "admin-modal";

  const header = document.createElement("div");
  header.className = "admin-header";
  const heading = document.createElement("h2");
  heading.textContent = "Admin Console";
  const note = document.createElement("span");
  note.className = "admin-note";
  note.textContent = "Dev console — auth/RBAC arrives with OAuth in production";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "admin-close";
  closeBtn.textContent = "✕";
  header.append(heading, note, closeBtn);

  const tabBar = document.createElement("div");
  tabBar.className = "admin-tabs";
  const panel = document.createElement("div");
  panel.className = "admin-panel";

  modal.append(header, tabBar, panel);
  backdrop.appendChild(modal);
  parent.appendChild(backdrop);

  const open = () => {
    backdrop.hidden = false;
    showTab("events");
  };
  const close = () => {
    backdrop.hidden = true;
  };
  trigger.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  const tabs: { id: TabId; label: string }[] = [
    { id: "events", label: "Events" },
    { id: "meetings", label: "Meetings" },
    { id: "broadcast", label: "Broadcast" },
    { id: "users", label: "Users" },
  ];
  const tabButtons = new Map<TabId, HTMLButtonElement>();
  for (const t of tabs) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "admin-tab";
    b.textContent = t.label;
    b.addEventListener("click", () => showTab(t.id));
    tabButtons.set(t.id, b);
    tabBar.appendChild(b);
  }

  function showTab(id: TabId): void {
    for (const [tid, b] of tabButtons) b.classList.toggle("active", tid === id);
    panel.innerHTML = "";
    if (id === "events") panel.appendChild(buildEventsTab());
    else if (id === "meetings") panel.appendChild(buildMeetingsTab());
    else if (id === "broadcast") panel.appendChild(buildBroadcastTab());
    else panel.appendChild(buildUsersTab());
  }

  // --- shared form helpers ---

  function field(labelText: string, control: HTMLElement): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "admin-field";
    const span = document.createElement("span");
    span.textContent = labelText;
    wrap.append(span, control);
    return wrap;
  }

  function statusLine(): HTMLElement {
    const el = document.createElement("div");
    el.className = "admin-status";
    return el;
  }

  async function post(path: string, body: unknown, status: HTMLElement, okMsg: string): Promise<void> {
    status.className = "admin-status";
    status.textContent = "Sending…";
    try {
      const res = await fetch(api(path), {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let msg = text;
        try {
          msg = (JSON.parse(text) as { error?: string }).error || text;
        } catch {
          /* not JSON — show the raw text */
        }
        status.className = "admin-status error";
        status.textContent = msg || `Request failed (${res.status}).`;
        return;
      }
      status.className = "admin-status ok";
      status.textContent = okMsg;
    } catch (err) {
      status.className = "admin-status error";
      status.textContent = `Network error: ${(err as Error).message}`;
    }
  }

  // --- Events tab ---

  function buildEventsTab(): HTMLElement {
    const form = document.createElement("form");
    form.className = "admin-form";

    const typeSel = document.createElement("select");
    for (const t of SOCIAL_EVENT_TYPES) {
      const o = document.createElement("option");
      o.value = t;
      o.textContent = EVENT_TYPE_LABELS[t];
      typeSel.appendChild(o);
    }

    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.placeholder = "Event title";
    titleInput.maxLength = 60;

    const durationInput = document.createElement("input");
    durationInput.type = "number";
    durationInput.min = "1";
    durationInput.value = "15";

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "admin-submit";
    submit.textContent = "Create event";

    const status = statusLine();

    form.append(
      field("Type", typeSel),
      field("Title", titleInput),
      field("Duration (minutes)", durationInput),
      submit,
      status,
    );

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const durationMinutes = Number(durationInput.value);
      void post(
        "/api/events",
        {
          type: typeSel.value,
          title: titleInput.value.trim() || EVENT_TYPE_LABELS[typeSel.value as SocialEventType],
          durationMinutes,
        },
        status,
        "Event created.",
      );
    });

    return form;
  }

  // --- Meetings tab ---

  function buildMeetingsTab(): HTMLElement {
    const form = document.createElement("form");
    form.className = "admin-form";

    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.placeholder = "Meeting title";
    titleInput.maxLength = 60;

    const startsInput = document.createElement("input");
    startsInput.type = "number";
    startsInput.min = "0";
    startsInput.value = "1";

    const durationInput = document.createElement("input");
    durationInput.type = "number";
    durationInput.min = "1";
    durationInput.value = "30";

    const roomSel = document.createElement("select");
    for (const room of MEETING_ROOMS) {
      const o = document.createElement("option");
      o.value = room;
      o.textContent = room;
      roomSel.appendChild(o);
    }
    roomSel.value = "Meeting Room C";

    const allCheck = document.createElement("input");
    allCheck.type = "checkbox";
    allCheck.checked = true;
    const allLabel = document.createElement("label");
    allLabel.className = "admin-check";
    allLabel.append(allCheck, document.createTextNode(" Invite all participants"));

    // Individual-invitee picker (shown only when "Invite all" is unchecked).
    const picker = document.createElement("div");
    picker.className = "admin-participants";
    picker.hidden = true;

    const pickerBar = document.createElement("div");
    pickerBar.className = "admin-users-bar";
    const pickerTitle = document.createElement("span");
    pickerTitle.textContent = "Invite who's online:";
    const pickerRefresh = document.createElement("button");
    pickerRefresh.type = "button";
    pickerRefresh.className = "admin-refresh";
    pickerRefresh.textContent = "Refresh";
    pickerBar.append(pickerTitle, pickerRefresh);

    const pickerStatus = statusLine();
    const pickerList = document.createElement("div");
    pickerList.className = "admin-participants-list";
    picker.append(pickerBar, pickerStatus, pickerList);

    const selected = new Set<string>();
    let loaded = false;

    async function loadParticipants(): Promise<void> {
      pickerStatus.className = "admin-status";
      pickerStatus.textContent = "Loading\u2026";
      pickerList.innerHTML = "";
      const result = await fetchUsers();
      if (!result.ok) {
        pickerStatus.className = "admin-status error";
        pickerStatus.textContent = result.error;
        return;
      }
      loaded = true;
      const humans = result.users.filter((u) => !u.isNpc && u.userId);
      if (humans.length === 0) {
        pickerStatus.textContent = "No one is online right now.";
        return;
      }
      pickerStatus.textContent = "";
      for (const u of humans) {
        const id = u.userId as string;
        const row = document.createElement("label");
        row.className = "admin-check";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = selected.has(id);
        cb.addEventListener("change", () => {
          if (cb.checked) selected.add(id);
          else selected.delete(id);
        });
        const avail = (u.presence ?? "").toUpperCase() === "AVAILABLE";
        row.append(
          cb,
          document.createTextNode(
            ` ${u.name ?? "Unknown"} \u00b7 ${u.department ?? "\u2014"} \u00b7 ${avail ? "available" : (u.presence ?? "").toLowerCase() || "online"}`,
          ),
        );
        pickerList.appendChild(row);
      }
    }

    allCheck.addEventListener("change", () => {
      picker.hidden = allCheck.checked;
      if (!allCheck.checked && !loaded) void loadParticipants();
    });
    pickerRefresh.addEventListener("click", () => void loadParticipants());

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "admin-submit";
    submit.textContent = "Schedule meeting";

    const status = statusLine();

    form.append(
      field("Title", titleInput),
      field("Starts in (minutes)", startsInput),
      field("Duration (minutes)", durationInput),
      field("Meeting room", roomSel),
      allLabel,
      picker,
      submit,
      status,
    );

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      // Empty participants = everyone (server contract); otherwise the selected ids.
      const participantIds = allCheck.checked ? [] : [...selected];
      if (!allCheck.checked && participantIds.length === 0) {
        status.className = "admin-status error";
        status.textContent = "Pick at least one person, or check “Invite all participants”.";
        return;
      }
      const body = {
        title: titleInput.value.trim() || "Team Meeting",
        startsInMinutes: Number(startsInput.value),
        durationMinutes: Number(durationInput.value),
        roomName: roomSel.value,
        participantIds,
      };
      void post("/api/meetings", body, status, "Meeting scheduled.");
    });

    return form;
  }

  // --- Broadcast tab ---

  function buildBroadcastTab(): HTMLElement {
    const form = document.createElement("form");
    form.className = "admin-form";

    const msgInput = document.createElement("textarea");
    msgInput.placeholder = "Announcement to everyone in the office";
    msgInput.maxLength = 200;
    msgInput.rows = 3;

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "admin-submit";
    submit.textContent = "Send broadcast";

    const status = statusLine();

    form.append(field("Message", msgInput), submit, status);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const message = msgInput.value.trim();
      if (!message) {
        status.className = "admin-status error";
        status.textContent = "Message cannot be empty.";
        return;
      }
      void post("/api/broadcast", { message }, status, "Broadcast sent.");
    });

    return form;
  }

  // --- Users tab ---

  function buildUsersTab(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "admin-users";

    const bar = document.createElement("div");
    bar.className = "admin-users-bar";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "admin-refresh";
    refresh.textContent = "Refresh";
    bar.appendChild(refresh);

    const status = statusLine();
    const tableWrap = document.createElement("div");
    tableWrap.className = "admin-users-table";

    wrap.append(bar, status, tableWrap);

    async function load(): Promise<void> {
      status.className = "admin-status";
      status.textContent = "Loading…";
      tableWrap.innerHTML = "";
      const result = await fetchUsers();
      if (!result.ok) {
        status.className = "admin-status error";
        status.textContent = result.error;
        return;
      }
      status.textContent = "";
      const rows = result.users;
      renderTable(readHideNpcs() ? rows.filter((r) => !r.isNpc) : rows);
    }

    function renderTable(rows: UserRow[]): void {
      tableWrap.innerHTML = "";
      if (rows.length === 0) {
        const empty = document.createElement("div");
        empty.className = "hud-empty";
        empty.textContent = "No active users.";
        tableWrap.appendChild(empty);
        return;
      }
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      thead.innerHTML =
        "<tr><th>Name</th><th>Department</th><th>Presence</th><th>Area</th></tr>";
      const tbody = document.createElement("tbody");
      for (const r of rows) {
        const tr = document.createElement("tr");
        for (const v of [r.name, r.department, r.presence, r.area]) {
          const td = document.createElement("td");
          td.textContent = v ?? "—";
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.append(thead, tbody);
      tableWrap.appendChild(table);
    }

    refresh.addEventListener("click", () => void load());
    void load();
    return wrap;
  }
}
