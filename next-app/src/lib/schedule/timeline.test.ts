import { describe, expect, test } from "bun:test";
import { dayTimeline } from "./timeline";

const MIN = 60_000;
const NOW = Date.UTC(2026, 8, 23, 12, 40); // 20:40 in Shanghai
const at = (offsetMin: number, id = offsetMin, extraMs = 0) => ({ id, at: NOW + offsetMin * MIN + extraMs });

// One day of the schedule page, grouped the way the board draws it: one row
// per airing time, every show at that time inside it, and on today a "now"
// rule between what has aired and what has not.

describe("dayTimeline", () => {
  test("shows airing in the same minute share a time group", () => {
    const { groups } = dayTimeline([at(-60, 1), at(-60, 2), at(30, 3)], NOW);
    expect(groups.map((g) => g.slots.map((s) => s.item.id))).toEqual([[1, 2], [3]]);
  });

  test("seconds inside the same minute do not split a group", () => {
    const { groups } = dayTimeline([at(90, 1), at(90, 2, 30_000)], NOW);
    expect(groups).toHaveLength(1);
  });

  test("groups run in airing order whatever the input order", () => {
    const { groups } = dayTimeline([at(120, 1), at(-30, 2), at(45, 3)], NOW);
    expect(groups.map((g) => g.slots[0].item.id)).toEqual([2, 3, 1]);
  });

  test("a group's time is its minute", () => {
    const { groups } = dayTimeline([at(15, 1, 42_000)], NOW);
    expect(groups[0].at).toBe(NOW + 15 * MIN);
  });

  test("each show keeps its own aired / soon / later state", () => {
    const { groups } = dayTimeline([at(-5, 1), at(20, 2), at(300, 3)], NOW);
    expect(groups.map((g) => g.slots[0].state)).toEqual(["aired", "soon", "later"]);
    expect(groups[1].slots[0].minutesUntil).toBe(20);
  });

  test("now sits before the first group that has not fully aired", () => {
    const { groups, nowIndex } = dayTimeline([at(-120), at(-10), at(15), at(200)], NOW);
    expect(groups.map((g) => g.aired)).toEqual([true, true, false, false]);
    expect(nowIndex).toBe(2);
  });

  test("now sits at the start when nothing has aired, at the end when everything has", () => {
    expect(dayTimeline([at(10), at(40)], NOW).nowIndex).toBe(0);
    expect(dayTimeline([at(-40), at(-10)], NOW).nowIndex).toBe(2);
  });

  test("an empty day is no groups and now at 0", () => {
    expect(dayTimeline([], NOW)).toEqual({ groups: [], nowIndex: 0 });
  });

  test("does not mutate its input", () => {
    const input = [at(30), at(-30)];
    const copy = input.map((x) => ({ ...x }));
    dayTimeline(input, NOW);
    expect(input).toEqual(copy);
  });
});
