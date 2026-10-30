import { describe, expect, test } from "bun:test";

import type { FollowSlotProps } from "@/components/seasonal/browse/types";
import type { Lang } from "@/lib/i18n/lang";
import { LanguageProvider } from "@/lib/lang-client";
import { row } from "@/lib/test-utils/genreFixtures";
import { renderAsNextDev } from "@/lib/test-utils/nextImage";
import { NOW } from "@/lib/test-utils/seasonalItems";
import type { TopPageData } from "@/lib/top/data";
import { toTopItems, type TopRow } from "@/lib/top/items";
import { NO_FILTERS, type TopState } from "@/lib/top/query";
import { stripYears } from "@/lib/top/years";
import TopView from "./TopView";

// The server HTML of a ranking page's client tree — what a crawler reads and
// what hydration starts from (renderToStaticMarkup, the server snapshot of the
// clock and of the layout: a desktop). Through renderAsNextDev, so next/image
// checks every cover as `next dev` does. The follow buttons are a stub (see
// components/seasonal/browse/types.ts).

function StubFollow({ anilistId }: FollowSlotProps) {
  return <i data-stub-follow={anilistId} />;
}

const YEARS = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016, 2015, 2014, 2013, 1999, 1988].map((year) => ({
  year,
  count: 120,
}));

/** `n` ranked rows, best first. */
function ranked(n: number, from = 5000): TopRow[] {
  return Array.from({ length: n }, (_, i) => ({
    ...row({ anilistId: from + i, averageScore: 95 - Math.floor(i / 4), popularity: 90_000 - i, titleChinese: `排行番 ${i + 1}` }),
    rank: i + 1,
  }));
}

function data(state: Partial<TopState>, n: number, lang: Lang = "zh"): TopPageData {
  const full: TopState = { year: null, ...NO_FILTERS, view: "grid", ...state };
  return { state: full, items: toTopItems(ranked(n), lang), strip: stripYears(YEARS, 2026) };
}

function render(d: TopPageData, lang: Lang = "zh"): string {
  return renderAsNextDev(
    <LanguageProvider lang={lang}>
      <TopView data={d} serverNowMs={NOW} Follow={StubFollow} />
    </LanguageProvider>,
  );
}

/** The anime title links, in document order: [id, text]. */
function titleLinks(html: string): Array<[number, string]> {
  return [...html.matchAll(/<a [^>]*href="\/anime\/(\d+)"[^>]*>(?!<span[^>]*><img)((?:(?!<\/a>).)*)<\/a>/g)]
    .filter((m) => !m[0].includes('tabindex="-1"'))
    .map((m) => [Number(m[1]), m[2].replace(/<[^>]+>/g, "")]);
}

const section = (html: string, marker: string) => {
  const at = html.indexOf(marker);
  return html.slice(at, html.indexOf("</nav>", at));
};

describe("the ranking's server HTML", () => {
  test("one h1: 历代 Top 100, a year's, and in English", () => {
    const html = render(data({}, 30));
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>历代 Top 100<\/h1>/);
    expect(render(data({ year: 2019 }, 30))).toMatch(/<h1[^>]*>2019 年度 Top 100<\/h1>/);
    expect(render(data({ year: 2019 }, 30, "en"), "en")).toMatch(/<h1[^>]*>Top 100 Anime of 2019<\/h1>/);
  });

  test("every ranked show is a real link, in order, its place read before its name", () => {
    const html = render(data({}, 100));
    const links = titleLinks(html);
    expect(links).toHaveLength(100);
    links.forEach(([id, text], i) => {
      expect(id).toBe(5000 + i);
      expect(text).toBe(`第 ${i + 1} 名 排行番 ${i + 1}`);
    });
  });

  test("each cover carries its place in a disc the screen reader skips", () => {
    const html = render(data({}, 25));
    for (let n = 1; n <= 25; n += 1) expect(html).toContain(`aria-hidden="true" data-rank="${n}"><i>#</i>${n}</span>`);
    // No air-time badge on a ranking.
    expect(html).not.toContain("data-badge=");
  });

  test("twenty are shown and the rest wait behind 显示更多 · 还有 N 部", () => {
    const html = render(data({}, 100));
    const cards: string[] = html.match(/<div [^>]*data-anime-card="true"[^>]*>/g) ?? [];
    expect(cards).toHaveLength(100);
    expect(cards.filter((c) => c.includes("hidden")).length).toBe(80);
    expect(cards.slice(0, 20).every((c) => !c.includes("hidden"))).toBe(true);
    expect(html).toMatch(/data-load-more="true"[^>]*>显示更多<span[^>]*>还有 80 部<\/span>/);
    expect(render(data({}, 20))).not.toContain("data-load-more");
  });

  test("the strip: 历代, the years that have a ranking, 更早 — each a link, the page's own current", () => {
    const html = render(data({ year: 2019 }, 10));
    const strip = section(html, "data-top-strip");
    const hrefs = [...strip.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["/top", ...Array.from({ length: 13 }, (_, i) => `/top/${2026 - i}`)]);
    expect(strip.match(/aria-current="page"/g)).toHaveLength(1);
    expect(strip).toMatch(/aria-current="page"[^>]*href="\/top\/2019"/);
    expect(strip).toMatch(/aria-expanded="false"[^>]*>更早/);
    // The older years are links in the HTML too, hidden until 更早 opens them.
    expect(html).toMatch(/data-older-years="true" hidden=""|hidden=""[^>]*data-older-years/);
    expect(html).toContain('href="/top/1999"');
    expect(html).toContain('href="/top/1988"');
  });

  test("an older year shows itself in the 更早 cell, with the block under it", () => {
    const html = render(data({ year: 1999 }, 10));
    expect(html).toMatch(/aria-current="page"[^>]*data-on="true"[^>]*data-mono="true"[^>]*data-older="true"[^>]*>1999/);
    expect(html).toContain('style="--n:15;--i:14"');
  });

  test("filters are links that keep the rest of the ranking; a year has season chips, every year does not", () => {
    const all = render(data({ genre: "Action" }, 10));
    expect(all).toContain('href="/top?format=movie&amp;genre=action"');
    expect(all).toContain('href="/top?genre=action"');
    expect(all).not.toContain("season=");
    const year = render(data({ year: 2019, format: "TV" }, 10));
    expect(year).toContain('href="/top/2019?format=tv&amp;season=fall"');
    expect(year).toContain('href="/top/2019?format=tv&amp;genre=slice-of-life"');
    expect(year).toMatch(/aria-current="page" data-on="true" data-option="format:TV" href="\/top\/2019\?format=tv"/);
    // A year's link from the strip keeps the filters, never the season.
    const fall = render(data({ year: 2019, season: "FALL" }, 10));
    expect(fall).toContain('href="/top/2018"');
    expect(fall).not.toContain('href="/top/2018?season');
  });

  test("the chart view: the place above the score; the table view: a column of places", () => {
    const chart = render(data({ view: "chart" }, 30));
    expect(chart).toContain('data-charts="true"');
    expect(chart).toContain('aria-hidden="true" data-rank="1"><i>#</i>1</span>');
    // The chart card's link is its cover, with the title (and its place) inside.
    expect(chart).toContain("<span>第 1 名 </span>排行番 1</div>");
    const table = render(data({ view: "table" }, 30));
    expect(table).toContain('data-rows="true"');
    expect(table).toContain('aria-hidden="true" data-rank="30"><i>#</i>30</span>');
    expect(titleLinks(table)).toHaveLength(30);
  });

  test("a filter that leaves nothing: the empty state and a link back to the unfiltered ranking", () => {
    const html = render(data({ year: 2019, format: "OVA", view: "chart" }, 0));
    expect(html).toContain("没有符合条件的番剧");
    expect(html).toMatch(/href="\/top\/2019\?view=chart"[^>]*>清除筛选<\/a>/);
    expect(render(data({}, 0))).not.toContain("清除筛选");
  });
});
