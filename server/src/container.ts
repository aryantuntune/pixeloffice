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
// in-memory presence store, mock calendar, mock GreytHR. Real auth providers /
// JWT / Postgres / Redis / GreytHR activate only when their env config is
// present, and a configured-but-unreachable datastore degrades to in-memory
// instead of crashing (plan Principle 4: integrations are optional).
// ---------------------------------------------------------------------------

import { DevAuthProvider, type AuthProvider } from "./auth/auth-provider";
import { buildAuthConfig, type AuthConfig } from "./auth/auth-config";
import { JwtAuthProvider } from "./auth/jwt-auth.provider";
import { InMemoryUserRepository, type UserRepository } from "./repositories/user.repository";
import { MockCalendarAdapter } from "./integrations/calendar/mock-calendar.adapter";
import type { CalendarAdapter } from "./integrations/calendar/calendar-adapter";
import { EventService } from "./events/event.service";
import { PresenceService } from "./presence/presence.service";
import type { HrAdapter } from "./integrations/hr/hr-adapter";
import { MockGreytHrAdapter } from "./integrations/hr/mock-greythr.adapter";
import { GreytHrAdapter } from "./integrations/hr/greythr.adapter";
import { AttendanceService } from "./integrations/hr/attendance.service";
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
import type { OfficeRoom } from "./rooms/office.room";

// --- Synchronous, framework-free services (shared by REST + room) ----------
const mockCalendar = new MockCalendarAdapter();
const calendar: CalendarAdapter = mockCalendar;
const events = new EventService();
const presence = new PresenceService(calendar, events);

// --- Ambient NPCs (so the office never feels empty) ------------------------
// Framework-free behavior engine. Owns a seeded PRNG (NPC_SEED, default 42) so
// behavior is deterministic/testable; never reads the global clock or random.
// NPC_COUNT (default 8, 0 disables, clamped to 16). The room calls spawnAll()
// at create and tick() on its clock interval; effects become wire broadcasts.
const npcConfig = npcConfigFromEnv(process.env);
const npcs = new NpcService(buildOfficeMap(), mulberry32(npcConfig.seed), npcConfig.count);

// --- Auth: JWT-aware provider in front of the dev provider -----------------
// buildAuthConfig is the single env-reading entry point for auth. With no env
// it yields: no OAuth providers, an ephemeral JWT secret, AUTH_REQUIRED=false.
const authConfig: AuthConfig = buildAuthConfig(process.env);
const devAuth = new DevAuthProvider();
const auth: AuthProvider = new JwtAuthProvider({
  jwt: authConfig.jwt,
  fallback: devAuth,
  authRequired: authConfig.authRequired,
  defaultDepartment: authConfig.defaultDepartment,
});

// --- HR / GreytHR: real adapter only when env config is present -------------
// Real adapter activates when GREYTHR_BASE_URL is set AND either an api-user +
// api-key pair (preferred: the adapter acquires/refreshes its own token) or a
// legacy pre-acquired GREYTHR_API_TOKEN is provided. Otherwise the in-memory
// mock is used and the office still works (integrations are optional).
const greytHrConfigured =
  Boolean(process.env.GREYTHR_BASE_URL) &&
  ((Boolean(process.env.GREYTHR_API_USER) && Boolean(process.env.GREYTHR_API_KEY)) ||
    Boolean(process.env.GREYTHR_API_TOKEN));
const hr: HrAdapter = greytHrConfigured
  ? new GreytHrAdapter({
      baseUrl: process.env.GREYTHR_BASE_URL!,
      apiUser: process.env.GREYTHR_API_USER,
      apiKey: process.env.GREYTHR_API_KEY,
      apiToken: process.env.GREYTHR_API_TOKEN,
      timeoutMs: Number(process.env.GREYTHR_TIMEOUT_MS) || 5000,
    })
  : new MockGreytHrAdapter();
const attendance = new AttendanceService(hr);

// greytHR ESS portal deep link surfaced in the attendance widget. Present ONLY
// when the real integration is configured: GREYTHR_PORTAL_URL if set, else the
// kalvium ESS home as a sensible default. Undefined on the mock/dev path so the
// client hides the "Open greytHR" link.
const DEFAULT_GREYTHR_PORTAL_URL =
  "https://kalvium.greythr.com/v3/portal/ess/home";
const hrPortalUrl: string | undefined = greytHrConfigured
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
  events,
  presence,
  /** Ambient office NPCs (framework-free; the room wires effects to the wire). */
  npcs,
  auth,
  /** Auth config (providers map, jwt service, RBAC, AUTH_REQUIRED gate). */
  authConfig,
  /** HR adapter + attendance service (mock unless GreytHR env is set). */
  hr,
  attendance,
  /** greytHR ESS portal deep link, or undefined when not configured. */
  hrPortalUrl,
  /** True when the REAL GreytHR adapter is active (vs the in-memory mock). */
  hrConfigured: greytHrConfigured,
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

  const userResult = await createUserRepository(env);
  users = userResult.repository;
  database = userResult.database;

  const presenceStoreResult = await createPresenceStore(env);
  presenceStore = presenceStoreResult.store;
  redis = presenceStoreResult.redis;
}
