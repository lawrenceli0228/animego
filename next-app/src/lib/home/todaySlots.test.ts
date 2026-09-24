import { describe, expect, test } from "bun:test";
import { SITE_TZ } from "./time";
import { SOON_WINDOW_MS, isNextDay, slotToday, todayScheduleItems } from "./todaySlots";

const MIN = 60_000;
const NOW = Date.UTC(2026, 8, 24, 12, 40); // 20:40 in Shanghai
const at = (offsetMin: number, id = offsetMin) => ({ id, at: NOW + offsetMin * MIN });

describe("slotToday", () => {
  test("splits aired / soon / later around now and puts the marker between them", () => {
    const { slots, nowIndex } = slotToday([at(-120), at(-5), at(20), at(90)], NOW);
    expect(slots.map((s) => s.state)).toEqual(["aired", "aired", "soon", "later"]);
    expect(nowIndex).toBe(2);
  });

  test("an episode airing exactly now counts as aired", () => {
    expect(slotToday([at(0)], NOW).slots[0].state).toBe("aired");
  });

  test("the soon window is the next hour, inclusive", () => {
    const { slots } = slotToday([{ id: 1, at: NOW + SOON_WINDOW_MS }, { id: 2, at: NOW + SOON_WINDOW_MS + 1 }], NOW);
    expect(slots.map((s) => s.state)).toEqual(["soon", "later"]);
  });

  test("minutes-until rounds up, so '0 minutes' is never shown for a future episode", () => {
    const { slots } = slotToday([{ id: 1, at: NOW + 30_000 }, { id: 2, at: NOW + 20 * MIN }], NOW);
    expect(slots.map((s) => s.minutesUntil)).toEqual([1, 20]);
  });

  test("aired and later slots carry no minute count", () => {
    const { slots } = slotToday([at(-3), at(300)], NOW);
    expect(slots.map((s) => s.minutesUntil)).toEqual([null, null]);
  });

  test("the marker sits at the start when nothing has aired, at the end when everything has", () => {
    expect(slotToday([at(10), at(20)], NOW).nowIndex).toBe(0);
    expect(slotToday([at(-20), at(-10)], NOW).nowIndex).toBe(2);
    expect(slotToday([], NOW)).toEqual({ slots: [], nowIndex: 0 });
  });

  test("input order does not matter; ties keep their input order", () => {
    const { slots } = slotToday([at(30, 1), at(-30, 2), at(30, 3)], NOW);
    expect(slots.map((s) => s.item.id)).toEqual([2, 1, 3]);
  });

  test("does not mutate its input", () => {
    const input = [at(30), at(-30)];
    const copy = [...input];
    slotToday(input, NOW);
    expect(input).toEqual(copy);
  });
});

describe("isNextDay", () => {
  test("an airing after local midnight belongs to the next calendar day", () => {
    // /api/anime/schedule groups by the SERVER's day, which runs 08:00→08:00
    // in Shanghai. A 06:40 episode in "today's" group is tomorrow on the clock.
    const earlyNextMorning = Date.UTC(2026, 8, 24, 22, 40); // 06:40 on the 25th, Shanghai
    expect(isNextDay(earlyNextMorning, "2026-09-24", SITE_TZ)).toBe(true);
  });

  test("an evening airing on the day itself is not", () => {
    expect(isNextDay(NOW, "2026-09-24", SITE_TZ)).toBe(false);
  });

  test("depends on the zone it is read in", () => {
    const late = Date.UTC(2026, 8, 24, 14, 30); // 22:30 Shanghai = 00:00 in Adelaide (+9:30)
    expect(isNextDay(late, "2026-09-24", SITE_TZ)).toBe(false);
    expect(isNextDay(late, "2026-09-24", "Australia/Adelaide")).toBe(true);
  });
});

describe("todayScheduleItems", () => {
  const item = (scheduleId: number, airingAt: number) => ({ scheduleId, airingAt });

  test("takes the group the API calls today, sorted by airing time", () => {
    const out = todayScheduleItems({
      today: "2026-09-24",
      groups: {
        "2026-09-24": [item(2, 300), item(1, 100)],
        "2026-09-25": [item(3, 900)],
      },
    });
    expect(out.map((i) => i.scheduleId)).toEqual([1, 2]);
  });

  test("an empty or failed schedule is no items, not a crash", () => {
    expect(todayScheduleItems({ today: "", groups: {} })).toEqual([]);
    expect(todayScheduleItems({ today: "2026-09-24", groups: {} })).toEqual([]);
  });
});
