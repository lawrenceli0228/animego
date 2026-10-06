import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { LanguageProvider } from "@/lib/lang-client";
import { buildWeek } from "@/lib/schedule/viewModels";
import zh from "@/locales/zh-spa.js";
import ScheduleBoard from "./ScheduleBoard";

// renderToStaticMarkup, as in ActivitySection.render.test.tsx: no jsdom, no
// testing-library. lib/schedule/aside.ts decides which aside box shows and is
// unit-tested there; this file pins that the board obeys it, and that a failed
// schedule says so instead of drawing an empty week.
//
// The case that matters is a signed-in reader whose schedule failed: the page
// must say the schedule did not load and must NOT also say nothing they follow
// airs this week.

const NOW = Date.UTC(2026, 9, 6, 4, 0);
const copy = { today: zh.home.today, todayShort: zh.schedule.todayShort, ep: zh.home.todayEp };

/** What page.tsx builds when /api/anime/schedule fails. */
const failedWeek = buildWeek({ today: "", groups: {} }, "zh", copy);
/** A week that loaded and has nothing in it. */
const quietWeek = buildWeek({ today: "2026-10-06", groups: {} }, "zh", copy);

const SIGN_IN = "SIGN-IN-PROMPT";

function render(days: typeof failedWeek, progress: Record<number, number> | null): string {
  return renderToStaticMarkup(
    <LanguageProvider lang="zh">
      <ScheduleBoard
        days={days}
        serverNowMs={NOW}
        progress={progress}
        header={null}
        signIn={<p>{SIGN_IN}</p>}
        nextSeason={null}
      />
    </LanguageProvider>,
  );
}

describe("ScheduleBoard — when the schedule fails", () => {
  test("the fixtures are what they claim to be", () => {
    expect(failedWeek).toEqual([]);
    expect(quietWeek).toHaveLength(7);
  });

  test("a signed-in reader is told it did not load, and not that nothing they follow airs", () => {
    const html = render(failedWeek, { 21: 3 });
    expect(html).toContain(zh.schedule.loadFailed);
    expect(html).not.toContain(zh.schedule.mineEmpty);
    expect(html).not.toContain(zh.schedule.mineTitle);
    expect(html).not.toContain(SIGN_IN);
    expect(html).not.toContain('role="tablist"');
  });

  test("a visitor is told it did not load and still gets the sign-in prompt", () => {
    const html = render(failedWeek, null);
    expect(html).toContain(zh.schedule.loadFailed);
    expect(html).toContain(SIGN_IN);
  });
});

describe("ScheduleBoard — when the schedule loads", () => {
  test("a signed-in reader gets 我追的 · 本周, and no failure note", () => {
    const html = render(quietWeek, { 21: 3 });
    expect(html).toContain(zh.schedule.mineTitle);
    expect(html).toContain(zh.schedule.mineEmpty);
    expect(html).not.toContain(zh.schedule.loadFailed);
    expect(html).not.toContain(SIGN_IN);
    expect(html).toContain('role="tablist"');
  });

  test("a visitor gets the sign-in prompt, not 我追的", () => {
    const html = render(quietWeek, null);
    expect(html).toContain(SIGN_IN);
    expect(html).not.toContain(zh.schedule.mineTitle);
  });
});
