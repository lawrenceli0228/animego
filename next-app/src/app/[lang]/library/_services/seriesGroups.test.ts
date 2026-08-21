import { describe, expect, test } from "bun:test";

import {
  buildGroupTotals,
  foldGroupProgress,
  resolveEpisodeGridLength,
  sumGroupTotals,
  type GroupOverrideRow,
  type GroupProgressInfo,
  type GroupSeasonRow,
  type GroupSeriesRow,
} from "./seriesGroups";

// ─── fixtures ───────────────────────────────────────────────────────────────

const series = (id: string, totalEpisodes?: number | null): GroupSeriesRow => ({
  id,
  ...(totalEpisodes === undefined ? {} : { totalEpisodes }),
});

const season = (
  seriesId: string,
  animeId: number | null,
  number = 1,
): GroupSeasonRow => ({ seriesId, animeId, number });

const mergedInto = (
  target: string,
  sources: string[],
): GroupOverrideRow => ({ seriesId: target, mergedFrom: sources });

const progress = (
  watchedCount: number,
  completedCount: number,
  lastPlayedAt = 0,
): GroupProgressInfo => ({ watchedCount, completedCount, lastPlayedAt });

// ─── buildGroupTotals ───────────────────────────────────────────────────────

describe("buildGroupTotals — a card that was never merged", () => {
  test("reports the series' own total", () => {
    const totals = buildGroupTotals([series("A", 12)], [season("A", 100)], []);
    expect(totals.get("A")).toBe(12);
  });

  test("reports it even with no Season row at all", () => {
    // A group of one has nothing it could be a duplicate OF, so the season
    // identity is irrelevant. Without this branch an import whose dandanplay
    // match failed would keep reading "unknown" forever, which is the exact
    // bug this whole change exists to fix.
    const totals = buildGroupTotals([series("A", 12)], [], []);
    expect(totals.get("A")).toBe(12);
  });

  test("stores nothing when the total is unknown", () => {
    // Absent, not 0 — every reader spells unknown as `<= 0`, so a stored zero
    // would only be a second way to say the same thing.
    const totals = buildGroupTotals(
      [series("A"), series("B", 0), series("C", -3)],
      [season("A", 100), season("B", 101), season("C", 102)],
      [],
    );
    expect(totals.has("A")).toBe(false);
    expect(totals.has("B")).toBe(false);
    expect(totals.has("C")).toBe(false);
  });
});

describe("buildGroupTotals — the same season recorded twice", () => {
  // dedupeSeriesByAnimeId merges rows that SHARE a Season.animeId. Summing
  // them would claim 24 episodes for a 12-episode show, and every ratio on the
  // card (progress bar, "3/12", done / almostDone / stalled) would be halved.
  test("does NOT sum two members that share one Season.animeId", () => {
    const totals = buildGroupTotals(
      [series("A", 12), series("B", 12)],
      [season("A", 100), season("B", 100)],
      [mergedInto("A", ["B"])],
    );
    expect(totals.get("A")).toBe(12);
  });

  test("the root's own value wins when both members know a number", () => {
    const totals = buildGroupTotals(
      [series("A", 12), series("B", 13)],
      [season("A", 100), season("B", 100)],
      [mergedInto("A", ["B"])],
    );
    expect(totals.get("A")).toBe(12);
  });

  test("a member that knows the number fills a slot the root left empty", () => {
    // Root has no total; the duplicate does. Claiming the slot with `undefined`
    // and moving on would throw away the only answer in the group.
    const totals = buildGroupTotals(
      [series("A"), series("B", 12)],
      [season("A", 100), season("B", 100)],
      [mergedInto("A", ["B"])],
    );
    expect(totals.get("A")).toBe(12);
  });
});

describe("buildGroupTotals — genuinely different seasons", () => {
  // A manual MergeDialog merge of S1 + S2. Here summing IS the right answer,
  // and `mergedFrom` alone cannot tell this case from the one above.
  test("sums two members with different Season.animeIds", () => {
    const totals = buildGroupTotals(
      [series("A", 12), series("B", 13)],
      [season("A", 100), season("B", 200)],
      [mergedInto("A", ["B"])],
    );
    expect(totals.get("A")).toBe(25);
  });

  test("follows a three-level chain (A into B, then B into C)", () => {
    const totals = buildGroupTotals(
      [series("A", 12), series("B", 13), series("C", 24)],
      [season("A", 100), season("B", 200), season("C", 300)],
      [mergedInto("C", ["B"]), mergedInto("B", ["A"])],
    );
    // Reading one hop would give 24 + 13 and silently drop A's 12.
    expect(totals.get("C")).toBe(49);
  });

  test("a diamond counts a doubly-reachable member once", () => {
    const totals = buildGroupTotals(
      [series("A", 5), series("B", 7), series("C", 11), series("D", 13)],
      [
        season("A", 100),
        season("B", 200),
        season("C", 300),
        season("D", 400),
      ],
      [mergedInto("D", ["B", "C"]), mergedInto("B", ["A"]), mergedInto("C", ["A"])],
    );
    expect(totals.get("D")).toBe(13 + 7 + 11 + 5);
  });
});

describe("buildGroupTotals — members that cannot be identified", () => {
  test("a member with no Season row is treated as a duplicate", () => {
    // Under-count, deliberately. An over-count is the direction that starts
    // claiming episodes that are not there.
    const totals = buildGroupTotals(
      [series("A", 12), series("B", 13)],
      [season("A", 100)],
      [mergedInto("A", ["B"])],
    );
    expect(totals.get("A")).toBe(12);
  });

  test("a member whose Season carries no animeId is treated the same", () => {
    const totals = buildGroupTotals(
      [series("A", 12), series("B", 13)],
      [season("A", 100), season("B", null)],
      [mergedInto("A", ["B"])],
    );
    expect(totals.get("A")).toBe(12);
  });

  test("an unidentifiable ROOT still contributes nothing to a merged group", () => {
    const totals = buildGroupTotals(
      [series("A", 12), series("B", 13)],
      [season("B", 200)],
      [mergedInto("A", ["B"])],
    );
    expect(totals.get("A")).toBe(13);
  });

  test("a merged group where nothing is identifiable stores no total", () => {
    const totals = buildGroupTotals(
      [series("A", 12), series("B", 13)],
      [],
      [mergedInto("A", ["B"])],
    );
    expect(totals.has("A")).toBe(false);
  });
});

describe("buildGroupTotals — multi-season members", () => {
  test("identity is the lowest-numbered season's animeId", () => {
    // Both members' PRIMARY season is 100 — the same season twice — even though
    // one of them also carries a second season row.
    const totals = buildGroupTotals(
      [series("A", 12), series("B", 12)],
      [season("A", 100, 1), season("A", 200, 2), season("B", 100, 1)],
      [mergedInto("A", ["B"])],
    );
    expect(totals.get("A")).toBe(12);
  });

  test("ties on season number break deterministically on the lower animeId", () => {
    const forward = buildGroupTotals(
      [series("A", 12), series("B", 12)],
      [season("A", 900, 1), season("A", 100, 1), season("B", 100, 1)],
      [mergedInto("A", ["B"])],
    );
    const reversed = buildGroupTotals(
      [series("A", 12), series("B", 12)],
      [season("A", 100, 1), season("A", 900, 1), season("B", 100, 1)],
      [mergedInto("A", ["B"])],
    );
    // Row order out of Dexie must not decide whether the grid sums or not.
    expect(forward.get("A")).toBe(reversed.get("A"));
    expect(forward.get("A")).toBe(12);
  });
});

describe("buildGroupTotals — hostile input", () => {
  test("a cycle in mergedFrom terminates instead of hanging", () => {
    // userOverride is user-writable state that outlives any one release, and a
    // loop here would freeze the grid with nothing in the console.
    const totals = buildGroupTotals(
      [series("A", 12), series("B", 13)],
      [season("A", 100), season("B", 200)],
      [mergedInto("A", ["B"]), mergedInto("B", ["A"])],
    );
    expect(totals.get("A")).toBe(25);
    expect(totals.get("B")).toBe(25);
  });

  test("a self-merge does not double-count", () => {
    const totals = buildGroupTotals(
      [series("A", 12)],
      [season("A", 100)],
      [mergedInto("A", ["A"])],
    );
    expect(totals.get("A")).toBe(12);
  });

  test("accepts overrides as a Map as well as an array", () => {
    // useUserOverride hands out a Map; Dexie hands out an array. Neither caller
    // should have to build a throwaway copy on every render.
    const asMap = new Map<string, GroupOverrideRow>([
      ["A", mergedInto("A", ["B"])],
    ]);
    const totals = buildGroupTotals(
      [series("A", 12), series("B", 13)],
      [season("A", 100), season("B", 200)],
      asMap,
    );
    expect(totals.get("A")).toBe(25);
  });

  test("empty and nullish inputs are answered, not thrown at", () => {
    expect(buildGroupTotals([], [], []).size).toBe(0);
    expect(buildGroupTotals(null, null, null).size).toBe(0);
    expect(buildGroupTotals(undefined, undefined, undefined).size).toBe(0);
  });
});

// ─── foldGroupProgress ──────────────────────────────────────────────────────

describe("foldGroupProgress", () => {
  test("combines the root's and the merged source's counts", () => {
    // The numerator has the same bug as the denominator: performMerge never
    // moves a progress row, so useSeriesProgressMap files the source's watch
    // history under the source id and the root's card never sees it.
    const folded = foldGroupProgress(
      new Map([
        ["A", progress(3, 2, 100)],
        ["B", progress(4, 4, 500)],
      ]),
      [series("A"), series("B")],
      [mergedInto("A", ["B"])],
    );
    expect(folded.get("A")).toEqual({
      watchedCount: 7,
      completedCount: 6,
      lastPlayedAt: 500,
    });
  });

  test("lastPlayedAt takes the newest across the group, not the sum", () => {
    const folded = foldGroupProgress(
      new Map([
        ["A", progress(1, 1, 900)],
        ["B", progress(1, 1, 100)],
      ]),
      [series("A")],
      [mergedInto("A", ["B"])],
    );
    expect(folded.get("A")?.lastPlayedAt).toBe(900);
  });

  test("follows a merge chain", () => {
    const folded = foldGroupProgress(
      new Map([
        ["A", progress(1, 1, 10)],
        ["B", progress(2, 2, 20)],
        ["C", progress(4, 3, 30)],
      ]),
      [series("C")],
      [mergedInto("C", ["B"]), mergedInto("B", ["A"])],
    );
    expect(folded.get("C")).toEqual({
      watchedCount: 7,
      completedCount: 6,
      lastPlayedAt: 30,
    });
  });

  test("a cycle terminates", () => {
    const folded = foldGroupProgress(
      new Map([
        ["A", progress(1, 1, 10)],
        ["B", progress(2, 2, 20)],
      ]),
      [series("A")],
      [mergedInto("A", ["B"]), mergedInto("B", ["A"])],
    );
    expect(folded.get("A")?.watchedCount).toBe(3);
  });

  test("a root with no progress anywhere in its group gets no entry", () => {
    // Same contract as the map coming in: absent means "never played", and
    // several callers test presence rather than the counts.
    const folded = foldGroupProgress(
      new Map([["Z", progress(1, 1, 10)]]),
      [series("A"), series("B")],
      [mergedInto("A", ["B"])],
    );
    expect(folded.has("A")).toBe(false);
  });

  test("an unmerged library folds to the same numbers it started with", () => {
    const raw = new Map([["A", progress(3, 2, 100)]]);
    const folded = foldGroupProgress(raw, [series("A")], []);
    expect(folded.get("A")).toEqual(raw.get("A") as GroupProgressInfo);
  });
});

// ─── the two together: what a merged card actually reads ────────────────────

describe("a soft-merged pair, denominator and numerator together", () => {
  // Fixing only the denominator makes a merged card WORSE than before: a bigger
  // total over a numerator still missing its merged-in source. Both halves have
  // to land in the same change, so this asserts the pair.
  const rows = [series("A", 12), series("B", 12)];
  const seasons = [season("A", 100), season("B", 200)];
  const overrides = [mergedInto("A", ["B"])];
  const raw = new Map([
    ["A", progress(12, 12, 100)],
    ["B", progress(12, 12, 200)],
  ]);

  test("two fully-watched 12-episode seasons read 24/24, not 12/24", () => {
    const totals = buildGroupTotals(rows, seasons, overrides);
    const folded = foldGroupProgress(raw, rows, overrides);
    const total = totals.get("A") as number;
    const done = folded.get("A")?.completedCount as number;

    expect(total).toBe(24);
    expect(done).toBe(24);
    expect(done / total).toBe(1);
  });

  test("the denominator alone would have halved it", () => {
    const totals = buildGroupTotals(rows, seasons, overrides);
    const unfolded = raw.get("A")?.completedCount as number;
    expect(unfolded / (totals.get("A") as number)).toBe(0.5);
  });
});

// ─── sumGroupTotals ─────────────────────────────────────────────────────────

describe("sumGroupTotals", () => {
  test("adds up the visible cards", () => {
    const totals = new Map([
      ["A", 24],
      ["C", 12],
    ]);
    expect(sumGroupTotals([series("A"), series("C")], totals)).toBe(36);
  });

  test("a card with no known total contributes zero rather than NaN", () => {
    expect(sumGroupTotals([series("A"), series("B")], new Map([["A", 12]]))).toBe(12);
  });

  test("counting merged-away sources too would double-count", () => {
    // Guard on the calling convention: B is inside A's group total already.
    const totals = new Map([
      ["A", 24],
      ["B", 12],
    ]);
    expect(sumGroupTotals([series("A")], totals)).toBe(24);
    expect(sumGroupTotals([series("A"), series("B")], totals)).toBe(36);
  });
});

// ─── MANDATORY REGRESSION R1 ────────────────────────────────────────────────

describe("R1 — a merged card must still show every episode on disk", () => {
  // Issue #75 (commit 5e26b94) shipped a merged card that displayed half its
  // episodes. That one came from the query; this is the same outcome reachable
  // from the arithmetic, because the detail sheet renders exactly
  // `Array.from({ length: total })` and looks each number up. Any total that
  // trusts a per-season count on a merged card truncates the grid, and the
  // files become unreachable from the UI while still sitting on disk.
  const twoSeasonsOnDisk = Array.from({ length: 24 }, (_, i) => ({
    number: i + 1,
  }));

  test("a per-season total does not truncate a two-season card", () => {
    // The failure mode: buildGroupTotals under-counted (a member with no
    // Season row), so the card declares 12 while 24 files are indexed.
    expect(resolveEpisodeGridLength(12, twoSeasonsOnDisk)).toBe(24);
  });

  test("an episode numbered past the declared total is still reachable", () => {
    // A special filed as episode 13 of a 12-episode season.
    expect(
      resolveEpisodeGridLength(12, [{ number: 1 }, { number: 13 }]),
    ).toBe(13);
  });

  test("the declared total still wins when it is the larger of the two", () => {
    // Only two episodes downloaded of a 24-episode show: the grid must show
    // all 24 slots so the user can see what is missing.
    expect(resolveEpisodeGridLength(24, [{ number: 1 }, { number: 2 }])).toBe(24);
  });

  test("an unknown total falls back to what is indexed", () => {
    expect(resolveEpisodeGridLength(undefined, twoSeasonsOnDisk)).toBe(24);
    expect(resolveEpisodeGridLength(0, twoSeasonsOnDisk)).toBe(24);
    expect(resolveEpisodeGridLength(null, twoSeasonsOnDisk)).toBe(24);
  });

  test("gaps in numbering do not shrink the grid below the highest number", () => {
    // Three files numbered 1, 2 and 12: length 3 would hide episode 12.
    expect(
      resolveEpisodeGridLength(0, [{ number: 1 }, { number: 2 }, { number: 12 }]),
    ).toBe(12);
  });

  test("an empty card still renders one slot rather than collapsing", () => {
    expect(resolveEpisodeGridLength(0, [])).toBe(1);
    expect(resolveEpisodeGridLength(undefined, null)).toBe(1);
  });

  test("unnumbered rows still each get a slot", () => {
    expect(
      resolveEpisodeGridLength(0, [{}, { number: undefined }, { number: 1 }]),
    ).toBe(3);
  });
});
