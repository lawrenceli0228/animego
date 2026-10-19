import { describe, expect, test } from "bun:test";

import { FILTER_GENRES } from "@/lib/contentLabels";
import { browseFilter } from "@/lib/genre/api";
import { buildGridData, type GenrePageData } from "@/lib/genre/grid";
import { EMPTY_HUB, buildHubData } from "@/lib/genre/hub";
import { parseOverview } from "@/lib/genre/overview";
import { stripEntries } from "@/lib/genre/strip";
import { genreSlug } from "@/lib/hubs/paths";
import type { Lang } from "@/lib/i18n/lang";
import { LanguageProvider } from "@/lib/lang-client";
import type { GridView as GridSlice } from "@/lib/genre/views";
import { overviewWire, rows } from "@/lib/test-utils/genreFixtures";
import { renderAsNextDev } from "@/lib/test-utils/nextImage";
import { NOW } from "@/lib/test-utils/seasonalItems";
import type { FollowSlotProps } from "@/components/seasonal/browse/types";
import GenreView from "./GenreView";

// The server HTML of the genre page's client tree — what a crawler reads and
// what hydration starts from. renderToStaticMarkup, no DOM: the server
// snapshot of the clock and the layout (desktop) is what renders. Through
// renderAsNextDev, so next/image checks every cover's src as `next dev` does
// (it throws there on one it refuses).
//
// The follow buttons are a stub: the real one pulls in react-hot-toast, which
// touches `document` on import (see components/seasonal/browse/types.ts).

function StubFollow({ anilistId }: FollowSlotProps) {
  return <i data-stub-follow={anilistId} />;
}

const STRIP = stripEntries({
  genres: FILTER_GENRES.map((key, i) => ({ key, count: 1000 + i * 1111 })),
});

function render(data: GenrePageData, lang: Lang = "zh", genre: (typeof FILTER_GENRES)[number] = "Action"): string {
  return renderAsNextDev(
    <LanguageProvider lang={lang}>
      <GenreView genre={genre} data={data} strip={STRIP} serverNowMs={NOW} Follow={StubFollow} />
    </LanguageProvider>,
  );
}

const hubData = (lang: Lang = "zh") => buildHubData(parseOverview(overviewWire(), "Action"), lang);

function gridData(view: GridSlice, page: number, total: number, n: number, legacy = false) {
  const filter = browseFilter("Action", view, 2020);
  return buildGridData(view, page, legacy, filter, { rows: rows(9000 + (page - 1) * 36, n), total }, "zh");
}

const esc = (s: string) => s.replace(/&/g, "&amp;");

describe("the hub's server HTML", () => {
  test("one h1, the genre's heading, and the count line", () => {
    const html = render(hubData());
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>动作番剧<\/h1>/);
    expect(html).toMatch(/data-count="true"[^>]*>5,241 部 · 84 部连载中</);
  });

  test("the strip links every one of the eighteen genres, the current one marked", () => {
    const html = render(hubData());
    const strip = html.slice(html.indexOf("data-genre-strip"), html.indexOf("</nav>", html.indexOf("data-genre-strip")));
    const links = strip.match(/<a [^>]*href="\/genre\/[^"]+"/g) ?? [];
    expect(links).toHaveLength(18);
    for (const g of FILTER_GENRES) expect(strip).toContain(`href="/genre/${genreSlug(g)}"`);
    expect(strip).toMatch(/aria-current="page"[^>]*data-genre="action"|href="\/genre\/action"[^>]*aria-current="page"/);
    expect(strip.match(/aria-current="page"/g)).toHaveLength(1);
    // The count under each name, grouped.
    expect(strip).toMatch(/aria-label="动作，1,000 部"/);
    expect(strip).toContain(">1,000</span>");
  });

  test("every rail card is a real link with its title; a rail with fewer than four is left out", () => {
    const data = hubData();
    const html = render(data);
    expect(data.kind === "hub" && data.rails.map((r) => r.key)).toEqual(["airing", "popular", "recent"]);
    if (data.kind !== "hub") return;
    for (const rail of data.rails) {
      for (const item of rail.items) expect(html).toContain(`href="/anime/${item.id}">${item.title}</a>`);
    }
    expect(html).not.toContain('data-rail="classic"');
    expect(html.match(/data-stub-follow="\d+"/g)).toHaveLength(18);
  });

  test("each rail's head: its name, its count (not for 人气最高), and 查看全部 to the grid", () => {
    const html = render(hubData());
    expect(html).toMatch(/<h2[^>]*>正在连载<small[^>]*>84 部<\/small><\/h2>/);
    expect(html).toMatch(/<h2[^>]*>人气最高<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>近年新作<small[^>]*>1,200 部<\/small><\/h2>/);
    for (const list of ["airing", "popular", "recent"]) {
      expect(html).toContain(`href="/genre/action?list=${list}"`);
    }
    expect(html).toMatch(/aria-label="查看全部正在连载"/);
  });

  test("the top ten: ten title links, ranked, and 完整排行", () => {
    const data = hubData();
    const html = render(data);
    if (data.kind !== "hub") throw new Error("not a hub");
    const ranks = html.slice(html.indexOf("data-ranks"), html.indexOf("</ol>", html.indexOf("data-ranks")));
    expect(ranks.match(/data-rank="\d+"/g)).toHaveLength(10);
    for (const item of data.top) expect(ranks).toContain(`href="/anime/${item.id}">${item.title}</a>`);
    expect(ranks).toContain("2019 · TV · 12 集");
    expect(html).toContain('href="/genre/action?list=top"');
    expect(html).toMatch(/>完整排行</);
    expect(html).toMatch(/<h2[^>]*>评分前 10<\/h2>/);
  });

  test("the tiles are links: decades and related genres to the grid, studios to their own page", () => {
    const html = render(hubData());
    for (const href of ["/genre/action?decade=2020", "/genre/action?decade=2010", "/genre/action?decade=old"]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain('href="/genre/action?with=fantasy"');
    expect(html).toContain('href="/genre/action?with=sci-fi"');
    expect(html).toContain('href="/studio/Toei%20Animation"');
    expect(html).toContain('href="/studio/MAPPA"');
    expect(html).toMatch(/aria-label="2020 年代，1,200 部"/);
    expect(html).toMatch(/aria-label="动作和奇幻都有的番剧，900 部"/);
    expect(html).toMatch(/aria-label="Toei Animation，300 部动作番剧"/);
    expect(html).toMatch(/<h2[^>]*>年代分布<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>常一起出现<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>代表制作公司<\/h2>/);
    // 更早, with no cover, shows its ghost numeral instead.
    expect(html).toMatch(/>&lt;70</);
    // Three covers fanned on a full tile.
    expect(html.match(/data-fan="3"/g)?.length).toBeGreaterThanOrEqual(4);
  });

  test("a hub the API could not answer is still a page: heading and strip", () => {
    const html = render(EMPTY_HUB);
    expect(html).toMatch(/<h1[^>]*>动作番剧<\/h1>/);
    expect(html).not.toContain("data-count");
    expect((html.match(/href="\/genre\//g) ?? []).length).toBe(18);
    expect(html).not.toContain("data-rail");
    expect(html).not.toContain("data-tiles");
  });

  test("English renders English", () => {
    const html = render(hubData("en"), "en");
    expect(html).toMatch(/<h1[^>]*>Action Anime<\/h1>/);
    expect(html).toContain("5,241 titles · 84 airing");
    expect(html).toMatch(/<h2[^>]*>Airing now<small[^>]*>84 titles<\/small><\/h2>/);
    expect(html).toContain(">See all<");
    expect(html).toMatch(/<h2[^>]*>Top 10 by score<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>By decade<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>Often paired with<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>Top studios<\/h2>/);
    expect(html).toContain(">2020s<");
    expect(html).toContain('data-wide="true"');
  });

  test("Traditional renders Traditional", () => {
    const html = render(hubData("zh-Hant"), "zh-Hant");
    expect(html).toMatch(/<h1[^>]*>動作番劇<\/h1>/);
    expect(html).toContain("5,241 部 · 84 部連載中");
    expect(html).toMatch(/<h2[^>]*>正在連載<small/);
    expect(html).toMatch(/<h2[^>]*>評分前 10<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>年代分佈<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>代表製作公司<\/h2>/);
  });
});

describe("the grid's server HTML", () => {
  test("its h1 and count, and the way back to the hub", () => {
    const html = render(gridData({ kind: "list", list: "airing" }, 1, 84, 36));
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>动作 · 正在连载<\/h1>/);
    expect(html).toMatch(/data-count="true"[^>]*>84 部</);
    const back = html.match(/<a [^>]*data-back="true"[^>]*>.*?<\/a>/)?.[0] ?? "";
    expect(back).toContain('href="/genre/action"');
    expect(back).toContain("返回动作番剧");
    // The hub's own furniture is not on the grid.
    expect(html).not.toContain("data-genre-strip");
  });

  test("every card is a real link with its title", () => {
    const data = gridData({ kind: "decade", decade: "1990" }, 1, 40, 36);
    const html = render(data);
    expect(html).toMatch(/<h1[^>]*>动作 · 1990 年代<\/h1>/);
    for (const item of data.items) expect(html).toContain(`href="/anime/${item.id}">${item.title}</a>`);
    expect(html.match(/data-anime-card="true"/g)).toHaveLength(36);
  });

  test("show more is a real link to the next page, saying how many are left", () => {
    const html = render(gridData({ kind: "list", list: "airing" }, 1, 84, 36));
    expect(html).toContain(`href="${esc("/genre/action?list=airing&page=2")}"`);
    expect(html).toMatch(/data-load-more="true"[^>]*>显示更多<span[^>]*>还有 48 部<\/span>/);
  });

  test("on the last page there is no next one", () => {
    const html = render(gridData({ kind: "with", with: "Fantasy" }, 3, 80, 8));
    expect(html).toMatch(/<h1[^>]*>动作 × 奇幻<\/h1>/);
    expect(html).not.toContain("data-load-more");
  });

  test("the old ?page=2 is the popular list's second page, with the third after it", () => {
    const html = render(gridData({ kind: "list", list: "popular" }, 2, 200, 36, true));
    expect(html).toMatch(/<h1[^>]*>动作 · 人气最高<\/h1>/);
    expect(html).toContain(`href="${esc("/genre/action?list=popular&page=3")}"`);
    // 200 in the list, two pages of 36 behind this one's end.
    expect(html).toMatch(/还有 128 部/);
    expect(html).toContain('href="/anime/9036">测试番 9036</a>');
  });

  test("an empty slice says so, with the way back", () => {
    const html = render(gridData({ kind: "decade", decade: "old" }, 1, 0, 0));
    expect(html).toContain("data-empty");
    expect(html).toContain("没有符合条件的番剧");
    expect(html).toMatch(/href="\/genre\/action"[^>]*>返回<\/a>/);
  });

  test("the score ranking in English", () => {
    const filter = browseFilter("Action", { kind: "list", list: "top" }, 2020);
    const data = buildGridData({ kind: "list", list: "top" }, 1, false, filter, { rows: rows(1, 3), total: 3 }, "en");
    const html = render(data, "en");
    expect(html).toMatch(/<h1[^>]*>Action · Top rated<\/h1>/);
    expect(html).toContain("3 titles");
    expect(html).toContain("Back to Action Anime");
  });
});
