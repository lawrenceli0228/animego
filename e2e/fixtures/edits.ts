// Fixtures for the edit flow (specs/sandbox/people-edit).
//
// The spec edits a real character the sandbox database already holds --
// Stark (AniList 184313), whose page, voices and Bangumi name come from the
// credits and profile sweeps -- so what it proves runs over real rows. It
// owns nothing of Stark's except his accepted-edit overlay, which it sets
// aside before it starts and puts back when it is done, and its own two
// users, whose submissions and notifications go with them (ON DELETE
// CASCADE).

import type { JSONValue } from "postgres";
import { getSql } from "./pg";
import { makeUser, type TestUser } from "./users";

export const STARK = 184313;

/** An overlay row as it was, to put back exactly. */
export interface SavedOverlay {
  /** The document, as postgres.js parses jsonb: an object. */
  data: JSONValue;
  updatedAt: Date;
  updatedBy: string | null;
}

/**
 * Sets a page's overlay aside -- it is gone until restoreOverlay -- and
 * returns it, or null when the page had none.
 */
export async function takeOverlay(kind: "character" | "person", id: number): Promise<SavedOverlay | null> {
  const sql = getSql();
  const rows = await sql<{ data: JSONValue; updated_at: Date; updated_by: string | null }[]>`
    DELETE FROM entity_overlays WHERE kind = ${kind} AND entity_id = ${id}
    RETURNING data, updated_at, updated_by
  `;
  const row = rows[0];
  return row ? { data: row.data, updatedAt: row.updated_at, updatedBy: row.updated_by } : null;
}

/**
 * Puts back what takeOverlay set aside, over whatever overlay the spec left;
 * with null, leaves the page with none. The document goes back through
 * sql.json: a JSON *string* bound to a jsonb parameter is stored as a jsonb
 * string, which the table's check refuses.
 */
export async function restoreOverlay(
  kind: "character" | "person",
  id: number,
  saved: SavedOverlay | null,
): Promise<void> {
  const sql = getSql();
  await sql`DELETE FROM entity_overlays WHERE kind = ${kind} AND entity_id = ${id}`;
  if (saved !== null) {
    await sql`
      INSERT INTO entity_overlays (kind, entity_id, data, updated_at, updated_by)
      VALUES (${kind}, ${id}, ${sql.json(saved.data)}, ${saved.updatedAt}, ${saved.updatedBy})
    `;
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
