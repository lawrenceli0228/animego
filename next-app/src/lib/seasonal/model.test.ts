import { describe, expect, test } from "bun:test";

import type { SeasonalAnime } from "@/lib/types";
import { seasonRowsOf, toSeasonalItems } from "./model";

// API row → browse item. Two things are pinned beyond the field mapping:
// a go-api without the browse fields still produces usable items (all the
// new fields null, nothing thrown), and the premiere-date fallback the month
// chart depends on.

function row(overrides: Partial<SeasonalAnime> & { anilistId: number }): SeasonalAnime {
  return {
    titleRomaji: null,
    titleEnglish: null,
    titleNative: null,
    titleChinese: null,
    coverImageUrl: null,
    coverImageColor: null,
    posterAccent: null,
    averageScore: null,
    episodes: null,
    season: "FALL",
    seasonYear: 2026,
    status: "RELEASING",
    format: "TV",
    ...overrides,
  };
}

const FULL = row({
  anilistId: 195516,
  titleChinese: "药屋少女的呢喃 第三季",
  titleNative: "薬屋のひとりごと 第3期",
  titleRomaji: "Kusuriya no Hitorigoto 3rd Season",
  titleEnglish: "The Apothecary Diaries Season 3",
  coverImageUrl: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx195516.jpg",
  posterAccent: "#e4a15d",
  averageScore: 85,
  bangumiScore: 6.8,
  episodes: 12,
  genres: ["Drama", "Mystery"],
  descriptionCn: "猫猫回到了花街。<br>某天……",
  description: "Maomao returns. (Source: Crunchyroll)",
  studio: "OLM",
  nextAiringAt: "2026-10-23T14:00:00Z",
  nextAiringEpisode: 4,
  popularity: 99_660,
  favourites: 2_314,
  source: "LIGHT_NOVEL",
  startDate: "2026-10-02",
  duration: 24,
  isSequel: true,
});

describe("toSeasonalItems", () => {
  test("maps every browse field off a complete row", () => {
    const [item] = toSeasonalItems([FULL], "zh");
    expect(item).toMatchObject({
      id: 195516,
      title: "药屋少女的呢喃 第三季",
      rank: 0,
      score: 85,
      bangumi: 6.8,
      episodes: 12,
      duration: 24,
      genres: ["Drama", "Mystery"],
      studio: "OLM",
      next: { at: Date.parse("2026-10-23T14:00:00Z"), ep: 4 },
      popularity: 99_660,
      favourites: 2_314,
      source: "LIGHT_NOVEL",
      start: "2026-10-02",
      sequel: true,
    });
    expect(item.hue).not.toBeNull();
  });

  test("a go-api without the browse fields yields nulls, not errors", () => {
    const [item] = toSeasonalItems([row({ anilistId: 1, titleChinese: "旧接口" })], "zh");
    expect(item).toMatchObject({
      studio: null,
      next: null,
      popularity: null,
      favourites: null,
      source: null,
      start: null,
      duration: null,
      sequel: null,
      genres: [],
    });
  });

  test("with no start date, a first episode on the schedule dates the premiere — on the Beijing calendar", () => {
    // 16:30 UTC on the 20th is 00:30 on the 21st in Beijing.
    const [first] = toSeasonalItems(
      [row({ anilistId: 2, nextAiringAt: "2026-10-20T16:30:00Z", nextAiringEpisode: 1 })],
      "zh",
    );
    expect(first.start).toBe("2026-10-21");
    const [later] = toSeasonalItems(
      [row({ anilistId: 3, nextAiringAt: "2026-10-20T16:30:00Z", nextAiringEpisode: 5 })],
      "zh",
    );
    expect(later.start).toBeNull();
  });

  test("a stored start date wins over the schedule, and a timestamp is read as its date", () => {
    const [a] = toSeasonalItems(
      [row({ anilistId: 4, startDate: "2026-10-05T00:00:00Z", nextAiringAt: "2026-10-20T16:30:00Z", nextAiringEpisode: 1 })],
      "zh",
    );
    expect(a.start).toBe("2026-10-05");
    const [b] = toSeasonalItems([row({ anilistId: 5, startDate: "2026-13-40" })], "zh");
    expect(b.start).toBeNull();
  });

  test("a schedule that cannot be read is no schedule", () => {
    const bad = toSeasonalItems(
      [
        row({ anilistId: 6, nextAiringAt: "not a date", nextAiringEpisode: 2 }),
        row({ anilistId: 7, nextAiringAt: "2026-10-20T16:30:00Z", nextAiringEpisode: 0 }),
        row({ anilistId: 8, nextAiringAt: null, nextAiringEpisode: 3 }),
      ],
      "zh",
    );
    expect(bad.map((i) => i.next)).toEqual([null, null, null]);
  });

  test("each language gets its own title, and any title beats an empty anchor", () => {
    const zh = toSeasonalItems([FULL], "zh")[0];
    const en = toSeasonalItems([FULL], "en")[0];
    expect(zh.title).toBe("药屋少女的呢喃 第三季");
    expect(en.title).toBe("The Apothecary Diaries Season 3");
    // English stops at romaji on its own ladder; the item falls through to
    // the Japanese title rather than rendering a link with no text.
    const onlyNative = toSeasonalItems([row({ anilistId: 9, titleNative: "ひとりごと" })], "en")[0];
    expect(onlyNative.title).toBe("ひとりごと");
  });

  test("the search haystack holds every title, lower-cased", () => {
    const [item] = toSeasonalItems([FULL], "en");
    for (const t of ["药屋少女", "薬屋のひとりごと", "kusuriya no hitorigoto", "the apothecary diaries"]) {
      expect(item.haystack).toContain(t);
    }
  });

  test("the synopsis is the reader's, as plain text without credit lines", () => {
    const [zh] = toSeasonalItems([FULL], "zh");
    expect(zh.synopsis).toBe("猫猫回到了花街。 某天……");
    const [en] = toSeasonalItems([FULL], "en");
    expect(en.synopsis).toBe("Maomao returns.");
  });

  test("a row whose genres are null has none, and still renders", () => {
    const [item] = toSeasonalItems([row({ anilistId: 13, titleChinese: "无类型", genres: null })], "zh");
    expect(item.genres).toEqual([]);
    expect(item.title).toBe("无类型");
  });

  test("an adult genre never reaches a pill", () => {
    const [item] = toSeasonalItems([row({ anilistId: 10, genres: ["Hentai", "Romance"] })], "zh");
    expect(item.genres).toEqual(["Romance"]);
  });

  test("a repeated id is kept once; rank is the API's order", () => {
    const items = toSeasonalItems(
      [row({ anilistId: 30, titleChinese: "丙" }), row({ anilistId: 10, titleChinese: "甲" }), row({ anilistId: 30, titleChinese: "丙" })],
      "zh",
    );
    expect(items.map((i) => [i.id, i.rank])).toEqual([
      [30, 0],
      [10, 1],
    ]);
  });

  test("the title order is decided here, by the reader's collation", () => {
    const items = toSeasonalItems(
      [
        row({ anilistId: 1, titleEnglish: "gamma" }),
        row({ anilistId: 2, titleEnglish: "Alpha" }),
        row({ anilistId: 3, titleEnglish: "beta" }),
      ],
      "en",
    );
    const byRank = [...items].sort((a, b) => a.titleRank - b.titleRank).map((i) => i.title);
    expect(byRank).toEqual(["Alpha", "beta", "gamma"]);
  });

  test("zero and negative counts: zero is a count, negative is noise", () => {
    const [item] = toSeasonalItems([row({ anilistId: 11, popularity: 0, favourites: -3 })], "zh");
    expect(item.popularity).toBe(0);
    expect(item.favourites).toBeNull();
  });

  test("the brand fallback accent is no colour", () => {
    const [item] = toSeasonalItems([row({ anilistId: 12, posterAccent: "#8b5cf6" })], "zh");
    expect(item.hue).toBeNull();
  });
});

describe("seasonRowsOf", () => {
  test("counts what came back, never pagination.total", () => {
    // The cold path's envelope: one AniList page, and a total that is not a count of it.
    const data = Array.from({ length: 50 }, (_, i) => row({ anilistId: 100 + i }));
    const envelope = { data, pagination: { page: 1, perPage: 200, total: 5000, totalPages: 25 } };
    expect(seasonRowsOf(envelope)).toHaveLength(50);
    expect(toSeasonalItems(seasonRowsOf(envelope), "zh")).toHaveLength(50);
  });

  test("an envelope without data is an empty season", () => {
    expect(seasonRowsOf({ data: null })).toEqual([]);
    expect(seasonRowsOf(null)).toEqual([]);
    expect(seasonRowsOf(undefined)).toEqual([]);
  });
});

describe("leftovers the listing can carry", () => {
  test("a finished or cancelled show's stored next episode is not a schedule", () => {
    const next = { nextAiringAt: "2026-10-20T14:00:00Z", nextAiringEpisode: 13 };
    const [finished] = toSeasonalItems([row({ anilistId: 1, status: "FINISHED", ...next })], "zh");
    const [cancelled] = toSeasonalItems([row({ anilistId: 2, status: "CANCELLED", ...next })], "zh");
    const [airing] = toSeasonalItems([row({ anilistId: 3, status: "RELEASING", ...next })], "zh");
    expect(finished.next).toBeNull();
    expect(cancelled.next).toBeNull();
    expect(airing.next).toEqual({ at: Date.parse("2026-10-20T14:00:00Z"), ep: 13 });
  });

  test("a premiere date this season cannot have is a leftover of a postponement", () => {
    const winter = { season: "WINTER", year: 2027 };
    const items = toSeasonalItems(
      [
        row({ anilistId: 1, startDate: "2026-10-05" }), // the autumn date it was moved from
        row({ anilistId: 2, startDate: "2027-01-08" }),
        row({ anilistId: 3, startDate: "2026-12-26" }), // a late-December premiere is still winter's
        row({ anilistId: 4, startDate: "2027-05-30" }), // two months past March: a late start
        row({ anilistId: 5, startDate: "2027-07-01" }),
      ],
      "zh",
      winter,
    );
    expect(items.map((i) => i.start)).toEqual([null, "2027-01-08", "2026-12-26", "2027-05-30", null]);
    // Without a season the date is taken as it is.
    expect(toSeasonalItems([row({ anilistId: 1, startDate: "2026-10-05" })], "zh")[0].start).toBe("2026-10-05");
  });
});
