import { describe, expect, test } from "bun:test";
import type { ScheduleItem, ScheduleResponse } from "@/lib/types";
import { buildWeek, scheduleItemView } from "./viewModels";

const copy = { today: "今天", todayShort: "今", ep: "第 {{ep}} 集" };

let nextId = 1;
const row = (over: Partial<ScheduleItem> = {}): ScheduleItem => ({
  scheduleId: nextId++,
  airingAt: Date.UTC(2026, 8, 23, 12, 0) / 1000,
  episode: 12,
  anilistId: 100,
  titleRomaji: "Tesuto",
  titleEnglish: null,
  titleNative: "テスト",
  titleChinese: "测试番",
  coverImageUrl: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/1.jpg",
  coverImageColor: "#09afd8",
  posterAccent: "#09afd8",
  posterAccentRgb: "9,175,216",
  posterAccentContrastOnBlack: 8.1,
  format: "TV",
  averageScore: 85,
  genres: ["Action", "Adventure", "Comedy"],
  ...over,
});

describe("scheduleItemView", () => {
  test("carries what a row shows and nothing else", () => {
    const v = scheduleItemView(row({ scheduleId: 7, anilistId: 21 }), "zh", copy.ep);
    expect(v).toMatchObject({
      key: 7,
      id: 21,
      href: "/anime/21",
      title: "测试番",
      ep: 12,
      at: Date.UTC(2026, 8, 23, 12, 0),
      score: "8.5",
    });
    expect(typeof v.hue).toBe("number");
  });

  test("the meta line is episode · format · two localised genres", () => {
    expect(scheduleItemView(row(), "zh", copy.ep).meta).toBe("第 12 集 · TV · 动作 / 冒险");
    expect(scheduleItemView(row(), "en", "Ep {{ep}}").meta).toBe("Ep 12 · TV · Action / Adventure");
  });

  test("missing parts drop out of the meta line instead of leaving gaps", () => {
    const v = scheduleItemView(row({ format: null, genres: [] }), "zh", copy.ep);
    expect(v.meta).toBe("第 12 集");
  });

  test("an unrated show has no score; the brand fallback has no hue", () => {
    const v = scheduleItemView(row({ averageScore: null, posterAccent: "#8B5CF6" }), "zh", copy.ep);
    expect(v.score).toBeNull();
    expect(v.hue).toBeNull();
  });
});

describe("buildWeek", () => {
  const today = "2026-09-23"; // a Wednesday
  const schedule = (groups: ScheduleResponse["groups"]): ScheduleResponse => ({ today, groups });

  test("always seven days from the API's today, empty days included", () => {
    const week = buildWeek(schedule({ "2026-09-23": [row()], "2026-09-26": [row()] }), "zh", copy);
    expect(week.map((d) => d.key)).toEqual([
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
    ]);
    expect(week.map((d) => d.items.length)).toEqual([1, 0, 0, 1, 0, 0, 0]);
  });

  test("today says today; the rest say their weekday, with M/D", () => {
    const week = buildWeek(schedule({}), "zh", copy);
    expect(week.map((d) => d.label)).toEqual(["今天", "周四", "周五", "周六", "周日", "周一", "周二"]);
    expect(week.map((d) => d.short)).toEqual(["今", "四", "五", "六", "日", "一", "二"]);
    expect(week[1].md).toBe("9/24");
    expect(week.map((d) => d.isToday)).toEqual([true, false, false, false, false, false, false]);
  });

  test("each day wears its best-rated show's hue, airing order kept", () => {
    const low = row({ anilistId: 1, averageScore: 60, posterAccent: "#e47843", airingAt: 100 });
    const high = row({ anilistId: 2, averageScore: 90, posterAccent: "#17afd6", airingAt: 50 });
    const [day] = buildWeek(schedule({ [today]: [low, high] }), "zh", copy);
    expect(day.hue).toBe(scheduleItemView(high, "zh", copy.ep).hue);
    expect(day.items.map((i) => i.id)).toEqual([2, 1]);
  });

  test("an empty day has no hue", () => {
    expect(buildWeek(schedule({}), "zh", copy)[0].hue).toBeNull();
  });

  test("a failed fetch is no week at all, not seven empty days", () => {
    expect(buildWeek({ today: "", groups: {} }, "zh", copy)).toEqual([]);
  });

  test("does not mutate the response", () => {
    const groups = { [today]: [row({ airingAt: 200 }), row({ airingAt: 100 })] };
    const before = groups[today].map((r) => r.airingAt);
    buildWeek(schedule(groups), "zh", copy);
    expect(groups[today].map((r) => r.airingAt)).toEqual(before);
  });
});
