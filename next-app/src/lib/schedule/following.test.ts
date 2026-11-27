import { describe, expect, test } from "bun:test";
import { SITE_TZ } from "@/lib/home/time";
import { followingThisWeek, rowFollowState, sortFollowing, whenLabel } from "./following";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 23, 12, 40); // Wed 20:40 in Shanghai

const item = (id: number, offsetHours: number, ep: number) => ({ id, at: NOW + offsetHours * HOUR, ep });

// "我追的 · 本周": each show the reader follows that airs this week, once,
// at its first airing in the window, with one word for where they stand.

describe("followingThisWeek", () => {
  const days = [
    { items: [item(1, -2, 18), item(2, -1, 12), item(9, 1, 3)] },
    { items: [item(3, 26, 12), item(1, 30, 19)] },
    { items: [item(4, 50, 13)] },
  ];

  test("only followed shows, each once, at its first airing in the week", () => {
    const out = followingThisWeek(days, { 1: 17, 3: 10 }, NOW);
    expect(out.map((e) => [e.item.id, e.item.ep])).toEqual([
      [1, 18],
      [3, 12],
    ]);
  });

  test("aired and newer than your progress: unwatched", () => {
    expect(followingThisWeek(days, { 1: 17 }, NOW)[0].state).toBe("unwatched");
  });

  test("aired and you have seen it: watched", () => {
    expect(followingThisWeek(days, { 2: 12 }, NOW)[0].state).toBe("watched");
  });

  test("not out yet, but an earlier episode is: behind by that many", () => {
    // Episode 12 airs tomorrow; at 10 the reader has not seen 11, which is out.
    const [entry] = followingThisWeek(days, { 3: 10 }, NOW);
    expect(entry.state).toBe("behind");
    expect(entry.behind).toBe(1);
  });

  test("not out yet and you are caught up: upcoming", () => {
    const [entry] = followingThisWeek(days, { 4: 12 }, NOW);
    expect(entry.state).toBe("upcoming");
    expect(entry.behind).toBe(0);
  });

  test("progress 0 counts as following from the start", () => {
    expect(followingThisWeek(days, { 4: 0 }, NOW)[0]).toMatchObject({ state: "behind", behind: 12 });
  });

  test("sorted by when they air, not by id or by day order of the input", () => {
    // Air order (7 at +3h, then 6 at +5h) disagrees with id order and with
    // input order, so a sort on either would fail here.
    const out = followingThisWeek(
      [{ items: [item(6, 5, 2), item(7, 3, 2)] }],
      { 6: 0, 7: 0 },
      NOW,
    );
    expect(out.map((e) => e.item.id)).toEqual([7, 6]);
  });

  test("nobody followed, nothing listed", () => {
    expect(followingThisWeek(days, {}, NOW)).toEqual([]);
  });
});

describe("unseen — episodes already out that the reader has not watched", () => {
  const days = [{ items: [item(1, -2, 18), item(3, 26, 12)] }];

  test("aired past your progress: everything from your progress to this episode", () => {
    expect(followingThisWeek(days, { 1: 15 }, NOW)[0].unseen).toBe(3);
  });

  test("aired and caught up: none", () => {
    expect(followingThisWeek(days, { 1: 18 }, NOW)[0].unseen).toBe(0);
  });

  test("not out yet: the episodes before it you have not seen", () => {
    expect(followingThisWeek(days, { 3: 8 }, NOW)[0].unseen).toBe(3);
    expect(followingThisWeek(days, { 3: 11 }, NOW)[0].unseen).toBe(0);
  });
});

describe("sortFollowing — the box's two orders", () => {
  // 10 airs first but you are caught up; 11 airs next, 1 unseen; 12 airs last,
  // 4 unseen; 13 airs between 11 and 12, also 1 unseen.
  const days = [
    { items: [item(10, -6, 5), item(11, -4, 9), item(13, -3, 4), item(12, 20, 8)] },
  ];
  const progress = { 10: 5, 11: 8, 12: 3, 13: 3 };
  const entries = followingThisWeek(days, progress, NOW);

  test("time: by when each airs", () => {
    const shuffled = [entries[2], entries[0], entries[3], entries[1]];
    expect(sortFollowing(shuffled, "time").map((e) => e.item.id)).toEqual([10, 11, 13, 12]);
  });

  test("unseen first: most unseen first, ties by air time, caught-up shows last", () => {
    expect(sortFollowing(entries, "unseen").map((e) => e.item.id)).toEqual([12, 11, 13, 10]);
  });

  test("returns a new array and leaves the input order alone", () => {
    const before = entries.map((e) => e.item.id);
    const out = sortFollowing(entries, "unseen");
    expect(out).not.toBe(entries);
    expect(entries.map((e) => e.item.id)).toEqual(before);
  });
});

describe("rowFollowState — the pill on a schedule row", () => {
  test("not followed: no pill", () => {
    expect(rowFollowState(12, undefined, true)).toBeNull();
  });

  test("aired past your progress reads unwatched; anything else following", () => {
    expect(rowFollowState(12, 11, true)).toBe("unwatched");
    expect(rowFollowState(12, 12, true)).toBe("following");
    expect(rowFollowState(12, 11, false)).toBe("following");
  });
});

describe("whenLabel", () => {
  test("today's airings say today, in the zone's own calendar", () => {
    expect(whenLabel(NOW + HOUR, NOW, SITE_TZ, "zh", "今天")).toBe("今天 21:40");
  });

  test("other days say their weekday", () => {
    expect(whenLabel(NOW + 26 * HOUR, NOW, SITE_TZ, "zh", "今天")).toBe("周四 22:40");
    expect(whenLabel(NOW + 26 * HOUR, NOW, SITE_TZ, "en", "Today")).toBe("Thu 22:40");
  });

  test("an airing after midnight is the next day's weekday, not the group's", () => {
    // 06:40 Thursday in Shanghai sits in Wednesday's API group (UTC day).
    expect(whenLabel(Date.UTC(2026, 8, 23, 22, 40), NOW, SITE_TZ, "zh", "今天")).toBe("周四 06:40");
  });
});
