import { describe, expect, test } from "bun:test";

import { HOUR_MS, NOW } from "@/lib/test-utils/seasonalItems";
import zhSpa from "@/locales/zh-spa.js";
import enSpa from "@/locales/en-spa.js";
import type { CardCopy } from "@/lib/seasonal/display";
import { genreAiringText, rankSubLine, yearSeasonText, type GenreCardCopy } from "./display";
import type { GenreItem } from "./items";

type Spa = { seasonPage: CardCopy & { yearOption: string }; genrePage: { yearSeason: string; released: string } };

function copyOf(dict: unknown): GenreCardCopy {
  const d = dict as Spa;
  return { ...d.seasonPage, yearSeason: d.genrePage.yearSeason, yearOnly: d.seasonPage.yearOption, released: d.genrePage.released };
}

const ZH = copyOf(zhSpa);
const EN = copyOf(enSpa);

function show(overrides: Partial<GenreItem> = {}): GenreItem {
  return {
    id: 1,
    title: "测试番",
    haystack: "",
    rank: 0,
    titleRank: 0,
    cover: null,
    hue: null,
    score: 80,
    bangumi: null,
    format: "TV",
    status: "FINISHED",
    episodes: 25,
    duration: 24,
    genres: [],
    studio: null,
    next: null,
    popularity: null,
    favourites: null,
    source: null,
    start: null,
    sequel: null,
    synopsis: "",
    year: 2019,
    season: "SPRING",
    ...overrides,
  };
}

describe("genreAiringText", () => {
  test("a finished show says when it is from and how long it ran", () => {
    expect(genreAiringText(show(), NOW, ZH, "zh")).toBe("2019 年 春季 · 全 25 集");
    expect(genreAiringText(show(), NOW, EN, "en")).toBe("Spring 2019 · 25 eps");
  });

  test("a film that is out, a show with no season, a show not yet out", () => {
    expect(genreAiringText(show({ format: "MOVIE", episodes: 1 }), NOW, ZH, "zh")).toBe("2019 年 春季 · 已上映");
    expect(genreAiringText(show({ season: null }), NOW, ZH, "zh")).toBe("2019 年 · 全 25 集");
    expect(genreAiringText(show({ status: "NOT_YET_RELEASED", year: 2027, season: "WINTER" }), NOW, ZH, "zh")).toBe(
      "2027 年 冬季 · 未开播",
    );
    expect(genreAiringText(show({ year: null, season: null, episodes: null }), NOW, ZH, "zh")).toBe("已完结");
  });

  test("a show on air says when the next episode is, as on the seasonal page", () => {
    const airing = show({ status: "RELEASING", next: { at: NOW + 50 * HOUR_MS, ep: 4 } });
    expect(genreAiringText(airing, NOW, ZH, "zh")).toBe("第 4 集 · 2 天后");
    expect(genreAiringText(airing, NOW, ZH, "zh", "short")).toBe("第 4 集 · 2 天后");
  });

  test("on air with nothing scheduled: its year and 连载中", () => {
    expect(genreAiringText(show({ status: "RELEASING", year: 2026, season: "FALL" }), NOW, ZH, "zh")).toBe(
      "2026 年 秋季 · 连载中",
    );
  });

  test("the phone's short line is the year and the format", () => {
    expect(genreAiringText(show(), NOW, ZH, "zh", "short")).toBe("2019 · TV");
    expect(genreAiringText(show({ format: "MOVIE" }), NOW, ZH, "zh", "short")).toBe("2019 · 剧场版");
    expect(genreAiringText(show({ year: null }), NOW, EN, "en", "short")).toBe("TV");
  });

  test("a seasonal item, which has no year, falls back to how it stands", () => {
    const seasonal: Record<string, unknown> = { ...show() };
    delete seasonal.year;
    delete seasonal.season;
    expect(genreAiringText(seasonal as never, NOW, ZH, "zh")).toBe("全 25 集");
  });
});

describe("yearSeasonText", () => {
  test("zh-style and en-style", () => {
    expect(yearSeasonText(show(), ZH, "zh")).toBe("2019 年 春季");
    expect(yearSeasonText(show({ season: "FALL" }), EN, "en")).toBe("Fall 2019");
    expect(yearSeasonText(show({ year: null }), ZH, "zh")).toBe("");
  });
});

describe("rankSubLine", () => {
  test("year, format and episodes, or a film's runtime", () => {
    expect(rankSubLine(show(), ZH, "zh")).toBe("2019 · TV · 25 集");
    expect(rankSubLine(show({ format: "MOVIE", duration: 107, year: 2016 }), ZH, "zh")).toBe("2016 · 剧场版 · 1 小时 47 分");
    expect(rankSubLine(show({ year: null, episodes: null }), EN, "en")).toBe("TV");
  });
});
