import { describe, expect, test } from "bun:test";

import { row } from "@/lib/test-utils/genreFixtures";
import { browseFilter } from "./api";
import { buildGridData, hasPageAfter, titlesAfter } from "./grid";
import { MAX_GRID_PAGE } from "./views";

describe("the pages after this one", () => {
  test("titles left after a page", () => {
    expect(titlesAfter(100, 1)).toBe(64);
    expect(titlesAfter(100, 2)).toBe(28);
    expect(titlesAfter(100, 3)).toBe(0);
    expect(titlesAfter(30, 1)).toBe(0);
  });

  test("a next page exists while titles are left, up to the API's last page", () => {
    expect(hasPageAfter(100, 2)).toBe(true);
    expect(hasPageAfter(100, 3)).toBe(false);
    expect(hasPageAfter(36, 1)).toBe(false);
    expect(hasPageAfter(1_000_000, MAX_GRID_PAGE)).toBe(false);
  });
});

describe("buildGridData", () => {
  test("the page's items, the total and the request for the next ones", () => {
    const filter = browseFilter("Action", { kind: "list", list: "airing" }, 2020);
    const data = buildGridData(
      { kind: "list", list: "airing" },
      2,
      false,
      filter,
      { rows: [row({ anilistId: 9 }), row({ anilistId: 8 })], total: 80 },
      "zh",
    );
    expect(data).toMatchObject({ kind: "grid", page: 2, legacy: false, total: 80, filter });
    expect(data.items.map((i) => i.id)).toEqual([9, 8]);
  });
});
