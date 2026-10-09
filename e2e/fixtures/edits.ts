// Fixtures for the edit flow (specs/sandbox/people-edit).
//
// The spec edits a real character the sandbox database already holds --
// Stark (AniList 184313), whose page, voices and Bangumi name come from the
// credits and profile sweeps -- so what it proves runs over real rows. It
// owns nothing of Stark's except his accepted-edit overlay, which it sets
// aside before it starts and puts back when it is done, and its own two
// users, whose submissions and notifications go with them (ON DELETE
// CASCADE).

import { getSql } from "./pg";
import { makeUser, type TestUser } from "./users";

export const STARK = 184313;

/** Stark's overlay as it was before the spec, to restore afterwards. */
export async function takeOverlay(kind: "character" | "person", id: number): Promise<string | null> {
  const sql = getSql();
  const rows = await sql<{ data: string }[]>`
    SELECT data::text AS data FROM entity_overlays WHERE kind = ${kind} AND entity_id = ${id}
  `;
  await sql`DELETE FROM entity_overlays WHERE kind = ${kind} AND entity_id = ${id}`;
  return rows[0]?.data ?? null;
}

export async function restoreOverlay(kind: "character" | "person", id: number, data: string | null): Promise<void> {
  const sql = getSql();
  await sql`DELETE FROM entity_overlays WHERE kind = ${kind} AND entity_id = ${id}`;
  if (data !== null) {
    await sql`INSERT INTO entity_overlays (kind, entity_id, data) VALUES (${kind}, ${id}, ${data}::jsonb)`;
  }
}

/** A reader and an admin; the role is a column on the user, as the admin spec sets it. */
export async function createEditUsers(): Promise<{ reader: TestUser; admin: TestUser }> {
  const sql = getSql();
  const reader = makeUser();
  const admin = makeUser("admin");
  for (const u of [reader, admin]) {
    await sql`
      INSERT INTO users (username, email, password, role, is_public, created_at, updated_at)
      VALUES (${u.username}, ${u.email}, ${u.passwordHash}, ${u.role === "admin" ? "admin" : null}, true, now(), now())
    `;
  }
  return { reader, admin };
}

export async function deleteEditUsers(users: TestUser[]): Promise<void> {
  const sql = getSql();
  for (const u of users) await sql`DELETE FROM users WHERE email = ${u.email}`;
}
