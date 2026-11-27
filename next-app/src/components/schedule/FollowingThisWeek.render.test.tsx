import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SITE_TZ } from "@/lib/home/time";
import { LanguageProvider } from "@/lib/lang-client";
import { buildWeek } from "@/lib/schedule/viewModels";
import type { ScheduleItem } from "@/lib/types";
import zh from "@/locales/zh-spa.js";
import FollowingThisWeek from "./FollowingThisWeek";

// renderToStaticMarkup, as in ScheduleBoard.render.test.tsx: no DOM, so this
// pins what the box draws on first paint. The two orders themselves are
// tested in lib/schedule/following.test.ts; clicking is checked in a browser.

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 6, 4, 0);
const copy = { today: zh.home.today, todayShort: zh.schedule.todayShort, ep: zh.home.todayEp };

let nextId = 1;
const row = (anilistId: number, atMs: number, episode: number, titleChinese: string): ScheduleItem => ({
  scheduleId: nextId++,
  airingAt: atMs / 1000,
  episode,
  anilistId,
  titleRomaji: titleChinese,
  titleEnglish: null,
  titleNative: null,
  titleChinese,
  coverImageUrl: null,
  coverImageColor: null,
  posterAccent: "#09afd8",
  posterAccentRgb: "9,175,216",
  posterAccentContrastOnBlack: 8.1,
  format: "TV",
  averageScore: 80,
  genres: [],
});

// 甲番 aired two hours ago and you are caught up; 乙番 airs in three hours and
// you are four episodes behind it.
const week = buildWeek(
  { today: "2026-10-06", groups: { "2026-10-06": [row(1, NOW - 2 * HOUR, 5, "甲番"), row(2, NOW + 3 * HOUR, 9, "乙番")] } },
  "zh",
  copy,
);

function render(progress: Record<number, number>): string {
  return renderToStaticMarkup(
    <LanguageProvider lang="zh">
      <FollowingThisWeek days={week} progress={progress} clock={{ nowMs: NOW, timeZone: SITE_TZ }} />
    </LanguageProvider>,
  );
}

describe("FollowingThisWeek — sort toggle", () => {
  test("two or more shows: the toggle shows, airing order is pressed and is the order drawn", () => {
    const html = render({ 1: 5, 2: 4 });
    expect(html).toContain(`aria-label="${zh.schedule.mineSortAria}"`);
    expect(html).toMatch(/aria-pressed="true" data-follow-sort="time"/);
    expect(html).toMatch(/aria-pressed="false" data-follow-sort="unseen"/);
    expect(html).toContain(zh.schedule.mineSortUnseen);
    expect(html.indexOf("甲番")).toBeLessThan(html.indexOf("乙番"));
  });

  test("one show: nothing to sort, no toggle", () => {
    const html = render({ 2: 4 });
    expect(html).toContain("乙番");
    expect(html).not.toContain("data-follow-sort");
  });
});
