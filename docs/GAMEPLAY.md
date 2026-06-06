# PixelOffice — Player Guide

Open the office, pick a name, and you're at your desk. Here's everything you can do.

![The office](screenshots/office.png)

## Getting in

1. Open the office URL (locally: `http://localhost:5173`).
2. Pick a **display name**, your **department** (Engineering / Product / Design / HR), and an
   **avatar color**.
3. **Enter Office** — you spawn at a free desk in your department's zone.

> **Signing in with greytHR.** When greytHR sign-in is enabled, the screen instead asks only
> for your **Employee No / Login ID** and **password** (the company subdomain is filled in
> for you), plus an avatar. Your **name and department come straight from greytHR** — there
> is no name field, no department picker, and no guest option. Wrong department? Fix it from
> your profile (below).
>
> With Google/Microsoft OAuth configured you'll see "Sign in with Google / Microsoft"
> instead — same flow, real identity.

## Editing your profile 🎨

**Double-click your own avatar** to open the profile editor. You can change your:

- **Display name**
- **Department** — a simple dropdown (use this if greytHR put you in the wrong one)
- **Avatar color & style** — the six color options

Save and everyone sees the change instantly; it sticks across reconnects and future
sessions. Editing your profile never moves your avatar.

## Moving around

| Input | Action |
|---|---|
| **Arrow keys / WASD** | Walk, Pokémon-style, one tile at a time |
| Tap a direction | Turn in place without stepping |

The top bar always shows which area you're standing in: your department, a Meeting Room,
the Coffee Area, the Lounge, Reception, or a Hallway.

## Presence — who's around, who's busy

Everyone has a live status, shown as a colored dot + badge above their avatar and grouped
in the **Team** roster on the right:

| Status | How it happens |
|---|---|
| 🟢 **Available** | Default |
| 🔴 **In Meeting** 📅 | A calendar meeting you're in is running (automatic, highest priority) |
| 🟣 **Focus** 🎧 | You picked it from the status pill |
| 🟠 **Break** ☕ | You joined a coffee break/event, or picked it manually |
| ⚪ **Away** 💤 | You picked it, or you've been idle ~90 s (any input brings you back) |

Set your status from the **pill in the top-right**. Picking *Available* clears any manual
override. The roster shows everyone's department and current location in the office.

> Dimmed rows in the roster are **NPCs** — ambient virtual coworkers who wander, sip
> coffee, and keep the office alive. They never attend your meetings and never answer you.

## Chat

Type in the **bottom-left input**, press **Enter** — your message appears as a speech
bubble over your avatar for everyone nearby to see. Control returns to your avatar
immediately. **Esc** leaves the input without sending.

## Meetings 📅

![Coffee break in progress](screenshots/coffee-break.png)

1. Someone schedules a meeting (Admin → Meetings, or a calendar integration).
2. When it starts, every participant's status flips to **In Meeting** and a pulsing
   **"📅 Join"** button appears in their top bar.
3. **You click Join** — only then is your avatar seated in the assigned meeting room
   (A/B/C by size). The office never moves you on its own; that's a core rule.
4. Click again to **Leave** and walk back. When the meeting's window ends, statuses
   reset automatically.

## Coffee breaks & social events ☕🎉

Anyone with the Admin console can start a **Coffee Break**, **Tea Break**,
**Team Gathering**, or **Town Hall**. Everyone gets a toast, and the event appears in the
**"Happening now"** panel with a countdown and participant count.

Hit **Join** to appear in the venue (Coffee Area, Lounge, or Reception) with a ☕ Break
status. **Leave** whenever you like — or it ends when the timer runs out. A couple of NPCs
usually drift over too.

## Lounge games 🎮

The **Lounge** has three two-player mini-games for a quick break: **Ping-Pong**,
**Tic-Tac-Toe**, and **Connect Four**.

- Walk up to a game station (e.g. the ping-pong table) and press **E** to join.
- The first player **waits**; the game starts when a second player joins the same station.
- A game window opens — make your moves; the winner and score show at the end.
- Close the window or press **Esc** to leave (your seat frees up for someone else).

Games are just for fun: joining never moves your avatar elsewhere, and play never affects
your presence, attendance, or any metric.

## Attendance (greytHR) 🕘

The **bottom-left widget** is your attendance card:

- **Check in / Check out** — explicit clicks, recorded through the GreytHR adapter
  (your company's real greytHR when credentials are configured, a mock in dev).
- Shows your recorded times — *"Checked in at 9:42 AM"*.
- **Open greytHR ↗** jumps to your ESS portal.

The office **never** checks you in or out automatically — attendance is always your action.

## Admin console ⚙

Bottom-right **Admin** button:

| Tab | Does |
|---|---|
| **Events** | Start a coffee break / gathering / town hall with a duration |
| **Meetings** | Schedule a meeting (starts in N minutes, duration, everyone or selected) |
| **Broadcast** | Send an announcement toast to the whole office |
| **Users** | Live table: who's online, status, department, location |

With `AUTH_REQUIRED=true`, these need an admin account (`ADMIN_EMAILS`).

## Resilience

If the server restarts you'll see a **"Reconnecting…"** banner — your client re-joins
automatically with your identity and you reappear at your spot. No refresh needed.

## What PixelOffice will never do

No keystroke logging, no mouse tracking, no screenshots, no productivity scores, no
activity ranking. The only signals are the ones you can see on screen yourself: your
status, your location in the office, and what you explicitly share. Presence, not
surveillance — it's in the [constitution](../plan.md).
