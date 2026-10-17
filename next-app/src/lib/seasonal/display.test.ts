import { describe, expect, test } from "bun:test";

import { HOUR_MS, NOW, item } from "@/lib/test-utils/seasonalItems";
import en from "@/locales/en-spa.js";
import zhHant from "@/locales/zh-Hant-spa.js";
import zh from "@/locales/zh-spa.js";
import {
  airingText,
  countParts,
  countdown,
  coverBadge,
  dateLabel,
  formatSubLine,
  infoLine,
  metaLine,
  monthLongLabel,
  monthShortLabel,
  popularityText,
  runtimeText,
  statusSubLine,
  weekdayLongLabel,
  weekdayShortLabel,
  type CardCopy,
} from "./display";
import { DEFAULT_STATE } from "./state";

// The strings a card shows, in all three languages, read from the same -spa
// dictionaries the client tree reads through useLang(). NOW is Friday
// 2026-10-16 20:00 in Beijing.

const ZH = zh.seasonPage as CardCopy;
const EN = en.seasonPage as CardCopy;
const HANT = zhHant.seasonPage as CardCopy;

const MIN_MS = 60_000;
const DAY_MS = 24 * HOUR_MS;

describe("airingText", () => {
  const airing = (inMs: number, ep = 4) => item({ id: 1, next: { at: NOW + inMs, ep } });

  test("days, hours or minutes to the next episode, per language", () => {
    expect(airingText(airing(6 * DAY_MS + 5 * HOUR_MS), NOW, ZH, "zh")).toBe("第 4 集 · 6 天后");
    expect(airingText(airing(6 * DAY_MS + 5 * HOUR_MS), NOW, EN, "en")).toBe("Ep 4 · in 6 days");
    expect(airingText(airing(6 * DAY_MS + 5 * HOUR_MS), NOW, HANT, "zh-Hant")).toBe("第 4 集 · 6 天後");
    expect(airingText(airing(3 * HOUR_MS + 20 * MIN_MS), NOW, ZH, "zh")).toBe("第 4 集 · 3 小时后");
    expect(airingText(airing(20 * MIN_MS + 30_000), NOW, EN, "en")).toBe("Ep 4 · in 20 min");
  });

  test("English says one day, not one days", () => {
    expect(airingText(airing(DAY_MS + HOUR_MS), NOW, EN, "en")).toBe("Ep 4 · in 1 day");
    expect(airingText(airing(HOUR_MS + MIN_MS), NOW, EN, "en")).toBe("Ep 4 · in 1 hour");
  });

  test("under a minute still reads one minute; at or past the time it has aired", () => {
    expect(airingText(airing(5_000), NOW, ZH, "zh")).toBe("第 4 集 · 1 分钟后");
    expect(airingText(airing(0), NOW, ZH, "zh")).toBe("第 4 集 · 已播出");
    expect(airingText(airing(-HOUR_MS), NOW, EN, "en")).toBe("Ep 4 · out now");
  });

  test("finished: the episode count, shorter on a phone", () => {
    const done = item({ id: 2, status: "FINISHED", episodes: 12 });
    expect(airingText(done, NOW, ZH, "zh")).toBe("已完结 · 全 12 集");
    expect(airingText(done, NOW, ZH, "zh", "short")).toBe("全 12 集");
    expect(airingText(done, NOW, EN, "en")).toBe("Finished · 12 eps");
    expect(airingText({ ...done, episodes: 1 }, NOW, EN, "en", "short")).toBe("1 ep");
    expect(airingText({ ...done, episodes: null }, NOW, ZH, "zh")).toBe("已完结");
  });

  test("not yet released: the premiere date, or that there is none", () => {
    const soon = item({ id: 3, status: "NOT_YET_RELEASED", start: "2026-10-20" });
    expect(airingText(soon, NOW, ZH, "zh")).toBe("10 月 20 日开播");
    expect(airingText(soon, NOW, EN, "en")).toBe("Premieres Oct 20");
    const tbd = { ...soon, start: null };
    expect(airingText(tbd, NOW, ZH, "zh")).toBe("开播时间待定");
    expect(airingText(tbd, NOW, ZH, "zh", "short")).toBe("开播待定");
  });

  test("airing with nothing scheduled says its status", () => {
    expect(airingText(item({ id: 4, status: "RELEASING" }), NOW, ZH, "zh")).toBe("连载中");
    expect(airingText(item({ id: 4, status: "HIATUS" }), NOW, EN, "en")).toBe("Hiatus");
    expect(airingText(item({ id: 4, status: null }), NOW, EN, "en")).toBe("");
  });
});

describe("countdown", () => {
  const airing = (inMs: number) => item({ id: 1, next: { at: NOW + inMs, ep: 4 } });

  test("days and hours, hours and minutes, or minutes", () => {
    expect(countdown(airing(6 * DAY_MS + 3 * HOUR_MS), NOW, ZH, "zh")).toEqual({
      label: "第 4 集播出还有",
      value: "6 天 3 小时",
    });
    expect(countdown(airing(2 * HOUR_MS + 15 * MIN_MS), NOW, EN, "en")).toEqual({ label: "Ep 4 airs in", value: "2h 15m" });
    expect(countdown(airing(40 * MIN_MS), NOW, HANT, "zh-Hant")).toEqual({ label: "第 4 集播出還有", value: "40 分鐘" });
  });

  test("an episode that has gone out", () => {
    expect(countdown(airing(-MIN_MS), NOW, ZH, "zh")).toEqual({ label: "第 4 集", value: "已播出" });
  });

  test("finished, upcoming and anything else", () => {
    expect(countdown(item({ id: 2, status: "FINISHED", episodes: 24 }), NOW, ZH, "zh")).toEqual({
      label: "已完结",
      value: "全 24 集",
    });
    expect(countdown(item({ id: 3, status: "NOT_YET_RELEASED", start: "2026-11-01" }), NOW, EN, "en")).toEqual({
      label: "Premieres",
      value: "Nov 1",
    });
    expect(countdown(item({ id: 3, status: "NOT_YET_RELEASED" }), NOW, ZH, "zh")).toEqual({ label: "开播", value: "待定" });
    expect(countdown(item({ id: 4, status: "RELEASING", episodes: 13 }), NOW, ZH, "zh")).toEqual({
      label: "连载中",
      value: "全 13 集",
    });
  });
});

describe("coverBadge", () => {
  const at = (inMs: number, ep = 4) => item({ id: 1, next: { at: NOW + inMs, ep } });

  test("later today in Beijing: 今天 and the time", () => {
    // NOW is 20:00; +2h is 22:00 the same day.
    expect(coverBadge(at(2 * HOUR_MS), NOW, DEFAULT_STATE, "weekday", ZH, "zh")).toEqual({ kind: "soon", text: "今天 22:00" });
    expect(coverBadge(at(2 * HOUR_MS), NOW, DEFAULT_STATE, "weekday", EN, "en")).toEqual({ kind: "soon", text: "Today 22:00" });
  });

  test("past Beijing midnight but within a day: 明天", () => {
    // +5h30 is 01:30 on Saturday.
    expect(coverBadge(at(5.5 * HOUR_MS), NOW, DEFAULT_STATE, "weekday", ZH, "zh")).toEqual({
      kind: "soon",
      text: "明天 01:30",
    });
    expect(coverBadge(at(5.5 * HOUR_MS), NOW, DEFAULT_STATE, "weekday", EN, "en")?.text).toBe("Tomorrow 01:30");
  });

  test("an episode that went out in the last day (a week before the next one)", () => {
    const justAired = at(7 * DAY_MS - 3 * HOUR_MS, 4);
    expect(coverBadge(justAired, NOW, DEFAULT_STATE, "weekday", ZH, "zh")).toEqual({ kind: "new", text: "第 3 集更新" });
    expect(coverBadge(justAired, NOW, DEFAULT_STATE, "weekday", EN, "en")?.text).toBe("Ep 3 out");
  });

  test("a next episode already in the past: news within the day, nothing after — never 今天", () => {
    // The row was last synced before the episode went out.
    expect(coverBadge(at(-2 * HOUR_MS, 6), NOW, DEFAULT_STATE, "weekday", ZH, "zh")).toEqual({
      kind: "new",
      text: "第 6 集更新",
    });
    expect(coverBadge(at(-30 * HOUR_MS, 6), NOW, DEFAULT_STATE, "weekday", ZH, "zh")).toBeNull();
    for (const ago of [-MIN_MS, -2 * HOUR_MS, -30 * HOUR_MS, -8 * DAY_MS]) {
      expect(coverBadge(at(ago), NOW, DEFAULT_STATE, "weekday", ZH, "zh")?.kind).not.toBe("soon");
    }
  });

  test("a past time never counts down below zero", () => {
    for (const ago of [-MIN_MS, -2 * HOUR_MS, -3 * DAY_MS]) {
      const stale = at(ago, 4);
      expect(airingText(stale, NOW, ZH, "zh")).toBe("第 4 集 · 已播出");
      expect(countdown(stale, NOW, ZH, "zh")).toEqual({ label: "第 4 集", value: "已播出" });
    }
  });

  test("a first episode has no previous one to announce", () => {
    expect(coverBadge(at(7 * DAY_MS - 3 * HOUR_MS, 1), NOW, DEFAULT_STATE, "weekday", ZH, "zh")).toBeNull();
  });

  test("further out, no badge — unless a weekday or month filter asks for the time", () => {
    const later = at(3 * DAY_MS);
    expect(coverBadge(later, NOW, DEFAULT_STATE, "weekday", ZH, "zh")).toBeNull();
    // NOW + 3 days is Monday 20:00 in Beijing.
    expect(coverBadge(later, NOW, { ...DEFAULT_STATE, wd: 1 }, "weekday", ZH, "zh")).toEqual({ kind: "plain", text: "20:00" });
    const dated = item({ id: 2, start: "2026-10-20", status: "NOT_YET_RELEASED" });
    expect(coverBadge(dated, NOW, { ...DEFAULT_STATE, mon: "2026-10" }, "month", ZH, "zh")).toEqual({
      kind: "plain",
      text: "10 月 20 日",
    });
    expect(coverBadge(dated, NOW, DEFAULT_STATE, "month", ZH, "zh")).toBeNull();
  });
});

describe("info and meta lines", () => {
  test("a series: format and episodes", () => {
    expect(infoLine(item({ id: 1, format: "TV", episodes: 12 }), ZH, "zh")).toBe("TV · 12 集");
    expect(infoLine(item({ id: 1, format: "TV_SHORT", episodes: 1 }), EN, "en")).toBe("Short · 1 ep");
    expect(infoLine(item({ id: 1, format: "ONA" }), ZH, "zh")).toBe("ONA");
  });

  test("a film: format and runtime", () => {
    expect(infoLine(item({ id: 2, format: "MOVIE", duration: 105 }), ZH, "zh")).toBe("剧场版 · 1 小时 45 分");
    expect(infoLine(item({ id: 2, format: "MOVIE", duration: 120 }), EN, "en")).toBe("Movie · 2h");
    expect(infoLine(item({ id: 2, format: "MOVIE", duration: 45 }), HANT, "zh-Hant")).toBe("劇場版 · 45 分鐘");
    expect(infoLine(item({ id: 2, format: "MOVIE" }), ZH, "zh")).toBe("剧场版");
  });

  test("the chart's meta line adds source, sequel and the Bangumi score", () => {
    const show = item({ id: 3, format: "TV", episodes: 12, source: "LIGHT_NOVEL", sequel: true, bangumi: 6.84 });
    expect(metaLine(show, ZH, "zh")).toBe("TV · 12 集 · 轻小说改 · 续作 · Bangumi 6.8");
    expect(metaLine({ ...show, sequel: false, source: "MULTIMEDIA_PROJECT", bangumi: null }, EN, "en")).toBe("TV · 12 eps");
  });

  test("the table's second lines", () => {
    expect(formatSubLine(item({ id: 4, format: "MOVIE" }), ZH)).toBe("片长未定");
    expect(formatSubLine(item({ id: 4, format: "TV" }), EN)).toBe("Episodes TBA");
    expect(formatSubLine(item({ id: 4, format: "TV", episodes: 24 }), ZH)).toBe("24 集");
    const done = item({ id: 5, status: "FINISHED", episodes: 12 });
    expect(statusSubLine(done, NOW, ZH, "zh", "2026 秋季")).toBe("2026 秋季");
    expect(statusSubLine(item({ id: 6, next: { at: NOW + 2 * DAY_MS, ep: 2 } }), NOW, ZH, "zh", "2026 秋季")).toBe(
      "第 2 集 · 2 天后",
    );
    // Airing with nothing scheduled: the status above already says 连载中.
    expect(statusSubLine(item({ id: 7, status: "RELEASING" }), NOW, ZH, "zh", "2026 秋季")).toBe("");
  });

  test("runtime words", () => {
    expect(runtimeText(null, ZH)).toBe("");
    expect(runtimeText(24, EN)).toBe("24 min");
    expect(runtimeText(90, EN)).toBe("1h 30m");
  });
});

describe("numbers and calendar words", () => {
  test("Chinese counts in ten-thousands, English groups digits", () => {
    expect(countParts(99_660, "zh")).toEqual({ n: "10.0", unit: "万" });
    expect(countParts(12_345, "zh-Hant")).toEqual({ n: "1.2", unit: "萬" });
    expect(countParts(9_999, "zh")).toEqual({ n: "9,999", unit: "" });
    expect(countParts(99_660, "en")).toEqual({ n: "99,660", unit: "" });
    expect(popularityText(99_660, ZH, "zh")).toBe("10.0 万人追番");
    expect(popularityText(9_999, ZH, "zh")).toBe("9,999 人追番");
    expect(popularityText(123_456, HANT, "zh-Hant")).toBe("12.3 萬人追番");
    expect(popularityText(1_234, EN, "en")).toBe("On 1,234 lists");
    expect(popularityText(null, EN, "en")).toBe("");
  });

  test("weekday and month labels, Monday = 1", () => {
    expect(weekdayShortLabel(1, "zh")).toBe("一");
    expect(weekdayShortLabel(7, "en")).toBe("Sun");
    expect(weekdayLongLabel(1, "zh-Hant")).toBe("週一");
    expect(weekdayLongLabel(5, "en")).toBe("Friday");
    expect(monthShortLabel(10, "zh")).toBe("10月");
    expect(monthShortLabel(10, "en")).toBe("Oct");
    expect(monthLongLabel(10, "en")).toBe("October");
    expect(dateLabel("2026-10-02", "zh")).toBe("10 月 2 日");
    expect(dateLabel("2026-10-02", "en")).toBe("Oct 2");
    expect(dateLabel("not-a-date", "en")).toBe("");
  });
});
