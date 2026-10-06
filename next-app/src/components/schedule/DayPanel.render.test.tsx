import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { HomeClock } from "@/components/home/useHomeClock";
import { SITE_TZ } from "@/lib/home/time";
import { LanguageProvider } from "@/lib/lang-client";
import type { ScheduleDayView } from "@/lib/schedule/viewModels";
import en from "@/locales/en-spa.js";
import zh from "@/locales/zh-spa.js";
import DayPanel from "./DayPanel";

// renderToStaticMarkup, as in ScheduleBoard.render.test.tsx. What is pinned
// here is what a screen reader hears for a row's score: the star in front of
// it is aria-hidden, so without a text label the number is announced bare.

const NOW = Date.UTC(2026, 9, 6, 4, 0);
const clock: HomeClock = { nowMs: NOW, timeZone: SITE_TZ };

const day: ScheduleDayView = {
  key: "2026-10-06",
  isToday: true,
  label: "今天",
  short: "今",
  md: "10/6",
  hue: 200,
  items: [
    {
      id: 21,
      href: "/anime/21",
      title: "测试番",
      cover: null,
      hue: 200,
      key: 1,
      at: NOW + 3_600_000 * 3,
      ep: 12,
      meta: "第 12 集 · TV",
      score: "6.6",
    },
  ],
};

function render(lang: "zh" | "en"): string {
  return renderToStaticMarkup(
    <LanguageProvider lang={lang}>
      <DayPanel day={day} index={0} active clock={clock} progress={null} />
    </LanguageProvider>,
  );
}

/** The row link's text with tags removed: roughly what its accessible name is built from. */
function rowText(html: string): string {
  const link = html.match(/<a [^>]*href="[^"]*\/anime\/21"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "";
  return link.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");
}

describe("DayPanel — a row's score", () => {
  test("is read with a label, not as a bare number", () => {
    expect(rowText(render("zh"))).toContain(`|${zh.schedule.scoreSr} |6.6|`);
    expect(rowText(render("en"))).toContain(`|${en.schedule.scoreSr} |6.6|`);
  });
});
