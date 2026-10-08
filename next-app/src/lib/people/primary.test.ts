import { describe, expect, test } from "bun:test";

import { animeListPath, characterPath, parseEntityId, personPath } from "./paths";
import { personAnchor, primaryAppearance } from "./primary";
import type { Appearance, PeopleWork, Person, VoiceRole } from "./types";
import { formatProfileDate, isoProfileDate } from "./dates";

function work(id: number, popularity: number | null): PeopleWork {
  return {
    anilistId: id,
    titleRomaji: `Show ${id}`,
    titleEnglish: null,
    titleNative: null,
    titleChinese: null,
    titleHant: null,
    titleHantSeo: null,
    coverImageUrl: null,
    format: null,
    year: 2023,
    popularity,
    posterAccent: null,
  };
}

describe("primaryAppearance", () => {
  test("the best role, then the most popular title", () => {
    const apps: Appearance[] = [
      { anime: work(1, 900_000), role: "SUPPORTING" },
      { anime: work(2, 100_000), role: "MAIN" },
      { anime: work(3, 300_000), role: "MAIN" },
    ];
    expect(primaryAppearance({ appearances: apps })?.anime.anilistId).toBe(3);
    expect(primaryAppearance({ appearances: [] })).toBeNull();
  });
});

describe("personAnchor", () => {
  const voice = (animeId: number): VoiceRole => ({
    character: { anilistId: 1, name: { full: "C", native: null, cn: null }, image: null },
    anime: work(animeId, 10),
    role: "MAIN",
    language: "Japanese",
    roleNotes: null,
  });

  test("a voice actor hangs under their first representative role's title, in its cast", () => {
    const p: Pick<Person, "representativeRoles" | "voiceRoles" | "staffRoles"> = {
      representativeRoles: [voice(5)],
      voiceRoles: [{ year: 2023, roles: [voice(6), voice(5)] }],
      staffRoles: [],
    };
    expect(personAnchor(p)).toEqual({ work: work(5, 10), list: "characters" });
  });

  test("production staff hang under their most popular credit, in its staff list", () => {
    const p: Pick<Person, "representativeRoles" | "voiceRoles" | "staffRoles"> = {
      representativeRoles: [],
      voiceRoles: [],
      staffRoles: [
        { year: 2026, works: [{ anime: work(7, 50), roles: ["Director"] }] },
        { year: 2023, works: [{ anime: work(8, 5000), roles: ["Storyboard"] }] },
      ],
    };
    expect(personAnchor(p)).toEqual({ work: work(8, 5000), list: "staff" });
  });
});

describe("paths", () => {
  test("one spelling of every URL", () => {
    expect(personPath(133507)).toBe("/person/133507");
    expect(characterPath(184313)).toBe("/character/184313");
    expect(animeListPath(154587, "characters")).toBe("/anime/154587/characters");
    expect(animeListPath(154587, "staff")).toBe("/anime/154587/staff");
  });

  test("ids are canonical positive int32s", () => {
    expect(parseEntityId("133507")).toBe(133507);
    expect(parseEntityId("2147483647")).toBe(2147483647);
    for (const bad of ["0", "007", "-1", "1.5", "1e3", "abc", "", "2147483648", "99999999999"]) {
      expect(parseEntityId(bad)).toBeNull();
    }
  });
});

describe("profile dates", () => {
  test("with a year: the site's date format; without: month and day", () => {
    expect(formatProfileDate({ year: 1994, month: 6, day: 4 }, "zh")).toBe("1994年6月4日");
    expect(formatProfileDate({ year: 1994, month: 6, day: 4 }, "en")).toBe("1994-06-04");
    expect(formatProfileDate({ year: null, month: 6, day: 4 }, "zh")).toBe("6月4日");
    expect(formatProfileDate({ year: null, month: 6, day: 4 }, "zh-Hant")).toBe("6月4日");
    expect(formatProfileDate({ year: null, month: 12, day: 25 }, "en")).toBe("December 25");
    expect(formatProfileDate({ year: null, month: 3, day: null }, "en")).toBe("March");
    expect(formatProfileDate({ year: null, month: null, day: 4 }, "zh")).toBeNull();
    expect(formatProfileDate(null, "zh")).toBeNull();
  });

  test("schema.org gets ISO with a year, nothing without", () => {
    expect(isoProfileDate({ year: 1994, month: 6, day: 4 })).toBe("1994-06-04");
    expect(isoProfileDate({ year: 1994, month: null, day: null })).toBe("1994");
    expect(isoProfileDate({ year: null, month: 6, day: 4 })).toBeNull();
  });
});
