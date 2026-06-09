// ---------------------------------------------------------------------------
// Manual dependency-injection container.
//
// Constructs every framework-independent service ONCE and shares the same
// instances with the Colyseus room and the Express admin routes. Services are
// constructor-injected with their dependencies (interfaces, never concretes
// from the room) — none of them import Colyseus.
//
// The `registry` holds a mutable reference to the live room so admin REST can
// broadcast through it; the room sets it in onCreate. This is the single seam
// where the otherwise framework-free services touch the room.
//
// Everything env-driven is OPT-IN. With NO env vars set the container resolves
// to the exact zero-config MVP behavior: dev auth, in-memory user repo,
// in-memory presence store, mock calendar, and NO HR backend (the attendance
// routes are only mounted when greytHR is configured). Real auth providers /
// JWT / Postgres / Redis / GreytHR activate only when their env config is
// present, and a configured-but-unreachable datastore degrades to in-memory
// instead of crashing (plan Principle 4: integrations are optional).
// ---------------------------------------------------------------------------

import { DevAuthProvider, type AuthProvider } from "./auth/auth-provider";
import { buildAuthConfig, type AuthConfig } from "./auth/auth-config";
import { JwtAuthProvider } from "./auth/jwt-auth.provider";
import {
  InMemoryUserRepository,
  type UserRepository,
} from "./repositories/user.repository";
import { MockCalendarAdapter } from "./integrations/calendar/mock-calendar.adapter";
import type { CalendarAdapter } from "./integrations/calendar/calendar-adapter";
import { GoogleCalendarAdapter } from "./integrations/calendar/google-calendar.adapter";
import { CompositeCalendarAdapter } from "./integrations/calendar/composite-calendar.adapter";
import {
  InMemoryGoogleTokenStore,
  type GoogleTokenStore,
} from "./auth/google-token.store";
import { EventService } from "./events/event.service";
import { WhiteboardService } from "./whiteboard/whiteboard.service";
import { PresenceService } from "./presence/presence.service";
import type { HrAdapter } from "./integrations/hr/hr-adapter";
import { GreytHrEssAttendanceAdapter } from "./integrations/hr/greythr-ess-attendance.adapter";
import { AttendanceService } from "./integrations/hr/attendance.service";
import { HttpGreytHrEssClient } from "./integrations/greythr/greythr-ess.client";
import { GreytHrAuthService } from "./auth/greythr/greythr-auth.service";
import {
  InMemoryGreytHrSessionStore,
  type GreytHrSessionStore,
} from "./auth/greythr/greythr-session.store";
import { buildGreytHrLoginConfig } from "./auth/greythr/greythr-auth.config";
import {
  createUserRepository,
  createPresenceStore,
} from "./persistence/factories";
import {
  InMemoryPresenceStore,
  type PresenceStore,
} from "./persistence/presence-store";
import type { Database } from "./persistence/database";
import type { RedisStore } from "./persistence/redis";
import { buildOfficeMap } from "@pixeloffice/shared";
import { NpcService, mulberry32, npcConfigFromEnv } from "./npcs/npc.service";
import { InMemoryMapRepository, type MapRepository } from "./maps/map-repository";
import {
  createFloorLocationAdapter,
  type FloorLocationAdapter,
} from "./location/floor-location.adapter";
import {
  createSsidFloorResolver,
  type SsidFloorResolver,
} from "./location/ssid-floor";
import { PairCodeStore } from "./location/pair-code.store";
import type { OfficeRoom } from "./rooms/office.room";

// --- Synchronous, framework-free services (shared by REST + room) ----------
const mockCalendar = new MockCalendarAdapter();

// --- Google Calendar: real adapter only when OAuth creds are present --------
// Mirrors the GreytHR env-gate. When GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are
// set, we construct a per-user refresh-token store + GoogleCalendarAdapter and
// OVERLAY it on the mock via a dumb CompositeCalendarAdapter (admin-scheduled
// dev meetings still work AND real Google meetings drive presence). With no env
// the calendar stays the pure mock — the zero-config path is untouched.
//
// Endpoint bases are env-overridable so a local stub can stand in for Google.
const googleCalConfigured =
  Boolean(process.env.GOOGLE_CLIENT_ID?.trim()) &&
  Boolean(process.env.GOOGLE_CLIENT_SECRET?.trim());

const googleTokenStore: GoogleTokenStore = new InMemoryGoogleTokenStore();

const googleCalendar: GoogleCalendarAdapter | null = googleCalConfigured
  ? new GoogleCalendarAdapter(
      {
        clientId: process.env.GOOGLE_CLIENT_ID!.trim(),
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!.trim(),
        tokenBase: process.env.GOOGLE_TOKEN_BASE,
        apiBase: process.env.GOOGLE_API_BASE,
        pollIntervalMs: Number(process.env.GOOGLE_CAL_POLL_MS) || undefined,
        // GOOGLE_CAL_TITLES=false => read busy/free only, display "Busy".
        includeTitles: process.env.GOOGLE_CAL_TITLES !== "false",
      },
      googleTokenStore,
    )
  : null;

const calendar: CalendarAdapter = googleCalendar
  ? new CompositeCalendarAdapter(googleCalendar, mockCalendar)
  : mockCalendar;
const events = new EventService();
const presence = new PresenceService(calendar, events);
// Per-department collaborative whiteboards (in-memory; cleared on restart).
const whiteboard = new WhiteboardService();

// --- Multi-floor building / map repository ---------------------------------
// Source of the ACTIVE building (a stack of floors). The room reads the active
// building here at create; Map Studio lists/saves/activates via /api/maps. The
// default seed is the 3-floor building. In-memory in dev (DB/file-backed in prod).
const maps: MapRepository = new InMemoryMapRepository();

// --- OPT-IN physical-floor detection (off unless OFFICE_SUBNETS/OFFICE_CIDRS) -
// Framework-free adapter that maps a client IP -> Office/Remote + an optional
// floor id. With no env it resolves to the Noop impl (everyone REMOTE, feature
// inert) so the zero-config dev path is untouched. PRIVACY: the adapter never
// logs/persists the IP and never keeps a location history (plan Principle 2).
const floorLocation: FloorLocationAdapter = createFloorLocationAdapter();

// --- OPT-IN SSID -> floor resolver (companion floor reports) ----------------
// Maps a reported WiFi SSID to a floor id (SSID_FLOOR_MAP; defaults to the
// KALVIUM office map, so it is effectively always available). Validated against
// the active building's floor ids. A report only APPLIES to opted-in users (the
// room enforces the SET_LOCATION_SYNC gate). PRIVACY: the SSID is never logged
// or persisted — it is resolved to a floor id and discarded.
const ssidFloor: SsidFloorResolver = createSsidFloorResolver(
  process.env,
  maps.getActiveBuilding().floors.map((f) => f.id),
);

// --- Floor-sync PAIRING CODE store (companion <-> session, IP-independent) --
// Minted when a user enables floor sync; the user pastes it into the companion
// (FLOOR_SYNC_PAIR_CODE) so a floor report resolves to THAT session regardless
// of IP (fixes NAT / Docker / localhost multi-tab collisions). PRIVACY: a code
// maps ONLY to {sessionId,userId} in memory with a TTL; never logged/persisted,
// invalidated on disable/leave. A resolved code is still opt-in gated downstream.
const pairCodes = new PairCodeStore();

// --- Ambient NPCs (so the office never feels empty) ------------------------
// Framework-free behavior engine. Owns a seeded PRNG (NPC_SEED, default 42) so
// behavior is deterministic/testable; never reads the global clock or random.
// NPC_COUNT (default 8, 0 disables, clamped to 16). The room calls spawnAll()
// at create and tick() on its clock interval; effects become wire broadcasts.
const npcConfig = npcConfigFromEnv(process.env);
const npcs = new NpcService(
  buildOfficeMap(),
  mulberry32(npcConfig.seed),
  npcConfig.count,
);

// Auth provider (JWT in front of dev). greytHR is the single source of truth:
// when greytHR login is enabled it is the only way in, so a valid token is
// required to join — no anonymous/dev entry.
const authConfig: AuthConfig = buildAuthConfig(process.env);
if (process.env.GREYTHR_LOGIN_ENABLED === "true")
  authConfig.authRequired = true;
const devAuth = new DevAuthProvider();
const auth: AuthProvider = new JwtAuthProvider({
  jwt: authConfig.jwt,
  fallback: devAuth,
  authRequired: authConfig.authRequired,
  defaultDepartment: authConfig.defaultDepartment,
});

// --- greytHR ESS login (only when GREYTHR_LOGIN_ENABLED=true) ---------------
const greytHrLoginConfig = buildGreytHrLoginConfig(process.env);
// Read the repository through the live getter (it's set in initContainer).
const usersProxy: UserRepository = {
  save: (u) => container.users.save(u),
  findById: (id) => container.users.findById(id),
  all: () => container.users.all(),
};
// Shared greytHR session store: login writes, attendance reads.
const greytHrSessionStore: GreytHrSessionStore =
  new InMemoryGreytHrSessionStore();

const greytHrAuthService: GreytHrAuthService | null = greytHrLoginConfig
  ? new GreytHrAuthService({
      client: new HttpGreytHrEssClient({
        baseUrl: greytHrLoginConfig.baseUrl,
        timeoutMs: greytHrLoginConfig.timeoutMs,
      }),
      jwt: authConfig.jwt,
      users: usersProxy,
      adminEmails: authConfig.adminEmails,
      defaultDepartment: authConfig.defaultDepartment,
      allowedEmailDomains: authConfig.allowedEmailDomains,
      sessions: greytHrSessionStore,
    })
  : null;

// HR / GreytHR: all attendance goes through the self-hosted ESS API. No fallback
// — greytHR is the single source of truth.
const greytHrEssAttendanceConfigured = greytHrLoginConfig !== null;
const hr: HrAdapter = new GreytHrEssAttendanceAdapter({
  baseUrl:
    greytHrLoginConfig?.baseUrl ??
    (process.env.GREYTHR_CLIENT_URL?.trim().replace(/\/+$/, "") ||
      "http://localhost:3000"),
  sessions: greytHrSessionStore,
  timeoutMs: greytHrLoginConfig?.timeoutMs,
});
const attendance = new AttendanceService(hr);

const hrConfigured = greytHrEssAttendanceConfigured;

// "Open greytHR" deep link in the attendance widget (user-clicked, not a server call).
const DEFAULT_GREYTHR_PORTAL_URL = "https://kalvium.greythr.com";
const hrPortalUrl: string | undefined = hrConfigured
  ? process.env.GREYTHR_PORTAL_URL || DEFAULT_GREYTHR_PORTAL_URL
  : undefined;

// --- Persistence: defaults are in-memory; initContainer() may upgrade them --
let users: UserRepository = new InMemoryUserRepository();
let presenceStore: PresenceStore = new InMemoryPresenceStore();
let database: Database | null = null;
let redis: RedisStore | null = null;

/** Live-room registry. Set by OfficeRoom.onCreate; read by admin routes. */
export interface RoomRegistry {
  room: OfficeRoom | null;
}
const registry: RoomRegistry = { room: null };

export const container = {
  /** Concrete mock adapter — admin REST needs `createMeeting`. */
  mockCalendar,
  /** Interface view of the calendar (what services depend on). */
  calendar,
  /** Per-user Google Calendar refresh-token store (connect flow + adapter). */
  googleTokenStore,
  /** Live Google Calendar adapter (background poll loop), or null when unconfigured. */
  googleCalendar,
  /** True when the real Google Calendar integration is active. */
  googleCalConfigured,
  events,
  presence,
  /** Per-department collaborative whiteboards (in-memory stroke store). */
  whiteboard,
  /** Ambient office NPCs (framework-free; the room wires effects to the wire). */
  npcs,
  /** Active building + saved maps (the room reads the active building at create). */
  maps,
  /**
   * OPT-IN physical-floor detection adapter (IP -> Office/Remote + floor). Noop
   * (enabled()=false, everyone REMOTE) unless OFFICE_SUBNETS/OFFICE_CIDRS is set.
   * Never logs/persists the IP (plan Principle 2).
   */
  floorLocation,
  /**
   * OPT-IN SSID -> floor resolver (companion floor reports). Maps a reported
   * WiFi SSID to a floor id via SSID_FLOOR_MAP (defaults to the KALVIUM map, so
   * effectively always available). A report only APPLIES to opted-in users.
   * Never logs/persists the SSID (AGENTS.md Principle 1).
   */
  ssidFloor,
  /**
   * Floor-sync PAIRING CODE store. Minted on SET_LOCATION_SYNC{enabled:true} and
   * sent to that client (S2C.FLOOR_SYNC_CODE); the companion echoes it back as
   * body.pairCode so POST /api/location/floor-report resolves to the exact
   * session regardless of IP. PRIVACY: in-memory {sessionId,userId}+TTL only;
   * never logged/persisted; invalidated on disable/leave (AGENTS.md Principle 1).
   */
  pairCodes,
  auth,
  /** Auth config (providers map, jwt service, RBAC, AUTH_REQUIRED gate). */
  authConfig,
  /** greytHR ESS login service, or null when GREYTHR_LOGIN_ENABLED is not set. */
  greytHrAuth: greytHrAuthService,
  /** greytHR login config (null when disabled); carries the form subdomain. */
  greytHrLoginConfig,
  /**
   * HR adapter + attendance service (greytHR ESS). NOTE: there is no mock HR
   * adapter — the /api/hr routes are mounted only when `hrConfigured` is true
   * (GREYTHR_LOGIN_ENABLED). In zero-config dev HR is simply absent.
   */
  hr,
  attendance,
  /** greytHR ESS portal deep link, or undefined when not configured. */
  hrPortalUrl,
  hrConfigured,
  greytHrSessionStore,
  registry,

  // Persistence — these getters return the live impls chosen by initContainer().
  get users(): UserRepository {
    return users;
  },
  get presenceStore(): PresenceStore {
    return presenceStore;
  },
  /** Non-null only when Postgres is the active user store (health/shutdown). */
  get database(): Database | null {
    return database;
  },
  /** Non-null only when Redis is the active presence store (health/shutdown). */
  get redis(): RedisStore | null {
    return redis;
  },
};

export type Container = typeof container;

let initialized = false;

/**
 * Resolve the env-driven persistence backends. Idempotent and safe to call
 * before `httpServer.listen()`. Selection + graceful fallback live in the
 * factories; a configured-but-down datastore degrades to in-memory and never
 * crashes boot. With no env vars this is effectively a no-op (stays in-memory).
 */
export async function initContainer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (initialized) return;
  initialized = true;

  // Start the Google Calendar background poll loop (no-op when unconfigured).
  // The adapter owns its own interval; the room tick stays untouched.
  googleCalendar?.start();

  const userResult = await createUserRepository(env);
  users = userResult.repository;
  database = userResult.database;

  const presenceStoreResult = await createPresenceStore(env);
  presenceStore = presenceStoreResult.store;
  redis = presenceStoreResult.redis;
}
