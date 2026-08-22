// ---------------------------------------------------------------------------
// Admin REST API (mounted at /api). Plain Express router.
//
// PRODUCTION NOTE: per plan.md (Security), these endpoints MUST be protected by
// OAuth-backed JWT authentication + role-based access control (RBAC) before
// shipping. V1 is open for local development only. Keep that gate HERE — the
// services below stay framework- and auth-agnostic.
// ---------------------------------------------------------------------------

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import {
  S2C,
  areaAt,
  buildOfficeMap,
  floorById,
  type Floor,
  type SocialEventType,
  type ToastPayload,
} from "@pixeloffice/shared";
import { container } from "../container";
import { isSocialEventType } from "../events/event.service";
import { bearerToken, createAdminGuard, requireAuth, sessionOf } from "../auth/middleware";
import { createLogger } from "../logging/logger";

const log = createLogger("admin");

const MAX_BROADCAST = 500;
const DEFAULT_EVENT_MINUTES = 15;
const DEFAULT_MEETING_DURATION = 30;
const DEFAULT_MEETING_START = 0;

/** Human-readable default titles per social event type. */
const EVENT_TITLES: Record<SocialEventType, string> = {
  COFFEE_BREAK: "Coffee Break",
  TEA_BREAK: "Tea Break",
  TEAM_GATHERING: "Team Gathering",
  TOWN_HALL: "Town Hall",
};

export function createAdminRouter(): Router {
  const router = Router();
  const map = buildOfficeMap();

  // Admin-only gate. NO-OP when AUTH_REQUIRED is unset (dev console stays open);
  // becomes requireRole('admin') (401 then 403) when AUTH_REQUIRED=true. The
  // policy lives in one place — the services below stay auth-agnostic.
  const guard = createAdminGuard(
    container.authConfig.jwt,
    container.authConfig.authRequired,
  );
  const memberGuard = createMeetingGuard();

  // GET /api/health -------------------------------------------------------
  // Always open: container/load-balancer probes must never require a token.
  router.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // GET /api/users — connected players with presence + current area --------
  router.get("/users", guard, (_req: Request, res: Response) => {
    const room = container.registry.room;
    if (!room) {
      res.json({ users: [] });
      return;
    }
    // Resolve each player's area against THEIR OWN floor map — not a single
    // hard-coded floor. A player at (24,19) on the ground floor and one at
    // (24,19) on Floor 2 sit in different rooms; using one map for everyone
    // mislabels every off-floor player and all ground-floor NPCs. The active
    // building owns every floor's geometry (the room joined the same building).
    const building = container.maps.getActiveBuilding();
    // The default floor id the room uses when a snapshot omits floorId.
    const defaultFloorId = building.floors[0]?.id ?? "ground";
    const floorCache = new Map<string, Floor | null>();
    const resolveFloor = (id: string): Floor | null => {
      const cached = floorCache.get(id);
      if (cached !== undefined) return cached;
      const floor = floorById(building, id);
      floorCache.set(id, floor);
      return floor;
    };

    const users = room.listPlayers().map((p) => {
      const floorId = p.floorId ?? defaultFloorId;
      // A Floor IS an OfficeMap, so areaAt works on it directly. Fall back to
      // the legacy single map only if the floor cannot be resolved.
      const floor = resolveFloor(floorId);
      const area = areaAt(floor ?? map, p.x, p.y);
      return {
        sessionId: p.sessionId,
        userId: p.userId,
        name: p.name,
        department: p.department,
        avatarId: p.avatarId,
        x: p.x,
        y: p.y,
        presence: p.presence,
        source: p.source,
        area: area ? area.name : "Hallway",
        // Per-player floor so an admin can disambiguate same-coordinate players
        // on different floors. Additive fields (backward-compatible).
        floorId,
        floor: floor ? floor.name : floorId,
        // Surface ambient NPCs so admin tooling can distinguish them from real
        // users. Omitted (not false) for humans to keep the shape minimal and
        // backward-compatible.
        ...(p.isNpc ? { isNpc: true } : {}),
      };
    });
    res.json({ users });
  });

  // POST /api/events { type, title?, durationMinutes? } --------------------
  router.post("/events", guard, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const type = body.type;
    if (!isSocialEventType(type)) {
      res.status(400).json({ error: "Invalid or missing event type" });
      return;
    }
    const title =
      typeof body.title === "string" && body.title.trim().length > 0
        ? body.title.trim()
        : EVENT_TITLES[type];
    const durationMinutes = positiveNumber(body.durationMinutes, DEFAULT_EVENT_MINUTES);

    // The room's "created" listener handles broadcasting + the toast.
    const event = container.events.createEvent(type, title, durationMinutes, Date.now());
    res.status(201).json({ event });
  });

  // POST /api/broadcast { message } ---------------------------------------
  router.post("/broadcast", guard, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (message.length === 0) {
      res.status(400).json({ error: "message is required" });
      return;
    }
    // Cap length before fanning out to every client (amplification guard).
    if (message.length > MAX_BROADCAST) {
      res.status(400).json({ error: "message too long" });
      return;
    }
    const room = container.registry.room;
    if (!room) {
      res.status(503).json({ error: "No active room" });
      return;
    }
    const toast: ToastPayload = { message, kind: "broadcast" };
    room.broadcast(S2C.TOAST, toast);
    log.info("broadcast sent", { length: message.length });
    res.status(202).json({ ok: true });
  });

  // POST /api/meetings { title, startTime?, startsInMinutes?, durationMinutes?, participantIds?, roomName? }
  // Any signed-in member may schedule a meeting when AUTH_REQUIRED=true. In dev,
  // this remains open and falls back to the in-memory mock calendar.
  router.post("/meetings", memberGuard, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (title.length === 0) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    const durationMinutes = positiveNumber(body.durationMinutes, DEFAULT_MEETING_DURATION);
    const participantIds = Array.isArray(body.participantIds)
      ? body.participantIds.filter((id): id is string => typeof id === "string")
      : [];
    let roomName: string | undefined;
    if (typeof body.roomName === "string" && body.roomName.trim().length > 0) {
      if (!isMeetingRoom(body.roomName, map)) {
        res.status(400).json({ error: "Invalid meeting room" });
        return;
      }
      roomName = body.roomName;
    }

    const now = Date.now();
    const session = sessionOf(res);
    const selectedRoom = roomName || undefined;
    const startTime = parseMeetingStartTime(body.startTime, body.startsInMinutes, now);
    if (startTime === null) {
      res.status(400).json({ error: "startTime must be a valid future date/time" });
      return;
    }
    const endTime = startTime + Math.round(durationMinutes * 60_000);
    const startsInMinutes = Math.max(0, (startTime - now) / 60_000);
    const roomEmail = selectedRoom ? googleRoomEmailFor(selectedRoom) : undefined;

    if (session && container.googleCalendar) {
      try {
        const googleMeeting = await container.googleCalendar.createMeeting({
          organizerUserId: session.sub,
          title,
          startTime,
          endTime,
          roomName: selectedRoom || "Meeting Room C",
          attendeeEmails: await attendeeEmails(participantIds, session.sub, session.email),
          roomEmail,
        });
        // Also seed the mock calendar so users without Google connected still
        // get the in-office Join prompt. The real Google meeting overlays it for
        // connected users via CompositeCalendarAdapter.
        const shadow = container.mockCalendar.createMeeting(
          { title, startsInMinutes, durationMinutes, participantIds, roomName },
          now,
        );
        shadow.meetLink = googleMeeting.meetLink;
        log.info("meeting scheduled", {
          meetingId: googleMeeting.id,
          title: googleMeeting.title,
          room: googleMeeting.roomName,
          startsInMinutes,
          durationMinutes,
          invitees: participantIds.length || "everyone",
          source: "google",
          roomBooked: Boolean(roomEmail),
        });
        res.status(201).json({
          meeting: { ...googleMeeting, participantIds: [...participantIds] },
          source: "google",
        });
        return;
      } catch (err) {
        log.warn("google meeting create failed; falling back to mock", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Seeds the mock calendar; the presence tick (~3s) detects start/end and
    // emits MEETING_STARTED/ENDED — never auto-moves avatars (agency rule).
    const meeting = container.mockCalendar.createMeeting(
      { title, startsInMinutes, durationMinutes, participantIds, roomName },
      now,
    );
    log.info("meeting scheduled", {
      meetingId: meeting.id,
      title: meeting.title,
      room: meeting.roomName,
      startsInMinutes,
      durationMinutes,
      invitees: participantIds.length || "everyone",
      source: "mock",
    });
    res.status(201).json({ meeting, source: "mock" });
  });

  return router;
}

function parseMeetingStartTime(
  rawStartTime: unknown,
  rawStartsInMinutes: unknown,
  now: number,
): number | null {
  if (typeof rawStartTime === "number" || typeof rawStartTime === "string") {
    const parsed =
      typeof rawStartTime === "number" ? rawStartTime : Date.parse(rawStartTime);
    if (!Number.isFinite(parsed) || parsed < now) return null;
    return Math.round(parsed);
  }
  const startsInMinutes = nonNegativeNumber(rawStartsInMinutes, DEFAULT_MEETING_START);
  return now + Math.round(startsInMinutes * 60_000);
}

function googleRoomEmailFor(roomName: string): string | undefined {
  const raw = process.env.GOOGLE_MEETING_ROOM_EMAILS?.trim();
  if (!raw) return undefined;
  for (const entry of raw.split(",")) {
    const [name, email] = entry.split("=");
    if (name?.trim() === roomName && email?.trim()) return email.trim();
  }
  return undefined;
}

function createMeetingGuard(): RequestHandler {
  if (container.authConfig.authRequired) return requireAuth(container.authConfig.jwt);
  return (_req: Request, res: Response, next: NextFunction): void => {
    const token = bearerToken(_req);
    const session = token ? container.authConfig.jwt.tryVerify(token) : null;
    if (session) res.locals.session = session;
    next();
  };
}

async function attendeeEmails(
  participantIds: string[],
  organizerUserId: string,
  organizerEmail: string,
): Promise<string[]> {
  const out = new Set<string>();
  const liveUserIds = new Set<string>();
  for (const player of container.registry.room?.listPlayers() ?? []) {
    if (!player.isNpc) liveUserIds.add(player.userId);
  }

  // Empty participantIds means "everyone" for in-office prompts. For Google
  // Calendar, invite everyone currently online whose real email is known.
  const targetIds = participantIds.length > 0 ? participantIds : [...liveUserIds];
  for (const userId of targetIds) {
    if (userId === organizerUserId) continue;
    const stored = await container.users.findById(userId).catch(() => null);
    const email = stored?.email;
    if (email && email.toLowerCase() !== organizerEmail.toLowerCase()) out.add(email);
  }
  return [...out];
}

function positiveNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function isMeetingRoom(name: string, map: ReturnType<typeof buildOfficeMap>): boolean {
  return map.areas.some((area) => area.type === "MEETING_ROOM" && area.name === name);
}
