import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import ContinueWatching from "@/components/anime/ContinueWatching";
import FollowingThisWeek from "@/components/schedule/FollowingThisWeek";
import { SITE_TZ } from "@/lib/home/time";
import { cardToneVars } from "@/lib/home/tone";
import { continueCards, type ContinueRow } from "@/lib/home/viewModels";
import { getDictByLang } from "@/lib/i18n";
import { LanguageProvider } from "@/lib/lang-client";
import type { ScheduleDayView } from "@/lib/schedule/viewModels";
import WatchingList from "./WatchingList";

// renderToStaticMarkup, as in the schedule's render tests: no jsdom.
//
// The 全部在追 page shows every show the reader is watching as the same card
// the homepage's 继续看 leads with, in the same order, each in its own
// anime's colour; it says so when there is nothing, and says the list failed
// rather than showing an empty one when it did. Both 全部在追 links — the
// homepage's 继续看 header and the schedule page's 我追的 · 本周 — lead to it.

const dict = getDictByLang("zh");
const NOW = Date.UTC(2026, 9, 7, 12, 0);

const row = (anilistId: number, currentEpisode: number, episodes: number | null, accent: string | null): ContinueRow => ({
  anilistId,
  titleChinese: `在追 ${anilistId}`,
  coverImageUrl: null,
  bannerImageUrl: null,
  posterAccent: accent,
  episodes,
  status: "RELEASING",
  animeStatus: "RELEASING",
  currentEpisode,
  lastWatchedAt: null,
});

// Most recently updated first, as the API answers.
const ROWS = [row(31, 3, 12, "#3b82f6"), row(17, 0, null, null), row(52, 7, 24, "#e11d48")];
const CARDS = continueCards(ROWS, "zh");

function list(state: "list" | "empty" | "unavailable", cards = CARDS): string {
  return renderToStaticMarkup(
    <LanguageProvider lang="zh">
      <WatchingList
        state={state}
        cards={cards}
        dict={dict}
        lang="zh"
        nowMs={NOW}
        seasonHref="/seasonal/fall/2026"
        loginHref="/login?from=%2Fwatching"
      />
    </LanguageProvider>,
  );
}

const cardHrefs = (html: string) =>
  [...html.matchAll(/<a\b[^>]*>/g)]
    .map((m) => /href="(\/anime\/\d+)"/.exec(m[0])?.[1])
    .filter((h): h is string => !!h);

describe("WatchingList — the reader's shows", () => {
  const html = list("list");

  test("every watching show is a card, in the API's order", () => {
    expect(cardHrefs(html)).toEqual(["/anime/31", "/anime/17", "/anime/52"]);
    // A list, so a screen reader hears how many.
    expect(html.match(/<li\b/g)).toHaveLength(3);
  });

  test("each card shows progress, the next episode and the continue label", () => {
    expect(html).toContain("看到第 3 集");
    expect(html).toContain("继续看第 4 集");
    expect(html).toContain("3/12 集");
    expect(html).toContain("还没开始看");
    expect(html).toContain("从第 1 集开始");
    expect(html).toContain("继续看第 8 集");
    expect(html).toContain("7/24 集");
  });

  test("each card wears its own anime's colour, written on the card", () => {
    for (const c of CARDS) {
      expect(html).toContain(`--tone:${cardToneVars(c.hue)["--tone"]}`);
    }
  });

  test("the title, the count and the order, and the way to /profile", () => {
    expect(html).toContain(`<h1`);
    expect(html).toContain(dict.watchingPage.title);
    expect(html).toContain("3 部在追 · 最近更新的在前");
    expect(html).toMatch(/href="\/profile"[^>]*>管理追番/);
  });
});

describe("WatchingList — nothing, or nothing loaded", () => {
  test("signed in with nothing in progress: says so and points at the season", () => {
    const html = list("empty", []);
    expect(html).toContain(dict.home.watchingEmptyTitle);
    expect(html).toContain('href="/seasonal/fall/2026"');
    expect(cardHrefs(html)).toEqual([]);
  });

  test("a list that failed to load is said to have failed — not shown as empty", () => {
    const html = list("unavailable", []);
    expect(html).toContain(dict.watchingPage.loadFailed);
    expect(html).not.toContain(dict.home.watchingEmptyTitle);
    // No count either: "0 部在追" would be the same false statement.
    expect(html).not.toMatch(/\d+ 部在追/);
  });
});

describe("both 全部在追 links lead to /watching", () => {
  test("the homepage's 继续看 header", () => {
    const html = renderToStaticMarkup(
      <LanguageProvider lang="zh">
        <ContinueWatching items={CARDS} loggedOut={false} dict={dict} lang="zh" nowMs={NOW} seasonHref="/x" />
      </LanguageProvider>,
    );
    expect(html).toMatch(/href="\/watching"[^>]*>全部在追/);
    expect(html).not.toContain('href="/profile"');
  });

  test("the schedule page's 我追的 · 本周, once it has more than it lists", () => {
    // Nine followed shows airing today, one a quarter-hour apart.
    const items = Array.from({ length: 9 }, (_, k) => ({
      id: 100 + k,
      href: `/anime/${100 + k}`,
      title: `追 ${k}`,
      cover: null,
      hue: null,
      key: k,
      at: NOW + (k + 1) * 15 * 60_000,
      ep: 2,
      meta: "",
      score: null,
    }));
    const days: ScheduleDayView[] = [
      { key: "2026-10-07", isToday: true, label: "今天", short: "今", md: "10/7", hue: null, items },
    ];
    const progress = Object.fromEntries(items.map((it) => [it.id, 1]));
    const html = renderToStaticMarkup(
      <LanguageProvider lang="zh">
        <FollowingThisWeek days={days} progress={progress} clock={{ nowMs: NOW, timeZone: SITE_TZ }} />
      </LanguageProvider>,
    );
    expect(html).toMatch(/href="\/watching"[^>]*>全部在追/);
  });
});
