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
// Also: the row is moved by a labelled slider, not by buttons, and it ends by
// saying the day is over, what tomorrow holds and where the full schedule is.

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

const TOMORROW = { label: "周四 10月8日", count: 27 };

function render(nowMs: number, items = ITEMS, tomorrow: { label: string; count: number } | null = TOMORROW): string {
  return renderToStaticMarkup(
    <LanguageProvider lang="zh">
      <TodayRail items={items} dayKey={DAY} dayLabel="周三 10月7日" tomorrow={tomorrow} serverNowMs={nowMs} />
    </LanguageProvider>,
  );
}

/** The end-of-day panel: from its title to the end of the row. */
function endOf(html: string): string {
  const at = html.indexOf(zh.home.todayEndTitle);
  return at < 0 ? "" : html.slice(at);
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

  test("no ← → buttons: the row is moved by a slider that names what it does and controls the row", () => {
    const html = render(NOW);
    expect(html).not.toContain("<button");
    const input = /<input\b[^>]*type="range"[^>]*>/.exec(html)?.[0] ?? "";
    expect(input).toContain(`aria-label="${zh.home.todayScroll}"`);
    expect(input).toContain('aria-controls="home-today-rail"');
    expect(html).toContain('id="home-today-rail"');
  });

  test("until it is measured the slider keeps its room but draws nothing, and is not a stop for Tab", () => {
    const html = render(NOW);
    expect(html).toContain('data-overflow="false"');
    expect(/<input\b[^>]*type="range"[^>]*>/.exec(html)?.[0]).toContain("disabled");
  });

  test("the row ends by saying the day is over, what tomorrow holds, and where the full schedule is", () => {
    const end = endOf(render(NOW));
    expect(end).toContain("明天 · 周四 10月8日 · 27 部");
    expect(end).toContain('href="/calendar"');
    expect(end).toContain(zh.home.todayEndLink);
    // After every card: the panel is not a show and is not counted as one.
    expect(end).not.toContain('href="/anime/');
    expect(end).not.toContain("data-state");
  });

  test("a tomorrow with nothing on it says only which day it is; no tomorrow, no line", () => {
    expect(endOf(render(NOW, ITEMS, { label: "周四 10月8日", count: 0 }))).toContain("明天 · 周四 10月8日<");
    const none = endOf(render(NOW, ITEMS, null));
    expect(none).toContain(zh.home.todayEndLink);
    expect(none).not.toContain("明天");
  });

  test("the end panel comes after the 现在 marker when everything has aired", () => {
    const html = render(NOW + 4 * 60 * MIN);
    expect(states(html)).toEqual(["aired", "aired", "aired", "aired", "aired"]);
    expect(html.indexOf("data-now")).toBeGreaterThan(html.indexOf('href="/anime/9005"'));
    expect(html.indexOf(zh.home.todayEndTitle)).toBeGreaterThan(html.indexOf("data-now"));
  });

  test("an empty day says so, with no row and no slider", () => {
    const html = render(NOW, []);
    expect(html).toContain(zh.home.noUpdates);
    expect(html).not.toContain("home-today-rail");
    expect(html).not.toContain('type="range"');
  });
});
