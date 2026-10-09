// Fixtures for the edit flow (specs/sandbox/people-edit).
//
// The spec edits a title, a character and a voice of its own, written here
// the way the credit writers store them (seedDetailCredits): a fresh sandbox
// database holds no real character with a Bangumi name -- those come only
// from the offline cmd/bgmnames -- and a spec that leaned on one passed only
// where a developer had run it. The character is called Stark and voiced by
// Chiaki Kobayashi, with Stark's AniList portrait, so the pages read like the
// real ones. Its two users' submissions and notifications go with them (ON
// DELETE CASCADE); the overlay an accepted edit leaves is removed with the
// rest.
//
// takeOverlay / restoreOverlay set a real page's overlay aside and put it
// back exactly (edits-fixtures.spec.ts holds them to that).

import type { JSONValue } from "postgres";
import { ensureAnimeDetail, getSql, removeAnimeFixture, removeDetailCredits, seedDetailCredits } from "./pg";
import { makeUser, type TestUser } from "./users";

export const STARK = 184313;

/** The title, character and voice the edit spec owns; ids no other spec uses. */
export const EDIT_ANIME = 990_530_001;
export const EDIT_CHARACTER = 990_530_101;
export const EDIT_VOICE = 990_530_201;
export const EDIT_ANIME_TITLE = "E2E 修改用番";
/** The character's portrait: a public image, so the page has an old photo to keep. */
export const EDIT_PORTRAIT = "https://s4.anilist.co/file/anilistcdn/character/large/b184313-CQl6GSt4RSny.jpg";

/** Write the title, its lead and the lead's Japanese voice, with Bangumi names. */
export async function seedEditFixture(): Promise<void> {
  await ensureAnimeDetail({
    anilistId: EDIT_ANIME,
    titleRomaji: "E2E Edit Title",
    titleChinese: EDIT_ANIME_TITLE,
    episodes: 12,
  });
  await seedDetailCredits(
    EDIT_ANIME,
    [
      {
        characterId: EDIT_CHARACTER,
        role: "MAIN",
        nameEn: "Stark",
        nameJa: "シュタルク",
        nameCn: "修塔尔克",
        voices: [
          {
            staffId: EDIT_VOICE,
            language: "Japanese",
            nameFull: "Chiaki Kobayashi",
            nameNative: "小林千晃",
            nameCn: "小林千晃",
          },
        ],
      },
    ],
    [],
  );
  const sql = getSql();
  await sql`
    UPDATE anime_characters SET image_url = ${EDIT_PORTRAIT}
    WHERE anime_id = ${EDIT_ANIME} AND character_id = ${EDIT_CHARACTER}
  `;
}

/** Everything seedEditFixture wrote, and any overlay an accepted edit left on it. */
export async function removeEditFixture(): Promise<void> {
  const sql = getSql();
  await sql`
    DELETE FROM entity_overlays
    WHERE (kind = 'character' AND entity_id = ${EDIT_CHARACTER})
       OR (kind = 'person' AND entity_id = ${EDIT_VOICE})
  `;
  await removeDetailCredits([EDIT_CHARACTER], [EDIT_VOICE]);
  await removeAnimeFixture(EDIT_ANIME);
}

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
