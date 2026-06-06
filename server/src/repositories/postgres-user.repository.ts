// ---------------------------------------------------------------------------
// PostgreSQL implementation of the EXISTING UserRepository interface.
//
// Drop-in for InMemoryUserRepository (plan Layer 4 — User storage). Callers
// depend only on the interface, so swapping storage requires no service changes.
//
// Table (server/db/init.sql):
//   users(id text pk, email text, display_name text, avatar_id text,
//         department text, role text, created_at, updated_at)
//
// StoredUser carries id/name/department/avatarId. The wider table columns
// (email, role) are kept for the production User domain model (plan Domain
// Model) and OAuth/GreytHR sync; this repository populates the StoredUser
// subset and leaves the rest to whatever writes them (defaults/nullable).
// ---------------------------------------------------------------------------

import type { AvatarId, Department } from "@pixeloffice/shared";
import type { Database } from "../persistence/database";
import type { StoredUser, UserRepository } from "./user.repository";

interface UserRow {
  id: string;
  display_name: string;
  department: string;
  avatar_id: string;
}

const SELECT_COLUMNS = "id, display_name, department, avatar_id";

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly db: Database) {}

  /** Upsert by primary key. Updates name/department/avatar + updated_at. */
  async save(user: StoredUser): Promise<StoredUser> {
    await this.db.query(
      `INSERT INTO users (id, display_name, department, avatar_id, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         department   = EXCLUDED.department,
         avatar_id    = EXCLUDED.avatar_id,
         updated_at   = now()`,
      [user.id, user.name, user.department, user.avatarId],
    );
    return { ...user };
  }

  async findById(id: string): Promise<StoredUser | null> {
    const res = await this.db.query<UserRow>(
      `SELECT ${SELECT_COLUMNS} FROM users WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row ? rowToUser(row) : null;
  }

  async all(): Promise<StoredUser[]> {
    const res = await this.db.query<UserRow>(
      `SELECT ${SELECT_COLUMNS} FROM users ORDER BY display_name ASC`,
    );
    return res.rows.map(rowToUser);
  }
}

function rowToUser(row: UserRow): StoredUser {
  return {
    id: row.id,
    name: row.display_name,
    department: row.department as Department,
    avatarId: row.avatar_id as AvatarId,
  };
}
