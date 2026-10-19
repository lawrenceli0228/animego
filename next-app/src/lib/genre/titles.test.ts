import { describe, expect, test } from "bun:test";

import { LANGS } from "@/lib/i18n/lang";
import {
  decadeGhost,
  decadeTileLabel,
  decadeTitleLabel,
  gridHeading,
  gridMetaTitle,
  gridViewLabel,
  listLabel,
} from "./titles";
import { DECADE_KEYS, LIST_KEYS } from "./views";

describe("slice names in every language", () => {
  test("lists", () => {
    expect(LIST_KEYS.map((l) => listLabel(l, "zh"))).toEqual(["正在连载", "人气最高", "近年新作", "经典老番", "评分排行"]);
    expect(LIST_KEYS.map((l) => listLabel(l, "en"))).toEqual(["Airing now", "Most popular", "Recent", "Classics", "Top rated"]);
    expect(LIST_KEYS.map((l) => listLabel(l, "zh-Hant"))).toEqual(["正在連載", "人氣最高", "近年新作", "經典老番", "評分排行"]);
  });

  test("decades, on a tile and in a heading", () => {
    expect(decadeTileLabel("1990", "zh")).toBe("1990 年代");
    expect(decadeTileLabel("old", "zh")).toBe("更早");
    expect(decadeTitleLabel("old", "zh")).toBe("1970 年以前");
    expect(decadeTileLabel("2020", "en")).toBe("2020s");
    expect(decadeTitleLabel("old", "en")).toBe("Before 1970");
    expect(decadeTileLabel("old", "zh-Hant")).toBe("更早");
    expect(decadeTitleLabel("1980", "zh-Hant")).toBe("1980 年代");
  });

  test("every name is non-empty in every language", () => {
    for (const lang of LANGS) {
      for (const l of LIST_KEYS) expect(listLabel(l, lang).length).toBeGreaterThan(0);
      for (const d of DECADE_KEYS) {
        expect(decadeTileLabel(d, lang).length).toBeGreaterThan(0);
        expect(decadeTitleLabel(d, lang).length).toBeGreaterThan(0);
      }
    }
  });

  test("the ghost numeral of a tile with no cover", () => {
    expect(decadeGhost("1990")).toBe("90");
    expect(decadeGhost("2000")).toBe("00");
    expect(decadeGhost("old")).toBe("<70");
  });
});

describe("the grid's heading", () => {
  test("a genre and its slice are joined with ·, two genres with ×", () => {
    expect(gridHeading("Action", { kind: "list", list: "airing" }, "zh")).toBe("动作 · 正在连载");
    expect(gridHeading("Action", { kind: "decade", decade: "1990" }, "zh")).toBe("动作 · 1990 年代");
    expect(gridHeading("Action", { kind: "with", with: "Fantasy" }, "zh")).toBe("动作 × 奇幻");
    expect(gridHeading("Action", { kind: "list", list: "top" }, "zh")).toBe("动作 · 评分排行");
    expect(gridHeading("Romance", { kind: "with", with: "Slice of Life" }, "en")).toBe("Romance × Slice of Life");
    expect(gridHeading("Sci-Fi", { kind: "decade", decade: "old" }, "en")).toBe("Sci-Fi · Before 1970");
    expect(gridHeading("Sci-Fi", { kind: "list", list: "classic" }, "zh-Hant")).toBe("科幻 · 經典老番");
    expect(gridHeading("Mecha", { kind: "with", with: "Sports" }, "zh-Hant")).toBe("機戰 × 運動");
  });

  test("the view label alone", () => {
    expect(gridViewLabel({ kind: "with", with: "Romance" }, "zh-Hant")).toBe("戀愛");
    expect(gridViewLabel({ kind: "decade", decade: "old" }, "zh")).toBe("1970 年以前");
  });
});

describe("the grid's <title>", () => {
  test("the hub's heading and the slice, and the page past the first", () => {
    expect(gridMetaTitle("Action", { kind: "list", list: "airing" }, 1, "zh")).toBe("动作番剧 · 正在连载");
    expect(gridMetaTitle("Action", { kind: "list", list: "popular" }, 3, "zh")).toBe("动作番剧 · 人气最高 · 3");
    expect(gridMetaTitle("Action", { kind: "with", with: "Fantasy" }, 1, "zh")).toBe("动作番剧 × 奇幻");
    expect(gridMetaTitle("Action", { kind: "decade", decade: "1990" }, 2, "en")).toBe("Action Anime · 1990s · 2");
    expect(gridMetaTitle("Romance", { kind: "list", list: "top" }, 1, "zh-Hant")).toBe("戀愛番劇 · 評分排行");
  });
});
