import { describe, expect, test } from "bun:test";
import { row, rows } from "@/lib/test-utils/genreFixtures";
import { parseTopRows, toTopItems } from "./items";
import { isRankable } from "./rules";

describe("parseTopRows", () => {
  test("objects with an id only, at most a hundred", () => {
    const many = rows(1, 130);
    expect(parseTopRows(many)).toHaveLength(100);
    expect(parseTopRows([null, 3, { anilistId: "x" }, row({ anilistId: 7 })]).map((r) => r.anilistId)).toEqual([7]);
    expect(parseTopRows({ data: [] })).toEqual([]);
  });
});

describe("toTopItems", () => {
  test("each show's place is the API's rank, its position when the rank is missing or absurd", () => {
    const items = toTopItems(
      [
        { ...row({ anilistId: 11 }), rank: 1 },
        { ...row({ anilistId: 12 }), rank: 2 },
        row({ anilistId: 13 }),
        { ...row({ anilistId: 14 }), rank: -4 },
      ],
      "zh",
    );
    expect(items.map((i) => [i.id, i.place])).toEqual([
      [11, 1],
      [12, 2],
      [13, 3],
      [14, 4],
    ]);
  });

  test("keeps the synopsis (the chart view prints it) and adds the year and season", () => {
    const [item] = toTopItems(
      [{ ...row({ anilistId: 21, description: "A <b>long</b> story.", season: null, seasonYear: null, startDate: "2016-08-26" }), rank: 1 }],
      "zh",
    );
    expect(item.synopsis).toBe("A long story.");
    expect(item.year).toBe(2016);
    expect(item.season).toBeNull();
  });

  test("a repeated show is drawn once", () => {
    expect(toTopItems([row({ anilistId: 5 }), row({ anilistId: 5 })], "en")).toHaveLength(1);
  });
});

describe("isRankable", () => {
  const ranked = { isAdult: false, averageScore: 80, popularity: 1000, format: "TV" };
  test("rated, tracked by a thousand, not adult, not a music video", () => {
    expect(isRankable(ranked)).toBe(true);
    expect(isRankable({ ...ranked, format: null })).toBe(true);
    expect(isRankable({ ...ranked, popularity: 999 })).toBe(false);
    expect(isRankable({ ...ranked, averageScore: 0 })).toBe(false);
    expect(isRankable({ ...ranked, averageScore: null })).toBe(false);
    expect(isRankable({ ...ranked, isAdult: true })).toBe(false);
    expect(isRankable({ ...ranked, format: "MUSIC" })).toBe(false);
    expect(isRankable({ averageScore: 80, format: "TV" })).toBe(false);
  });
});
