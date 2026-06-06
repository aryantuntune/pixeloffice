-- ---------------------------------------------------------------------------
-- PixelOffice schema bootstrap (Layer 4 — Persistence).
--
-- Applied idempotently at startup by server/src/persistence/database.ts when
-- AUTO_MIGRATE is enabled (default true whenever DATABASE_URL is set), and by
-- docker-compose (mounted into the postgres container's init dir).
--
-- Every statement uses IF NOT EXISTS so re-running is safe.
--
-- NO-SURVEILLANCE NOTE (plan Principle 2): we persist user identity for spawn /
-- roster / OAuth + GreytHR sync only. There is intentionally NO activity-log,
-- keystroke, screenshot, or productivity table. Live presence lives in Redis
-- (latest value only); it is deliberately not modelled as browsable history.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id           text PRIMARY KEY,
  email        text,
  display_name text NOT NULL,
  avatar_id    text NOT NULL,
  department   text NOT NULL,
  role         text NOT NULL DEFAULT 'member',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Email lookup (OAuth sign-in maps an email to an existing user).
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key
  ON users (email)
  WHERE email IS NOT NULL;

-- Roster grouping is by department.
CREATE INDEX IF NOT EXISTS users_department_idx
  ON users (department);
