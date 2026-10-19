import { describe, expect, test } from "bun:test";

import { overviewWire, row } from "@/lib/test-utils/genreFixtures";
import { countOf, parseBrowsePage, parseOverview, rowsOf } from "./overview";

describe("parseOverview", () => {
  test("reads the overview out of its { data } envelope", () => {
    const got = parseOverview({ data: overviewWire() }, "Action");
    expect(got).not.toBeNull();
    expect(got?.total).toBe(5241);
    expect(got?.airing).toBe(84);
    expect(got?.recentFrom).toBe(2020);
    expect(got?.lists.airing.items).toHaveLength(6);
    expect(got?.lists.top.items).toHaveLength(10);
    expect(got?.decades.map((d) => d.key)).toEqual(["2020", "2010", "old"]);
    expect(got?.related.map((r) => r.genre)).toEqual(["Fantasy", "Sci-Fi"]);
    expect(got?.studios.map((s) => s.studio)).toEqual(["Toei Animation", "MAPPA"]);
  });

  test("the bare object works too; anything that is not one is null", () => {
    expect(parseOverview(overviewWire(), "Action")?.total).toBe(5241);
    expect(parseOverview(null, "Action")).toBeNull();
    expect(parseOverview("oops", "Action")).toBeNull();
    expect(parseOverview([], "Action")).toBeNull();
  });

  test("a missing list is empty, not an error", () => {
    const wire = overviewWire();
    delete (wire.lists as Record<string, unknown>).recent;
    (wire.lists as Record<string, unknown>).classic = { count: "many", items: "none" };
    const got = parseOverview(wire, "Action");
    expect(got?.lists.recent).toEqual({ count: 0, items: [] });
    expect(got?.lists.classic).toEqual({ count: 0, items: [] });
  });

  test("decades: unknown keys, empty buckets and repeats are dropped, newest first", () => {
    const got = parseOverview(
      {
        decades: [
          { key: "old", count: 5, covers: [] },
          { key: "1990", count: 3, covers: [] },
          { key: "2030", count: 9, covers: [] },
          { key: "1980", count: 0, covers: [] },
          { key: "1990", count: 7, covers: [] },
          { key: "constructor", count: 1, covers: [] },
          { key: "2020", count: 2 },
        ],
      },
      "Action",
    );
    expect(got?.decades.map((d) => [d.key, d.count])).toEqual([
      ["2020", 2],
      ["1990", 3],
      ["old", 5],
    ]);
    expect(got?.decades[0]?.covers).toEqual([]);
  });

  test("related: only genres the site has a page for, never the page's own, never the adult one", () => {
    const got = parseOverview(
      {
        related: [
          { genre: "Action", count: 50, covers: [] },
          { genre: "Hentai", count: 40, covers: [] },
          { genre: "Kids", count: 30, covers: [] },
          { genre: "Fantasy", count: 20, covers: [] },
          { genre: "Fantasy", count: 10, covers: [] },
        ],
      },
      "Action",
    );
    expect(got?.related.map((r) => [r.genre, r.count])).toEqual([["Fantasy", 20]]);
  });

  test("studios: a name and a count, trimmed, once each", () => {
    const got = parseOverview(
      {
        studios: [
          { studio: "  MAPPA ", count: 9, covers: [{ anilistId: 1, coverImageUrl: "u", posterAccent: 5 }] },
          { studio: "", count: 9, covers: [] },
          { studio: "MAPPA", count: 3, covers: [] },
          { studio: "Bones", count: -1, covers: [] },
        ],
      },
      "Action",
    );
    expect(got?.studios.map((s) => s.studio)).toEqual(["MAPPA"]);
    // A cover whose accent is not a string keeps its image and loses the accent.
    expect(got?.studios[0]?.covers).toEqual([{ anilistId: 1, coverImageUrl: "u", posterAccent: null }]);
  });

  test("a recentFrom that is not a year is unknown", () => {
    expect(parseOverview({ recentFrom: "2020" }, "Action")?.recentFrom).toBeNull();
  });
});

describe("parseBrowsePage", () => {
  test("rows and the total out of the envelope", () => {
    const got = parseBrowsePage({
      data: [row({ anilistId: 1 }), { nope: true }, row({ anilistId: 2 })],
      pagination: { page: 1, perPage: 36, total: 77, totalPages: 3 },
    });
    expect(got.rows.map((r) => r.anilistId)).toEqual([1, 2]);
    expect(got.total).toBe(77);
  });

  test("anything else is an empty page", () => {
    expect(parseBrowsePage(null)).toEqual({ rows: [], total: 0 });
    expect(parseBrowsePage({ data: "x" })).toEqual({ rows: [], total: 0 });
  });
});

describe("the small readers", () => {
  test("countOf", () => {
    expect(countOf(3)).toBe(3);
    expect(countOf(3.7)).toBe(3);
    expect(countOf(-1)).toBe(0);
    expect(countOf("3")).toBe(0);
  });

  test("rowsOf", () => {
    expect(rowsOf([{ anilistId: 1 }, null, 5, { anilistId: "2" }])).toHaveLength(1);
    expect(rowsOf(undefined)).toEqual([]);
  });
});
