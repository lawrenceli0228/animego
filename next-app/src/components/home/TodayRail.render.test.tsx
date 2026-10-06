import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { TodayCard } from "@/lib/home/viewModels";
import { LanguageProvider } from "@/lib/lang-client";
import zh from "@/locales/zh-spa.js";
import TodayRail from "./TodayRail";

// renderToStaticMarkup, as in the schedule's render tests: no jsdom. The rail
// takes its "now" from useHomeClock, whose server snapshot is serverNowMs —
// so rendering at two times is the clock passing an airing.
//
// What is pinned: every show of the day is a card in the row whatever the
// time, and a show changes state as it airs rather than leaving. (The CSS half
// of that bug — a rule hiding aired cards on phones — is TodayRail.css.test.ts.)

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 7, 12, 0); // 20:00 in Shanghai
const DAY = "2026-10-07";

const item = (key: number, offsetMin: number): TodayCard => ({
  id: 9_000 + key,
  href: `/anime/${9_000 + key}`,
  title: `测试番 ${key}`,
  cover: null,
  hue: (key * 70) % 360,
  key,
  at: NOW + offsetMin * MIN,
  ep: key + 1,
});

// Aired two hours ago and half an hour ago; airing in 2 minutes; in 45; in 3 hours.
const ITEMS = [item(1, -120), item(2, -30), item(3, 2), item(4, 45), item(5, 180)];

function render(nowMs: number, items = ITEMS): string {
  return renderToStaticMarkup(
    <LanguageProvider lang="zh">
      <TodayRail items={items} dayKey={DAY} dayLabel="周三 10月7日" serverNowMs={nowMs} />
    </LanguageProvider>,
  );
}

/** Each card's data-state, in row order (attribute order is React's business). */
function states(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /href="\/anime\/9\d{3}"/.test(tag))
    .map((tag) => /data-state="(\w+)"/.exec(tag)?.[1] ?? "none");
}

describe("TodayRail", () => {
  test("every show of the day is its own card", () => {
    const html = render(NOW);
    expect(html.match(/href="\/anime\/9\d{3}"/g)).toHaveLength(ITEMS.length);
    expect(states(html)).toEqual(["aired", "aired", "soon", "soon", "later"]);
    // No fold: nothing to expand, nothing collapsed.
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain("data-aired");
  });

  test("a show that airs while the page is open stays in the row and becomes aired", () => {
    const later = render(NOW + 3 * MIN);
    expect(later.match(/href="\/anime\/9\d{3}"/g)).toHaveLength(ITEMS.length);
    expect(states(later)).toEqual(["aired", "aired", "aired", "soon", "later"]);
    // The 已播 badge is on it.
    expect(later.split(zh.home.todayAired).length - 1).toBe(3);
  });

  test("the 现在 marker sits between the aired and the upcoming", () => {
    const html = render(NOW);
    const marker = html.indexOf("data-now");
    expect(marker).toBeGreaterThan(html.indexOf('href="/anime/9002"'));
    expect(marker).toBeLessThan(html.indexOf('href="/anime/9003"'));
  });

  test("each card carries its airing time as a machine-readable <time>", () => {
    const html = render(NOW);
    expect(html).toContain(`<time dateTime="${new Date(NOW + 2 * MIN).toISOString()}">20:02</time>`);
  });

  test("the ← → buttons name what they do and control the row", () => {
    const html = render(NOW);
    expect(html).toContain(`aria-label="${zh.home.todayPrevPage}"`);
    expect(html).toContain(`aria-label="${zh.home.todayNextPage}"`);
    expect(html.match(/aria-controls="home-today-rail"/g)).toHaveLength(2);
    expect(html).toContain('id="home-today-rail"');
  });

  test("an empty day says so, with no row and no buttons", () => {
    const html = render(NOW, []);
    expect(html).toContain(zh.home.noUpdates);
    expect(html).not.toContain("home-today-rail");
  });
});
