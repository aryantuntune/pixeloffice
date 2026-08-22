import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { MeetingInfo } from "@pixeloffice/shared";
import { createAdminRouter } from "./admin.routes";
import { container } from "../container";

async function boot(): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use(express.json());
  app.use("/api", createAdminRouter());
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe("admin/user meeting routes", () => {
  let server: Server | null = null;
  const originalGoogle = container.googleCalendar;
  const originalConfigured = container.googleCalConfigured;
  const originalAuthRequired = container.authConfig.authRequired;
  const originalRegistryRoom = container.registry.room;

  afterEach(() => {
    server?.close();
    server = null;
    (container as unknown as { googleCalendar: unknown }).googleCalendar = originalGoogle;
    (container as unknown as { googleCalConfigured: boolean }).googleCalConfigured = originalConfigured;
    container.authConfig.authRequired = originalAuthRequired;
    container.registry.room = originalRegistryRoom;
    vi.restoreAllMocks();
  });

  it("lets a signed-in member create a Google Meet-backed calendar meeting", async () => {
    container.authConfig.authRequired = true;
    const token = container.authConfig.jwt.sign({
      sub: "google:organizer",
      email: "organizer@example.com",
      name: "Organizer",
      role: "member",
    });
    const created: MeetingInfo = {
      id: "gcal-created",
      title: "Design Review",
      startTime: Date.now(),
      endTime: Date.now() + 30 * 60_000,
      participantIds: ["google:organizer"],
      roomName: "Meeting Room A",
      meetLink: "https://meet.google.com/new-link",
    };
    const createMeeting = vi.fn(async () => created);
    (container as unknown as { googleCalendar: unknown }).googleCalendar = { createMeeting };
    (container as unknown as { googleCalConfigured: boolean }).googleCalConfigured = true;
    await container.users.save({
      id: "google:invitee",
      name: "Invitee",
      email: "invitee@example.com",
      department: "Engineering",
      avatarId: "ruby",
    });
    container.registry.room = {
      listPlayers: () => [
        {
          sessionId: "s2",
          userId: "google:invitee",
          name: "Invitee",
          department: "Engineering",
          avatarId: "ruby",
          x: 1,
          y: 1,
          dir: "down",
          presence: "AVAILABLE",
          source: "SYSTEM",
        },
      ],
    } as never;
    let base: string;
    ({ server, base } = await boot());

    const res = await fetch(`${base}/api/meetings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        title: "Design Review",
        startsInMinutes: 5,
        durationMinutes: 30,
        roomName: "Meeting Room A",
        participantIds: ["google:invitee"],
      }),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      meeting: { ...created, participantIds: ["google:invitee"] },
      source: "google",
    });
    expect(createMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        organizerUserId: "google:organizer",
        title: "Design Review",
        roomName: "Meeting Room A",
        attendeeEmails: ["invitee@example.com"],
      }),
    );
  });

  it("invites all online users with stored emails when participantIds is empty", async () => {
    container.authConfig.authRequired = true;
    const token = container.authConfig.jwt.sign({
      sub: "google:organizer-all",
      email: "organizer@example.com",
      name: "Organizer",
      role: "member",
    });
    const created: MeetingInfo = {
      id: "gcal-created-all",
      title: "All Hands",
      startTime: Date.now(),
      endTime: Date.now() + 30 * 60_000,
      participantIds: ["google:organizer-all"],
      roomName: "Meeting Room C",
      meetLink: "https://meet.google.com/all",
    };
    const createMeeting = vi.fn(async () => created);
    (container as unknown as { googleCalendar: unknown }).googleCalendar = { createMeeting };
    (container as unknown as { googleCalConfigured: boolean }).googleCalConfigured = true;
    await container.users.save({
      id: "google:known",
      name: "Known User",
      email: "known@example.com",
      department: "Engineering",
      avatarId: "ruby",
    });
    container.registry.room = {
      listPlayers: () => [
        {
          sessionId: "s1",
          userId: "google:known",
          name: "Known User",
          department: "Engineering",
          avatarId: "ruby",
          x: 1,
          y: 1,
          dir: "down",
          presence: "AVAILABLE",
          source: "SYSTEM",
        },
        {
          sessionId: "s2",
          userId: "google:missing-email",
          name: "Missing Email",
          department: "Engineering",
          avatarId: "ruby",
          x: 1,
          y: 1,
          dir: "down",
          presence: "AVAILABLE",
          source: "SYSTEM",
        },
      ],
    } as never;
    let base: string;
    ({ server, base } = await boot());

    const res = await fetch(`${base}/api/meetings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        title: "All Hands",
        startsInMinutes: 5,
        durationMinutes: 30,
        roomName: "Meeting Room C",
        participantIds: [],
      }),
    });

    expect(res.status).toBe(201);
    expect(createMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        attendeeEmails: ["known@example.com"],
      }),
    );
  });

  it("accepts an absolute start time and passes the Google room resource email", async () => {
    container.authConfig.authRequired = true;
    const oldRoomEmails = process.env.GOOGLE_MEETING_ROOM_EMAILS;
    process.env.GOOGLE_MEETING_ROOM_EMAILS = "Meeting Room A=room-a@resources.example.com";
    const token = container.authConfig.jwt.sign({
      sub: "google:organizer",
      email: "organizer@example.com",
      name: "Organizer",
      role: "member",
    });
    const startTime = Date.now() + 2 * 60 * 60_000;
    const created: MeetingInfo = {
      id: "gcal-created-absolute",
      title: "Room Booking",
      startTime,
      endTime: startTime + 45 * 60_000,
      participantIds: ["google:organizer"],
      roomName: "Meeting Room A",
      meetLink: "https://meet.google.com/absolute",
    };
    const createMeeting = vi.fn(async () => created);
    (container as unknown as { googleCalendar: unknown }).googleCalendar = { createMeeting };
    (container as unknown as { googleCalConfigured: boolean }).googleCalConfigured = true;
    container.registry.room = { listPlayers: () => [] } as never;
    let base: string;
    ({ server, base } = await boot());

    try {
      const res = await fetch(`${base}/api/meetings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          title: "Room Booking",
          startTime: new Date(startTime).toISOString(),
          durationMinutes: 45,
          roomName: "Meeting Room A",
          participantIds: [],
        }),
      });

      expect(res.status).toBe(201);
      expect(createMeeting).toHaveBeenCalledWith(
        expect.objectContaining({
          startTime,
          endTime: startTime + 45 * 60_000,
          roomName: "Meeting Room A",
          roomEmail: "room-a@resources.example.com",
        }),
      );
    } finally {
      if (oldRoomEmails === undefined) delete process.env.GOOGLE_MEETING_ROOM_EMAILS;
      else process.env.GOOGLE_MEETING_ROOM_EMAILS = oldRoomEmails;
    }
  });
});
