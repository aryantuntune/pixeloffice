// ---------------------------------------------------------------------------
// UserRepository contract test suite.
//
// `runUserRepositoryContract` asserts the behaviour EVERY UserRepository impl
// must satisfy (save/upsert, findById, all). It is exported as a function so
// the Postgres impl can reuse the exact same assertions against a real DB when
// one is available — guarded by TEST_DATABASE_URL so CI (no DB) skips it.
// ---------------------------------------------------------------------------

import { afterAll, describe, expect, it } from "vitest";
import type { StoredUser, UserRepository } from "./user.repository";
import { InMemoryUserRepository } from "./user.repository";

const userA: StoredUser = {
  id: "u-alice",
  name: "Alice",
  department: "Engineering",
  avatarId: "ruby",
};
const userB: StoredUser = {
  id: "u-bob",
  name: "Bob",
  department: "Design",
  avatarId: "sapphire",
};

/**
 * Run the shared contract against any UserRepository. `makeRepo` returns a fresh,
 * empty repository per call so cases don't leak into each other.
 */
export function runUserRepositoryContract(
  label: string,
  makeRepo: () => Promise<UserRepository> | UserRepository,
): void {
  describe(`UserRepository contract: ${label}`, () => {
    it("returns null for an unknown id", async () => {
      const repo = await makeRepo();
      expect(await repo.findById("nope")).toBeNull();
    });

    it("saves and reads a user back by id", async () => {
      const repo = await makeRepo();
      const saved = await repo.save(userA);
      expect(saved).toEqual(userA);
      expect(await repo.findById(userA.id)).toEqual(userA);
    });

    it("save returns a copy, not the caller's object (no aliasing)", async () => {
      const repo = await makeRepo();
      const input = { ...userA };
      const saved = await repo.save(input);
      input.name = "MUTATED";
      const reread = await repo.findById(userA.id);
      expect(saved.name).toBe("Alice");
      expect(reread?.name).toBe("Alice");
    });

    it("upserts: saving the same id updates fields instead of duplicating", async () => {
      const repo = await makeRepo();
      await repo.save(userA);
      const updated: StoredUser = { ...userA, name: "Alice II", department: "Product" };
      await repo.save(updated);
      expect(await repo.findById(userA.id)).toEqual(updated);
      expect(await repo.all()).toHaveLength(1);
    });

    it("all() returns every saved user", async () => {
      const repo = await makeRepo();
      await repo.save(userA);
      await repo.save(userB);
      const all = await repo.all();
      expect(all).toHaveLength(2);
      const ids = all.map((u) => u.id).sort();
      expect(ids).toEqual(["u-alice", "u-bob"]);
    });

    it("all() is empty on a fresh repository", async () => {
      const repo = await makeRepo();
      expect(await repo.all()).toEqual([]);
    });
  });
}

// --- In-memory impl: always run (no external services). --------------------
runUserRepositoryContract("InMemoryUserRepository", () => new InMemoryUserRepository());

// --- Postgres impl: opt-in via TEST_DATABASE_URL (skipped in CI). -----------
// Guarded so `pg` is NEVER imported when the env var is absent — that keeps the
// in-memory suite (and CI) runnable without the `pg` dependency installed.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL) {
  describe("UserRepository contract: PostgresUserRepository (live DB)", async () => {
    const { Database } = await import("../persistence/database");
    const { PostgresUserRepository } = await import("./postgres-user.repository");
    const db = new Database({ connectionString: TEST_DATABASE_URL, autoMigrate: true });
    await db.migrate();

    afterAll(async () => {
      await db.end();
    });

    runUserRepositoryContract("PostgresUserRepository", async () => {
      // Fresh state per case: clear the table (test DB only — never production).
      await db.query("TRUNCATE users");
      return new PostgresUserRepository(db);
    });
  });
} else {
  describe.skip("UserRepository contract: PostgresUserRepository (live DB) — set TEST_DATABASE_URL to run", () => {
    it("skipped", () => {});
  });
}
