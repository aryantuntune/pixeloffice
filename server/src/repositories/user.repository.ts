// ---------------------------------------------------------------------------
// User persistence boundary.
//
// V1 is in-memory. In production a PostgreSqlUserRepository implements this
// same interface (plan: PostgreSQL persistence layer) — callers depend only
// on the interface, so swapping storage requires no service changes.
// ---------------------------------------------------------------------------

import type { AvatarId, Department } from "@pixeloffice/shared";

export interface StoredUser {
  id: string;
  name: string;
  department: Department;
  avatarId: AvatarId;
  /** Verified OAuth/SSO email when available. Kept server-side for integrations. */
  email?: string;
}

export interface UserRepository {
  save(user: StoredUser): Promise<StoredUser>;
  findById(id: string): Promise<StoredUser | null>;
  all(): Promise<StoredUser[]>;
}

/** Simple in-memory map. Replace with PostgreSQL in production. */
export class InMemoryUserRepository implements UserRepository {
  private readonly users = new Map<string, StoredUser>();

  async save(user: StoredUser): Promise<StoredUser> {
    this.users.set(user.id, { ...user });
    return { ...user };
  }

  async findById(id: string): Promise<StoredUser | null> {
    const found = this.users.get(id);
    return found ? { ...found } : null;
  }

  async all(): Promise<StoredUser[]> {
    return Array.from(this.users.values()).map((u) => ({ ...u }));
  }
}
