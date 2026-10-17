import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { HOUR_MS, NOW, item } from "@/lib/test-utils/seasonalItems";
import { LanguageProvider } from "@/lib/lang-client";
import type { Lang } from "@/lib/i18n/lang";
import type { SeasonalItem } from "@/lib/seasonal/model";
import { DEFAULT_STATE, type BrowseState } from "@/lib/seasonal/state";
import BrowseView from "./BrowseView";
import type { FollowSlotProps } from "./types";

// The server HTML of the seasonal page's client tree — what a crawler reads
// and what hydration starts from. renderToStaticMarkup, no DOM: the server
// snapshot of the clock (serverNowMs) and the layout (desktop) is what renders.
//
// The follow buttons are a stub: the real one pulls in react-hot-toast, which
// touches `document` on import (see types.ts).

function StubFollow({ anilistId }: FollowSlotProps) {
  return <i data-stub-follow={anilistId} />;
}

/**
 * 50 shows, ten on each of five weekdays — Friday (today) through Tuesday, so
 * Wednesday and Thursday are empty — with alternating genres.
 */
const SEASON: SeasonalItem[] = Array.from({ length: 50 }, (_, i) =>
  item({
    id: 1000 + i,
    title: `测试番 ${i}`,
    rank: i,
    titleRank: i,
    popularity: 10_000 - i,
    genres: i % 2 ? ["Action"] : ["Drama"],
    hue: i % 3 === 0 ? 245 : null,
    // NOW is Friday 20:00 in Beijing; i % 5 days later, at 22:00 the same clock.
    next: { at: NOW + (i % 5) * 24 * HOUR_MS + 2 * HOUR_MS, ep: 3 },
  }),
);

function render({
  items = SEASON,
  initial = DEFAULT_STATE,
  lang = "zh" as Lang,
  season = "fall" as const,
  year = 2026,
}: {
  items?: SeasonalItem[];
  initial?: BrowseState;
  lang?: Lang;
  season?: "winter" | "spring" | "summer" | "fall";
  year?: number;
} = {}): string {
  return renderToStaticMarkup(
    <LanguageProvider lang={lang}>
      <BrowseView
        items={items}
        initial={initial}
        serverNowMs={NOW}
        season={season}
        year={year}
        clockYear={2026}
        heading={lang === "en" ? "Fall 2026 Anime" : "2026年 秋季新番"}
        Follow={StubFollow}
      />
    </LanguageProvider>,
  );
}

const cardTags = (html: string) => html.match(/<div[^>]*data-anime-card="true"[^>]*>/g) ?? [];

describe("the seasonal page's server HTML", () => {
  test("one h1, with the season's heading, and the count beside it", () => {
    const html = render();
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>2026年 秋季新番<\/h1>/);
    expect(html).toMatch(/data-count="true"[^>]*>50 部</);
  });

  test("every show is a real link with its title as the anchor text", () => {
    const html = render();
    for (const show of SEASON) {
      expect(html).toContain(`href="/anime/${show.id}">${show.title}</a>`);
    }
  });

  test("past the first batch the cards are in the HTML but hidden", () => {
    const tags = cardTags(render());
    expect(tags).toHaveLength(50);
    // A desktop batch is 36 covers: the first paint is the desktop's.
    expect(tags.slice(0, 36).every((t) => !/\shidden=""/.test(t))).toBe(true);
    expect(tags.slice(36).every((t) => /\shidden=""/.test(t))).toBe(true);
  });

  test("show more says how many are left", () => {
    expect(render()).toMatch(/data-load-more="true"[^>]*>显示更多<span[^>]*>还有 14 部<\/span>/);
  });

  test("the year and season menus are crawlable links even while closed", () => {
    const html = render();
    for (const y of [2027, 2025, 2013, 2000]) expect(html).toContain(`href="/seasonal/fall/${y}"`);
    for (const s of ["winter", "spring", "summer"]) expect(html).toContain(`href="/seasonal/${s}/2026"`);
    // The page's own season and year are where the reader is, not links.
    expect(html).not.toContain('href="/seasonal/fall/2026"');
    expect(html).toMatch(/aria-current="page"[^>]*>2026 年/);
    // Closed: the panels are present and hidden.
    expect(html).toMatch(/<div[^>]*hidden=""[^>]*data-menu-panel="year"/);
    expect(html).toMatch(/<div[^>]*hidden=""[^>]*data-menu-panel="season"/);
  });

  test("links to other seasons carry the filters that still apply there", () => {
    const html = render({ initial: { ...DEFAULT_STATE, genres: ["Action"], wd: 1, sort: "time", view: "chart" } });
    expect(html).toContain('href="/seasonal/fall/2025?genre=Action&amp;view=chart"');
  });

  test("a filtered URL renders only what it matches", () => {
    const html = render({ initial: { ...DEFAULT_STATE, genres: ["Action"] } });
    expect(cardTags(html)).toHaveLength(25);
    expect(html).toContain(`href="/anime/1001">测试番 1</a>`);
    expect(html).not.toContain(`href="/anime/1000"`);
    expect(html).toMatch(/data-tag="genre"[^>]*>动作/);
  });

  test("twenty scheduled shows make the weekday chart, today marked", () => {
    const html = render();
    expect(html).toMatch(/data-bars="true" data-mode="weekday"/);
    expect(html.match(/data-bar="wd-\d"/g)).toHaveLength(7);
    // NOW is a Friday in Beijing.
    expect(html).toMatch(/aria-label="周五（今天），10 部"[^>]*data-bar="wd-5"[^>]*data-today="true"/);
    // Nothing airs on Wednesday or Thursday here: those bars cannot be pressed.
    expect(html).toMatch(/aria-label="周三，0 部" disabled=""/);
    expect(html).toMatch(/aria-label="周四，0 部" disabled=""/);
    expect(html).toMatch(/aria-label="周六，10 部" data-bar="wd-6"/);
  });

  test("a season with nothing scheduled gets the premiere-month chart", () => {
    const items = SEASON.slice(0, 6).map((s, i) => ({ ...s, next: null, start: i < 4 ? "2026-10-0" + (i + 1) : null }));
    const html = render({ items });
    expect(html).toMatch(/data-mode="month"/);
    expect(html).toMatch(/aria-label="10 月开播，4 部"[^>]*data-bar="mon-2026-10"/);
    expect(html).toMatch(/aria-label="开播待定，2 部"[^>]*data-bar="mon-tbd"/);
  });

  test("the chart view renders chart cards, the table view rows", () => {
    const chart = render({ initial: { ...DEFAULT_STATE, view: "chart" } });
    expect(chart).toContain("data-charts");
    expect(chart).not.toContain("data-grid");
    // Twelve to a batch in the chart view.
    expect(cardTags(chart).filter((t) => !/\shidden=""/.test(t))).toHaveLength(12);
    const table = render({ initial: { ...DEFAULT_STATE, view: "table" } });
    expect(table).toContain("data-rows");
    expect(cardTags(table).filter((t) => !/\shidden=""/.test(t))).toHaveLength(16);
  });

  test("each card carries the follow control", () => {
    const html = render();
    expect(html.match(/data-stub-follow="\d+"/g)).toHaveLength(50);
  });

  test("a hue family filters and tints the page", () => {
    const html = render({ initial: { ...DEFAULT_STATE, hue: "blue" } });
    expect(cardTags(html)).toHaveLength(17);
    expect(html).toMatch(/<main[^>]*style="background-color:oklch\(13% 0.016 245\)"/);
    expect(html).toMatch(/data-hue="blue"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-hue="blue"/);
  });

  test("an empty result says so and offers to clear", () => {
    const html = render({ initial: { ...DEFAULT_STATE, q: "没有这部番" } });
    expect(html).toContain("data-empty");
    expect(html).toContain("没有符合条件的番剧");
    expect(html).toContain("清除筛选");
  });

  test("English renders English", () => {
    const html = render({ lang: "en" });
    expect(html).toMatch(/<h1[^>]*>Fall 2026 Anime<\/h1>/);
    expect(html).toContain("50 anime");
    expect(html).toContain("Show more");
    expect(html).toMatch(/aria-label="Friday \(today\), 10 anime"/);
  });
});
