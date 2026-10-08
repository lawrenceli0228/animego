// Fixtures for the person and character pages (specs/sandbox/people-pages).
//
// Written the way the credit writers, the profiles sweep and cmd/bgmnames
// write them, under ids no real AniList record has, and every statement is
// idempotent: a re-run after an interrupted one finds its rows already there.
//
//   titles      990_500_001..030  six years (2026..2021) of five, most
//                                 popular first; 990_500_099 is adult
//   characters  990_510_001..030  one per title, a lead on every third;
//                                 001 also supports on title 002 and has a
//                                 profile with a spoiler in its description
//   people      990_520_001       voices every character above (31 roles,
//                                 30 titles), profile + Chinese name
//               990_520_002       001's childhood voice
//               990_520_003       production staff, no profile (rowless)
//               990_520_004       credited only on the adult title

import { getSql } from "./pg";

export const TITLE_BASE = 990_500_000;
export const TITLES = 30;
export const ADULT_TITLE = 990_500_099;
export const CHARACTER_BASE = 990_510_000;
export const LEAD = 990_510_001;
export const VOICE = 990_520_001;
export const CHILD_VOICE = 990_520_002;
export const STAFF = 990_520_003;
export const ADULT_ONLY = 990_520_004;

/** The lead's description: a link, then a spoiler with text after it. */
export const LEAD_SPOILER = "E2E spoiler: the lead becomes the villain.";
export const LEAD_DESCRIPTION =
  "E2E lead fights alongside [E2E Friend](https://anilist.co/character/1).\n\n" +
  `~!${LEAD_SPOILER}!~ After the spoiler.`;

const titleId = (t: number) => TITLE_BASE + t;
const characterId = (t: number) => CHARACTER_BASE + t;
/** 2026 for titles 1-5, 2025 for 6-10, … 2021 for 26-30. */
export const yearOf = (t: number) => 2026 - Math.floor((t - 1) / 5);
const isLead = (t: number) => t % 3 === 1;

/** Titles whose character is a lead: the 只看主角 view. */
export const LEAD_TITLES = Array.from({ length: TITLES }, (_, i) => i + 1).filter(isLead);

export async function seedPeopleFixtures(): Promise<void> {
  const sql = getSql();
  for (let t = 1; t <= TITLES; t++) {
    const month = String((t % 5) + 1).padStart(2, "0");
    await sql`
      INSERT INTO anime_cache (anilist_id, title_romaji, title_chinese, start_date, season_year, popularity, is_adult, format)
      VALUES (${titleId(t)}, ${`E2E People Show ${t}`}, ${`E2E 人物番 ${t}`}, ${`${yearOf(t)}-${month}-01`},
              ${yearOf(t)}, ${1000 * (TITLES + 1 - t)}, false, 'TV')
      ON CONFLICT (anilist_id) DO NOTHING
    `;
    await sql`
      INSERT INTO anime_characters (anime_id, display_order, name_en, name_ja, role, voice_actor_en, voice_actor_ja, character_id, voice_actor_id)
      VALUES (${titleId(t)}, 0, ${`E2E Character ${t}`}, ${`イーツーイー${t}`}, ${isLead(t) ? "MAIN" : "SUPPORTING"},
              'E2E Voice Actor', 'イーツーイー声優', ${characterId(t)}, ${VOICE})
      ON CONFLICT (anime_id, character_id) WHERE character_id IS NOT NULL DO NOTHING
    `;
    await sql`
      INSERT INTO anime_character_voices (anime_id, character_id, staff_id, display_order, language, name_full, name_native)
      VALUES (${titleId(t)}, ${characterId(t)}, ${VOICE}, 0, 'Japanese', 'E2E Voice Actor', 'イーツーイー声優')
      ON CONFLICT DO NOTHING
    `;
  }

  // The lead's childhood voice on its own title, and a supporting turn on title 2.
  await sql`
    INSERT INTO anime_character_voices (anime_id, character_id, staff_id, display_order, language, role_notes, name_full, name_native)
    VALUES (${titleId(1)}, ${LEAD}, ${CHILD_VOICE}, 1, 'Japanese', 'Childhood', 'E2E Child Voice', 'イーツーイー子役')
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO anime_characters (anime_id, display_order, name_en, name_ja, role, voice_actor_en, voice_actor_ja, character_id, voice_actor_id)
    VALUES (${titleId(2)}, 1, 'E2E Character 1', 'イーツーイー1', 'SUPPORTING', 'E2E Voice Actor', 'イーツーイー声優', ${LEAD}, ${VOICE})
    ON CONFLICT (anime_id, character_id) WHERE character_id IS NOT NULL DO NOTHING
  `;
  await sql`
    INSERT INTO anime_character_voices (anime_id, character_id, staff_id, display_order, language, name_full, name_native)
    VALUES (${titleId(2)}, ${LEAD}, ${VOICE}, 0, 'Japanese', 'E2E Voice Actor', 'イーツーイー声優')
    ON CONFLICT DO NOTHING
  `;

  // Production staff with no profile.
  for (const [t, order, role] of [
    [1, 0, "Director"],
    [1, 3, "Storyboard (eps 1, 5)"],
    [2, 0, "Director"],
  ] as const) {
    await sql`
      INSERT INTO anime_staff (anime_id, display_order, name_en, name_ja, role, staff_id)
      VALUES (${titleId(t)}, ${order}, 'E2E Staff Person', 'イーツーイー監督', ${role}, ${STAFF})
      ON CONFLICT (anime_id, staff_id, role) WHERE staff_id IS NOT NULL DO NOTHING
    `;
  }

  // Someone credited only on an adult title: no page.
  await sql`
    INSERT INTO anime_cache (anilist_id, title_romaji, season_year, popularity, is_adult, format)
    VALUES (${ADULT_TITLE}, 'E2E Adult Show', 2024, 999999, true, 'TV')
    ON CONFLICT (anilist_id) DO NOTHING
  `;
  await sql`
    INSERT INTO anime_characters (anime_id, display_order, name_en, role, voice_actor_en, character_id, voice_actor_id)
    VALUES (${ADULT_TITLE}, 0, 'E2E Adult Character', 'MAIN', 'E2E Adult Voice', ${CHARACTER_BASE + 99}, ${ADULT_ONLY})
    ON CONFLICT (anime_id, character_id) WHERE character_id IS NOT NULL DO NOTHING
  `;

  // Profiles and Chinese names.
  await sql`
    INSERT INTO people (anilist_id, name_full, name_native, primary_occupations, gender, birth_year, birth_month, birth_day,
                        home_town, blood_type, language, fetched_at, checked_at)
    VALUES (${VOICE}, 'E2E Voice Actor', 'イーツーイー声優', ${["Voice Actor"]}, 'Female', 1990, 9, 27,
            'Oita Prefecture, Japan', 'A', 'Japanese', now(), now())
    ON CONFLICT (anilist_id) DO NOTHING
  `;
  await sql`
    INSERT INTO characters (anilist_id, name_full, name_native, name_alternative, name_alternative_spoiler, description,
                            gender, age, fetched_at, checked_at)
    VALUES (${LEAD}, 'E2E Lead', 'イーツーイー主役', ${["The E2E Lead"]}, ${["E2E Secret Name"]}, ${LEAD_DESCRIPTION},
            'Female', '17', now(), now())
    ON CONFLICT (anilist_id) DO NOTHING
  `;
  await sql`
    INSERT INTO bgm_person_map (anilist_id, bgm_id, name_cn, source, matched_at)
    VALUES (${VOICE}, ${VOICE}, 'E2E 声优', 'e2e', now())
    ON CONFLICT (anilist_id) DO NOTHING
  `;
  await sql`
    INSERT INTO bgm_character_map (anilist_id, bgm_id, name_cn, source, matched_at)
    VALUES (${LEAD}, ${LEAD}, 'E2E 主角', 'e2e', now())
    ON CONFLICT (anilist_id) DO NOTHING
  `;
}

/** Everything seedPeopleFixtures wrote; titles take their credits with them. */
export async function removePeopleFixtures(): Promise<void> {
  const sql = getSql();
  await sql`DELETE FROM anime_cache WHERE anilist_id BETWEEN ${TITLE_BASE} AND ${ADULT_TITLE}`;
  await sql`DELETE FROM people WHERE anilist_id BETWEEN ${VOICE} AND ${ADULT_ONLY}`;
  await sql`DELETE FROM characters WHERE anilist_id BETWEEN ${CHARACTER_BASE} AND ${CHARACTER_BASE + 99}`;
  await sql`DELETE FROM bgm_person_map WHERE anilist_id BETWEEN ${VOICE} AND ${ADULT_ONLY}`;
  await sql`DELETE FROM bgm_character_map WHERE anilist_id BETWEEN ${CHARACTER_BASE} AND ${CHARACTER_BASE + 99}`;
}
