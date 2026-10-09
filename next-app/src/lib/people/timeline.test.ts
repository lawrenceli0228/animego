import { describe, expect, test } from "bun:test";

import {
  CARDS_SHOWN_COLLAPSED,
  countItems,
  filterVoiceYears,
  offersMainFilter,
  takeItems,
  voiceWorkCount,
} from "./timeline";
import type { PeopleWork, VoiceRole, VoiceYear } from "./types";

function work(id: number, year: number | null): PeopleWork {
  return {
    anilistId: id,
    titleRomaji: `Show ${id}`,
    titleEnglish: null,
    titleNative: null,
    titleChinese: null,
    titleHant: null,
    titleHantSeo: null,
    coverImageUrl: null,
    format: "TV",
    year,
    popularity: null,
    posterAccent: null,
  };
}

function role(animeId: number, characterId: number, r: string, year: number | null): VoiceRole {
  return {
    character: { anilistId: characterId, name: { full: `C${characterId}`, native: null, cn: null }, image: null },
    anime: work(animeId, year),
    role: r,
    language: "Japanese",
    roleNotes: null,
  };
}

const YEARS: VoiceYear[] = [
  { year: 2026, roles: [role(1, 10, "MAIN", 2026), role(2, 20, "SUPPORTING", 2026)] },
  { year: 2025, roles: [role(3, 30, "SUPPORTING", 2025)] },
  { year: 2023, roles: [role(4, 40, "MAIN", 2023), role(4, 41, "SUPPORTING", 2023)] },
];

const rolesOf = (y: VoiceYear) => y.roles;
const withRoles = (y: VoiceYear, roles: VoiceRole[]): VoiceYear => ({ ...y, roles });

describe("the voice filter", () => {
  test("只看主角 keeps the leads and drops the years it empties", () => {
    const main = filterVoiceYears(YEARS, "main");
    expect(main.map((y) => y.year)).toEqual([2026, 2023]);
    expect(main.flatMap((y) => y.roles.map((r) => r.character.anilistId))).toEqual([10, 40]);
  });

  test("新到旧 is everything, in the API's order", () => {
    expect(filterVoiceYears(YEARS, "all")).toEqual(YEARS);
  });

  test("offered only when it would change something", () => {
    expect(offersMainFilter(YEARS)).toBe(true);
    expect(offersMainFilter(filterVoiceYears(YEARS, "main"))).toBe(false); // leads only
    expect(offersMainFilter([{ year: 2025, roles: [role(3, 30, "SUPPORTING", 2025)] }])).toBe(false);
    expect(offersMainFilter([])).toBe(false);
  });

  test("the count is of titles, not roles", () => {
    expect(voiceWorkCount(YEARS)).toBe(4);
    expect(voiceWorkCount(filterVoiceYears(YEARS, "main"))).toBe(2);
  });
});

describe("collapsing", () => {
  test("the first n cards, with their headings, and nothing after", () => {
    const first3 = takeItems(YEARS, rolesOf, withRoles, 3);
    expect(first3.map((y) => [y.year, y.roles.length])).toEqual([
      [2026, 2],
      [2025, 1],
    ]);
    const first4 = takeItems(YEARS, rolesOf, withRoles, 4);
    expect(first4.map((y) => [y.year, y.roles.length])).toEqual([
      [2026, 2],
      [2025, 1],
      [2023, 1],
    ]);
  });

  test("a limit past the end is the whole list, unchanged", () => {
    expect(takeItems(YEARS, rolesOf, withRoles, 100)).toEqual(YEARS);
    expect(countItems(YEARS, rolesOf)).toBe(5);
  });

  test("three desktop rows of seven", () => {
    expect(CARDS_SHOWN_COLLAPSED).toBe(21);
  });
});
