import { describe, expect, test } from "bun:test";
import { airsIn, type AiringCopy } from "@/components/anime/airsIn";
import {
  ANILIST_TAG_MIN_RANK,
  DETAIL_SYNONYMS_SHOWN,
  DETAIL_TAGS_SHOWN,
  producers,
  scriptOf,
  visibleSynonyms,
  visibleTags,
} from "@/components/anime/detailFacts";
import type { AnimeDetail, DetailTag } from "@/lib/types";

function detailRow(over: Partial<AnimeDetail>): AnimeDetail {
  return {
    anilistId: 1,
    titleRomaji: "Sousou no Frieren",
    titleEnglish: "Frieren: Beyond Journey's End",
    titleNative: "葬送のフリーレン",
    titleChinese: "葬送的芙莉莲",
    studios: ["MADHOUSE"],
    ...over,
  } as AnimeDetail;
}

function tag(over: Partial<DetailTag> & { name: string }): DetailTag {
  return { source: "anilist", rank: 50, isSpoiler: false, ...over };
}

describe("visibleSynonyms", () => {
  test("drops the titles the page already prints, case- and space-insensitively", () => {
    const row = detailRow({
      synonyms: ["sousou no frieren", "Frieren at the Funeral", "葬送的芙莉莲", "  Frieren  at the Funeral "],
    });
    expect(visibleSynonyms(row, "en")).toEqual(["Frieren at the Funeral"]);
  });

  test("keeps order and caps at the shown count", () => {
    const row = detailRow({ synonyms: Array.from({ length: 20 }, (_, i) => `Alias ${i}`) });
    const out = visibleSynonyms(row, "en");
    expect(out).toHaveLength(DETAIL_SYNONYMS_SHOWN);
    expect(out[0]).toBe("Alias 0");
  });

  test("an older API build with no synonyms field yields an empty list", () => {
    expect(visibleSynonyms(detailRow({}), "zh")).toEqual([]);
  });

  // One Piece's real list: AniList orders by code point, so the Chinese name
  // is eleventh and would fall to the cap. Script order puts it first for zh.
  const onePiece = [
    "All'arrembaggio!", "OP", "Tutti all'arrembaggio!", "Vua Hải Tặc",
    "Ντρέηκ, το Κυνήγι του Θησαυρού", "Ван-Пис", "וואן פיס", "ون بيس", "วันพีซ",
    "ワンピース", "海贼王",
  ];

  test("zh leads with Han, then kana, then Latin, keeping AniList's order within a script", () => {
    const out = visibleSynonyms(detailRow({ titleChinese: "航海王", synonyms: onePiece }), "zh");
    expect(out.slice(0, 5)).toEqual(["海贼王", "ワンピース", "All'arrembaggio!", "OP", "Tutti all'arrembaggio!"]);
    expect(out).toHaveLength(DETAIL_SYNONYMS_SHOWN);
  });

  test("en leads with Latin and still keeps the CJK names inside the cap", () => {
    const out = visibleSynonyms(detailRow({ synonyms: onePiece }), "en");
    expect(out[0]).toBe("All'arrembaggio!");
    expect(out).toContain("海贼王");
    expect(out).toContain("ワンピース");
  });

  test("scriptOf reads the first letter, skipping punctuation and digits", () => {
    expect(scriptOf("海贼王")).toBe("han");
    expect(scriptOf("ワンピース")).toBe("kana");
    expect(scriptOf("장송의 프리렌")).toBe("hangul");
    expect(scriptOf("\"Frieren\"")).toBe("latin");
    expect(scriptOf("Ван-Пис")).toBe("other");
    expect(scriptOf("2.5")).toBe("other");
  });
});

describe("visibleTags", () => {
  const tags = [
    tag({ name: "Time Skip", rank: 12 }),
    tag({ name: "Female Protagonist", rank: 92 }),
    tag({ name: "Elf", rank: 88 }),
    tag({ name: "Ensemble Cast", rank: 61 }),
    tag({ name: "Tragedy", rank: 70, isSpoiler: true }),
    tag({ source: "bangumi", name: "奇幻", rank: 300 }),
    tag({ source: "bangumi", name: "治愈", rank: 120 }),
    tag({ source: "bangumi", name: "elf", rank: 40 }),
  ];

  test("zh leads with Bangumi by votes, then AniList by rank; spoilers and low ranks are out", () => {
    expect(visibleTags(detailRow({ tags }), "zh").map((t) => t.name)).toEqual([
      "奇幻",
      "治愈",
      "elf",
      "Female Protagonist",
      "Ensemble Cast",
    ]);
  });

  test("en leads with AniList", () => {
    expect(visibleTags(detailRow({ tags }), "en").map((t) => t.name)).toEqual([
      "Female Protagonist",
      "Elf",
      "Ensemble Cast",
      "奇幻",
      "治愈",
    ]);
  });

  test("the AniList floor is the exported constant", () => {
    const row = detailRow({
      tags: [tag({ name: "Just Under", rank: ANILIST_TAG_MIN_RANK - 1 }), tag({ name: "At", rank: ANILIST_TAG_MIN_RANK })],
    });
    expect(visibleTags(row, "en").map((t) => t.name)).toEqual(["At"]);
  });

  test("caps at the shown count", () => {
    const many = Array.from({ length: 40 }, (_, i) => tag({ name: `T${i}`, rank: 100 - i }));
    expect(visibleTags(detailRow({ tags: many }), "en")).toHaveLength(DETAIL_TAGS_SHOWN);
  });

  test("zh-Hant follows zh", () => {
    expect(visibleTags(detailRow({ tags }), "zh-Hant")[0].name).toBe("奇幻");
  });
});

describe("producers", () => {
  test("is every non-main studio not already named as a main one", () => {
    const row = detailRow({
      studios: ["MADHOUSE"],
      studioDetails: [
        { name: "MADHOUSE", studioId: 11, isMain: true },
        { name: "Toho", studioId: 1, isMain: false },
        { name: "Shogakukan", studioId: 2, isMain: false },
        { name: "Toho", studioId: 1, isMain: false },
        { name: "madhouse", studioId: 11, isMain: false },
      ],
    });
    expect(producers(row)).toEqual(["Toho", "Shogakukan"]);
  });

  test("a row not yet re-read has none", () => {
    expect(producers(detailRow({}))).toEqual([]);
  });
});

describe("airsIn", () => {
  const copy: AiringCopy = {
    nextEpisode: "第 {{ep}} 集",
    airsInDays: "{{n}} 天后",
    airsInHours: "{{n}} 小时后",
    airsInMinutes: "{{n}} 分钟后",
    airsSoon: "即将播出",
  };
  const now = Date.parse("2026-09-17T00:00:00Z");

  test("days, hours, minutes, then soon", () => {
    expect(airsIn(now + 3 * 86_400_000 + 5000, now, copy)).toBe("3 天后");
    expect(airsIn(now + 5 * 3_600_000, now, copy)).toBe("5 小时后");
    expect(airsIn(now + 7 * 60_000, now, copy)).toBe("7 分钟后");
    expect(airsIn(now + 30_000, now, copy)).toBe("即将播出");
  });

  test("an instant that has passed is null, not a negative count", () => {
    expect(airsIn(now - 1, now, copy)).toBeNull();
    expect(airsIn(now, now, copy)).toBeNull();
  });

  test("garbage is null", () => {
    expect(airsIn(Number.NaN, now, copy)).toBeNull();
  });
});
