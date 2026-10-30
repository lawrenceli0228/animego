import { describe, expect, test } from "bun:test";
import {
  episodeLabel,
  fansubCells,
  matchesSubFilter,
  toRows,
  visibleRows,
  type TorrentItem,
} from "./list";

// The magnets here are placeholders: nothing in this module reads them
// except as an identity, and the repository must not carry real ones.
function item(title: string, fansub: string | null, extra: Partial<TorrentItem> = {}): TorrentItem {
  return {
    title,
    magnet: `magnet:?xt=urn:btih:${"0".repeat(39)}${title.length % 10}&dn=${encodeURIComponent(title)}`,
    size: "1.2 GB",
    fansub,
    date: "2026-08-22T13:17:35Z",
    source: "dmhy",
    ...extra,
  };
}

const ITEMS: TorrentItem[] = [
  item("[A组] Show - 01 [简繁内封]", "A组"),
  item("[B组] Show - 01 [简体]", "B组"),
  item("[A组] Show - 02 [简繁内封]", "A组"),
  item("[C组] Show - 01 [繁體]", "C组"),
  item("[B组] Show - 02 [简体]", "B组"),
  item("Show - 03 [CHT]", null),
  item("[A组] Show - 03 [简繁内封]", "A组"),
];

describe("toRows", () => {
  test("keeps the server's order and builds every display field once", () => {
    const rows = toRows(ITEMS);
    expect(rows.map((r) => r.fansub)).toEqual(["A组", "B组", "A组", "C组", "B组", "", "A组"]);
    expect(rows[0].title).toBe("Show - 01 [简繁内封]");
    expect(rows[0].facts.script).toBe("both");
    expect(rows[0].size).toBe("1.2 GB");
    expect(rows[0].date).toMatch(/^2026-08-2[23]$/);
  });

  test("keys are unique even when two rows share a magnet", () => {
    const twin = item("[A组] Show - 01", "A组", { infohash: "abc" });
    const rows = toRows([twin, { ...twin }]);
    expect(rows.map((r) => r.key)).toEqual(["abc", "abc#1"]);
  });

  test("rows without a title or magnet are dropped, not crashed on", () => {
    const broken = { title: null, magnet: "x" } as unknown as TorrentItem;
    expect(toRows([broken, item("[A组] Show - 01", "A组")])).toHaveLength(1);
  });

  test("an unusable size or date shows nothing", () => {
    const [row] = toRows([item("[A组] Show - 01", "A组", { size: "0 KB", date: null })]);
    expect(row.size).toBe("");
    expect(row.date).toBe("");
  });
});

describe("matchesSubFilter", () => {
  test("简体 and 繁体 each include 简繁; 简繁 is only 简繁", () => {
    expect(matchesSubFilter("both", "simp")).toBe(true);
    expect(matchesSubFilter("both", "trad")).toBe(true);
    expect(matchesSubFilter("simp", "both")).toBe(false);
    expect(matchesSubFilter("trad", "simp")).toBe(false);
    expect(matchesSubFilter(null, "simp")).toBe(false);
    expect(matchesSubFilter(null, "all")).toBe(true);
  });
});

describe("fansubCells", () => {
  const rows = toRows(ITEMS);

  test("all first, then groups by count, ties in order of first appearance", () => {
    expect(fansubCells(rows, "all", null)).toEqual([
      { key: null, count: 7 },
      { key: "A组", count: 3 },
      { key: "B组", count: 2 },
      { key: "C组", count: 1 },
      { key: "", count: 1 },
    ]);
  });

  test("counts follow the subtitle filter", () => {
    expect(fansubCells(rows, "trad", null)).toEqual([
      { key: null, count: 5 },
      { key: "A组", count: 3 },
      { key: "C组", count: 1 },
      { key: "", count: 1 },
    ]);
  });

  test("a selected group the filter empties stays, at 0", () => {
    expect(fansubCells(rows, "trad", "B组").at(-1)).toEqual({ key: "B组", count: 0 });
  });
});

describe("visibleRows", () => {
  const rows = toRows(ITEMS);
  test("filter and group cut together", () => {
    expect(visibleRows(rows, "simp", "A组").map((r) => r.title)).toEqual([
      "Show - 01 [简繁内封]",
      "Show - 02 [简繁内封]",
      "Show - 03 [简繁内封]",
    ]);
    expect(visibleRows(rows, "all", "").map((r) => r.title)).toEqual(["Show - 03 [CHT]"]);
    expect(visibleRows(rows, "both", "B组")).toEqual([]);
  });
});

describe("episodeLabel", () => {
  const single = (n: number) => ({ kind: "single" as const, n });

  test("a number inside the season is shown as is", () => {
    expect(episodeLabel(single(7), 10, 28)).toEqual(single(7));
    expect(episodeLabel(single(10), 10, undefined)).toEqual(single(10));
  });

  test("Frieren S2 [38] with 28 before it → episode 10", () => {
    expect(episodeLabel(single(38), 10, 28)).toEqual(single(10));
    expect(episodeLabel(single(29), 10, 28)).toEqual(single(1));
  });

  test("past the season with no offset to explain it → no tag", () => {
    expect(episodeLabel(single(38), 10, undefined)).toBeNull();
    expect(episodeLabel(single(38), 10, 0)).toBeNull();
    expect(episodeLabel(single(50), 10, 28)).toBeNull();
  });

  test("season length unknown: past the offset reads as continuous", () => {
    expect(episodeLabel(single(85), null, 66)).toEqual(single(19));
    expect(episodeLabel(single(19), null, 66)).toEqual(single(19));
    expect(episodeLabel(single(19), null, undefined)).toEqual(single(19));
  });

  test("batches and unstated pass through", () => {
    expect(episodeLabel({ kind: "batch" }, 10, 28)).toEqual({ kind: "batch" });
    expect(episodeLabel(null, 10, 28)).toBeNull();
  });
});
