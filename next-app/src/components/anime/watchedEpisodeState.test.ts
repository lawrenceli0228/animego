import { describe, expect, test } from "bun:test";
import {
  EMPTY_WATCHED_TRACKER,
  autoStatusForSet,
  beginToggle,
  confirmToggle,
  coversEveryEpisode,
  episodeCellState,
  failWrite,
  furthestMarked,
  isFurthestMarked,
  isWatchedCell,
  latestWatched,
  parseWatchedEpisodes,
  parseWatchedSnapshot,
  settleWrite,
  visibleWatched,
  watchedInGrid,
} from "./watchedEpisodeState";

const set = (...episodes: number[]) => new Set(episodes);

/** Draw the grid the way EpisodesGrid does and read every cell's state. */
const paint = (watched: ReadonlySet<number>, completed: boolean, total: number) =>
  Array.from({ length: total }, (_, i) =>
    episodeCellState(watched, completed, i + 1),
  );

describe("episodeCellState — membership, and nothing else", () => {
  test("an episode in the set is watched", () => {
    expect(episodeCellState(set(5), false, 5)).toBe("watched");
  });

  test("watching only episode 5 does NOT mark 1-4", () => {
    // THE bug. The old grid derived `watched` from a single currentEpisode
    // counter, so every cell below the counter inherited a checkmark it had no
    // evidence for. Four false claims about four specific episodes.
    expect(paint(set(5), false, 6)).toEqual([
      "unwatched",
      "unwatched",
      "unwatched",
      "unwatched",
      "watched",
      "unwatched",
    ]);
  });

  test("a gap in the middle stays a gap", () => {
    // The other shape of the same rule: the set is not an interval, and a
    // reader who skipped 3 must keep seeing 3 unmarked.
    expect(paint(set(1, 2, 4), false, 4)).toEqual([
      "watched",
      "watched",
      "unwatched",
      "watched",
    ]);
  });

  test("an empty set marks nothing", () => {
    expect(paint(set(), false, 3)).toEqual([
      "unwatched",
      "unwatched",
      "unwatched",
    ]);
  });

  test("completed marks every cell", () => {
    // Not an inference: status === "completed" is a statement the reader made
    // about the whole show, so every cell inheriting it is that statement being
    // repeated, not a new one being invented.
    expect(paint(set(), true, 4)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
  });

  test("completed outranks a partial set", () => {
    expect(paint(set(2), true, 3)).toEqual(["completed", "completed", "completed"]);
  });

  test("isWatchedCell treats both claims as a checkmark", () => {
    expect(isWatchedCell(set(2), false, 2)).toBe(true);
    expect(isWatchedCell(set(), true, 2)).toBe(true);
    expect(isWatchedCell(set(2), false, 3)).toBe(false);
  });
});

describe("out-of-range members are inert, never fatal", () => {
  test("a member past the last cell changes no cell", () => {
    // A catalogue count that shrank, or an automated write from a file numbered
    // past the season, can legally leave a 99 in the set of a 12-episode grid.
    expect(paint(set(99), false, 3)).toEqual([
      "unwatched",
      "unwatched",
      "unwatched",
    ]);
  });

  test("it is not counted into the progress readout either", () => {
    // Counting it would print "2 / 3" for one watched episode, or worse
    // "14 / 12" — a readout that is visibly impossible.
    expect(watchedInGrid(set(1, 99), false, 3)).toBe(1);
  });

  test("and it cannot become the reading position", () => {
    expect(latestWatched(set(1, 99), false, 3)).toBe(1);
  });

  test("zero and negatives never match a cell", () => {
    expect(episodeCellState(set(0, -4), false, 1)).toBe("unwatched");
  });
});

describe("furthestMarked — a fact about the set, not about its neighbours", () => {
  test("the maximum mark, not the count", () => {
    expect(furthestMarked(set(1, 5, 9), 12)).toBe(9);
    expect(watchedInGrid(set(1, 5, 9), false, 12)).toBe(3);
  });

  test("a single mark is its own furthest", () => {
    expect(furthestMarked(set(5), 12)).toBe(5);
    expect(isFurthestMarked(set(5), 12, 5)).toBe(true);
  });

  test("and it annotates that cell only", () => {
    // The annotation must not spread the way the old inference did: 5 is the
    // furthest MARK, which says nothing whatsoever about 1-4.
    const marks = [1, 2, 3, 4, 5, 6].map((n) => isFurthestMarked(set(5), 6, n));
    expect(marks).toEqual([false, false, false, false, true, false]);
  });

  test("an empty set has no furthest mark", () => {
    expect(furthestMarked(set(), 12)).toBeNull();
    expect(isFurthestMarked(set(), 12, 1)).toBe(false);
  });

  test("a grid with no cells has none either", () => {
    expect(furthestMarked(set(1, 2), 0)).toBeNull();
  });

  test("a member past the last cell cannot become the annotation", () => {
    expect(furthestMarked(set(1, 99), 3)).toBe(1);
    expect(isFurthestMarked(set(1, 99), 3, 3)).toBe(false);
  });

  test("`completed` alone never invents a mark", () => {
    // The case that makes this a separate function from latestWatched: a reader
    // who set the status from the dropdown has marked nothing, so there is no
    // cell that "furthest marked" could honestly point at.
    expect(furthestMarked(set(), 12)).toBeNull();
    // …while the comment preview, which is a reading position rather than a
    // mark, still has an answer for them.
    expect(latestWatched(set(), true, 12)).toBe(12);
  });

  test("with marks under `completed` the two agree", () => {
    expect(furthestMarked(set(1, 2, 3), 3)).toBe(3);
    expect(latestWatched(set(1, 2, 3), true, 3)).toBe(3);
  });
});

describe("coversEveryEpisode", () => {
  test("true only when every drawn cell is in the set", () => {
    expect(coversEveryEpisode(set(1, 2, 3), 3)).toBe(true);
    expect(coversEveryEpisode(set(1, 3), 3)).toBe(false);
    expect(coversEveryEpisode(set(1, 2, 3, 4), 3)).toBe(true);
  });

  test("a gap anywhere is enough to fail it", () => {
    expect(coversEveryEpisode(set(1, 2, 4, 5), 5)).toBe(false);
  });

  test("no cells is not 'all cells'", () => {
    expect(coversEveryEpisode(set(), 0)).toBe(false);
    expect(coversEveryEpisode(set(1, 2), 0)).toBe(false);
    expect(coversEveryEpisode(set(), 3)).toBe(false);
  });
});

describe("autoStatusForSet", () => {
  test("the last remaining episode completes the show", () => {
    expect(autoStatusForSet("watching", set(1, 2, 3), 3)).toBe("completed");
  });

  test("a partial set leaves a watching show alone", () => {
    expect(autoStatusForSet("watching", set(1, 2), 3)).toBeNull();
  });

  test("an already-completed show with a full set stays put", () => {
    expect(autoStatusForSet("completed", set(1, 2, 3), 3)).toBeNull();
  });

  test("un-marking anything walks a completed show back to watching", () => {
    expect(autoStatusForSet("completed", set(1, 2), 3)).toBe("watching");
  });

  test("plan_to_watch and dropped complete too", () => {
    // Marking every episode of a show you had shelved is still finishing it.
    expect(autoStatusForSet("plan_to_watch", set(1, 2), 2)).toBe("completed");
    expect(autoStatusForSet("dropped", set(1, 2), 2)).toBe("completed");
  });

  test("an unconfirmed total can never complete a show", () => {
    // `confirmedTotal` is 0 for episodeGridSkeleton's `inferred` and `pending`
    // arms. Marking all eight cells of a show whose real run is twelve must not
    // rewrite the reader's status off our lower bound.
    expect(autoStatusForSet("watching", set(1, 2, 3), 0)).toBeNull();
  });

  test("but it can always leave one", () => {
    // Otherwise `completed` paints every cell watched on a show with no
    // confirmed count and the toggles have nowhere to go — a control that
    // cannot change anything.
    expect(autoStatusForSet("completed", set(), 0)).toBe("watching");
    expect(autoStatusForSet("completed", set(1, 2, 3), 0)).toBe("watching");
  });

  test("a missing status is treated as not-completed", () => {
    expect(autoStatusForSet(null, set(1), 1)).toBe("completed");
    expect(autoStatusForSet(undefined, set(), 1)).toBeNull();
  });
});

describe("watchedInGrid / latestWatched", () => {
  test("counts only what is inside the grid", () => {
    expect(watchedInGrid(set(1, 2, 3), false, 12)).toBe(3);
  });

  test("completed counts every cell without needing the set", () => {
    expect(watchedInGrid(set(), true, 12)).toBe(12);
  });

  test("a grid with no cells counts nothing", () => {
    expect(watchedInGrid(set(1, 2), false, 0)).toBe(0);
    expect(latestWatched(set(1, 2), false, 0)).toBeNull();
  });

  test("latestWatched is the maximum, not the count", () => {
    // The distinction the old counter could not make: three watched episodes
    // whose furthest point is 9.
    expect(latestWatched(set(1, 5, 9), false, 12)).toBe(9);
    expect(watchedInGrid(set(1, 5, 9), false, 12)).toBe(3);
  });

  test("nothing watched has no reading position", () => {
    expect(latestWatched(set(), false, 12)).toBeNull();
  });

  test("completed reads as the last episode", () => {
    expect(latestWatched(set(), true, 12)).toBe(12);
  });
});

describe("parseWatchedEpisodes", () => {
  test("reads the documented envelope", () => {
    expect(
      parseWatchedEpisodes({ data: { anilistId: 1, watchedEpisodes: [3, 1, 2] } }),
    ).toEqual([1, 2, 3]);
  });

  test("accepts the bare object and the bare array", () => {
    expect(parseWatchedEpisodes({ watchedEpisodes: [2] })).toEqual([2]);
    expect(parseWatchedEpisodes([2, 1])).toEqual([1, 2]);
  });

  test("de-duplicates and sorts", () => {
    expect(parseWatchedEpisodes({ data: { watchedEpisodes: [5, 5, 1] } })).toEqual([
      1, 5,
    ]);
  });

  test("drops members that are not usable episode numbers", () => {
    expect(
      parseWatchedEpisodes({
        data: { watchedEpisodes: [1, 0, -2, 2.5, "3", null, NaN, Infinity, 4] },
      }),
    ).toEqual([1, 4]);
  });

  test("a half-episode special does not mark the episode it sits inside", () => {
    // episodeGridSkeleton floors 12.5 to size a grid, because a special lives
    // inside episode 12's row. Here the number IS the claim, so 5.5 is dropped
    // rather than folded into 5.
    expect(parseWatchedEpisodes({ data: { watchedEpisodes: [5.5] } })).toEqual([]);
  });

  test("a missing, null or malformed field yields an empty set, not a guess", () => {
    // The degraded path while the endpoint is not live yet. Empty is the honest
    // answer: no per-episode record exists, so no cell may claim one.
    expect(parseWatchedEpisodes({ data: { currentEpisode: 8 } })).toEqual([]);
    expect(parseWatchedEpisodes({ data: { watchedEpisodes: null } })).toEqual([]);
    expect(parseWatchedEpisodes(null)).toEqual([]);
    expect(parseWatchedEpisodes("nope")).toEqual([]);
  });
});

describe("parseWatchedSnapshot", () => {
  test("prefers the server's derived currentEpisode", () => {
    expect(
      parseWatchedSnapshot({ data: { watchedEpisodes: [1, 2], currentEpisode: 2 } }),
    ).toEqual({ stated: true, watchedEpisodes: [1, 2], currentEpisode: 2 });
  });

  test("falls back to the maximum when the field is absent", () => {
    expect(parseWatchedSnapshot({ data: { watchedEpisodes: [4, 1] } })).toEqual({
      stated: true,
      watchedEpisodes: [1, 4],
      currentEpisode: 4,
    });
  });

  test("an empty set the server DID state is position zero", () => {
    expect(parseWatchedSnapshot({ data: { watchedEpisodes: [] } })).toEqual({
      stated: true,
      watchedEpisodes: [],
      currentEpisode: 0,
    });
  });

  test("a nonsense currentEpisode is ignored in favour of the set", () => {
    expect(
      parseWatchedSnapshot({ data: { watchedEpisodes: [3], currentEpisode: -1 } }),
    ).toEqual({ stated: true, watchedEpisodes: [3], currentEpisode: 3 });
  });

  test("a body that states no set is marked unstated", () => {
    // A 204, a truncated body, or an endpoint that predates the field. All
    // three parse to an empty array and must NOT be mistaken for "you have
    // watched nothing" — see confirmToggle.
    expect(parseWatchedSnapshot(null).stated).toBe(false);
    expect(parseWatchedSnapshot({}).stated).toBe(false);
    expect(parseWatchedSnapshot({ data: { currentEpisode: 3 } }).stated).toBe(false);
    expect(parseWatchedSnapshot({ data: { watchedEpisodes: null } }).stated).toBe(
      false,
    );
  });
});

describe("optimistic toggle", () => {
  test("flips the cell before the server answers", () => {
    const { tracker, watched } = beginToggle(EMPTY_WATCHED_TRACKER, 5, 1, false);
    expect(watched).toBe(true);
    expect(visibleWatched(tracker).has(5)).toBe(true);
    // …and only that cell.
    expect(visibleWatched(tracker).has(4)).toBe(false);
  });

  test("a second click reverses what is on screen, not what the server said", () => {
    const first = beginToggle(EMPTY_WATCHED_TRACKER, 5, 1, false);
    const second = beginToggle(first.tracker, 5, 2, false);
    expect(second.watched).toBe(false);
    expect(visibleWatched(second.tracker).has(5)).toBe(false);
  });

  test("under `completed` a click un-marks, even with an empty set behind it", () => {
    // A reader who set the status from the dropdown has every cell painted
    // green over a set holding nothing. Reading the intent off the set alone
    // would answer "mark it watched" — a click on a checkmark that leaves the
    // checkmark exactly where it was.
    const { watched } = beginToggle(EMPTY_WATCHED_TRACKER, 5, 1, true);
    expect(watched).toBe(false);
  });

  test("under `completed` a click on a marked cell also un-marks", () => {
    const seeded = settleWrite(EMPTY_WATCHED_TRACKER, 1, null, [1, 2, 3]);
    expect(beginToggle(seeded, 3, 2, true).watched).toBe(false);
  });

  test("reconciles to the server's set", () => {
    const { tracker } = beginToggle(EMPTY_WATCHED_TRACKER, 5, 1, false);
    const settled = settleWrite(tracker, 1, 5, [5]);
    expect([...visibleWatched(settled)]).toEqual([5]);
    expect(settled.pending.size).toBe(0);
  });

  test("reconciles even when the server disagrees with the optimistic paint", () => {
    // The server is the record. If it answers a "mark 5 watched" with a set
    // that does not contain 5 — a concurrent removal from another tab, a rule
    // we do not know about — the cell has to end up matching the record rather
    // than the click.
    const { tracker } = beginToggle(EMPTY_WATCHED_TRACKER, 5, 1, false);
    expect(visibleWatched(tracker).has(5)).toBe(true);
    const settled = settleWrite(tracker, 1, 5, [1, 2]);
    expect([...visibleWatched(settled)]).toEqual([1, 2]);
  });

  test("the server may also add episodes the click never mentioned", () => {
    const { tracker } = beginToggle(EMPTY_WATCHED_TRACKER, 3, 1, false);
    const settled = settleWrite(tracker, 1, 3, [1, 2, 3]);
    expect([...visibleWatched(settled)].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  test("garbage in a response body cannot poison the set", () => {
    const { tracker } = beginToggle(EMPTY_WATCHED_TRACKER, 3, 1, false);
    const settled = settleWrite(
      tracker,
      1,
      3,
      parseWatchedEpisodes({ data: { watchedEpisodes: [3, "x", -1, 2.5] } }),
    );
    expect([...visibleWatched(settled)]).toEqual([3]);
  });
});

describe("concurrent clicks on different episodes", () => {
  test("both stay flipped while both are in flight", () => {
    const a = beginToggle(EMPTY_WATCHED_TRACKER, 5, 1, false);
    const b = beginToggle(a.tracker, 7, 2, false);
    expect([...visibleWatched(b.tracker)].sort((x, y) => x - y)).toEqual([5, 7]);
  });

  test("a late, stale response does not delete the newer episode", () => {
    // The clobber this guard exists for. Click 5 (token 1), click 7 (token 2).
    // Token 2's response lands first carrying {5,7}. Token 1's response then
    // arrives carrying {5} — the world as it was before 7 was written. Adopting
    // it would wipe 7 out from under a reader who watched it.
    const a = beginToggle(EMPTY_WATCHED_TRACKER, 5, 1, false);
    const b = beginToggle(a.tracker, 7, 2, false);

    const afterNewer = settleWrite(b.tracker, 2, 7, [5, 7]);
    const afterStale = settleWrite(afterNewer, 1, 5, [5]);

    expect([...visibleWatched(afterStale)].sort((x, y) => x - y)).toEqual([5, 7]);
    expect(afterStale.pending.size).toBe(0);
  });

  test("in-order responses land normally", () => {
    const a = beginToggle(EMPTY_WATCHED_TRACKER, 5, 1, false);
    const b = beginToggle(a.tracker, 7, 2, false);
    const first = settleWrite(b.tracker, 1, 5, [5]);
    const second = settleWrite(first, 2, 7, [5, 7]);
    expect([...visibleWatched(second)].sort((x, y) => x - y)).toEqual([5, 7]);
  });

  test("an older baseline still cannot hide a click that has not landed", () => {
    // Token 1 (mark 5) is still in flight when token 2 (mark 7) comes back with
    // a set the server built before 5 was written. The baseline moves, but 5 is
    // painted from `pending`, so the reader never sees their click vanish.
    const a = beginToggle(EMPTY_WATCHED_TRACKER, 5, 1, false);
    const b = beginToggle(a.tracker, 7, 2, false);
    const afterNewer = settleWrite(b.tracker, 2, 7, [7]);
    expect([...visibleWatched(afterNewer)].sort((x, y) => x - y)).toEqual([5, 7]);
  });

  test("an un-watch in flight survives a baseline that still contains it", () => {
    const seeded = settleWrite(EMPTY_WATCHED_TRACKER, 1, null, [5, 7]);
    const off = beginToggle(seeded, 7, 2, false);
    expect(off.watched).toBe(false);
    // A read that started before the DELETE answers with 7 still present.
    const stale = settleWrite(off.tracker, 3, null, [5, 7]);
    expect([...visibleWatched(stale)]).toEqual([5]);
  });
});

describe("failure rolls back, and says so", () => {
  test("a failed write reverts its cell and reports the rollback", () => {
    const { tracker } = beginToggle(EMPTY_WATCHED_TRACKER, 5, 1, false);
    const { tracker: after, rolledBack } = failWrite(tracker, 1, 5);
    expect(rolledBack).toBe(true);
    expect(visibleWatched(after).has(5)).toBe(false);
  });

  test("it leaves other cells alone", () => {
    const a = beginToggle(EMPTY_WATCHED_TRACKER, 5, 1, false);
    const b = beginToggle(a.tracker, 7, 2, false);
    const { tracker: after } = failWrite(b.tracker, 1, 5);
    expect([...visibleWatched(after)]).toEqual([7]);
  });

  test("un-watching something confirmed puts it back", () => {
    const seeded = settleWrite(EMPTY_WATCHED_TRACKER, 1, null, [5]);
    const off = beginToggle(seeded, 5, 2, false);
    expect(visibleWatched(off.tracker).has(5)).toBe(false);
    const { tracker: after, rolledBack } = failWrite(off.tracker, 2, 5);
    expect(rolledBack).toBe(true);
    expect(visibleWatched(after).has(5)).toBe(true);
  });

  test("a superseded failure neither repaints nor apologises", () => {
    // Click 5 on (token 1), click 5 off (token 2), then token 1 fails. Reverting
    // would repaint the cell as watched while the reader's live intent — the
    // un-watch — is still on its way, and the toast would name a state that is
    // no longer on screen.
    const on = beginToggle(EMPTY_WATCHED_TRACKER, 5, 1, false);
    const off = beginToggle(on.tracker, 5, 2, false);
    const { tracker: after, rolledBack } = failWrite(off.tracker, 1, 5);
    expect(rolledBack).toBe(false);
    expect(visibleWatched(after).has(5)).toBe(false);
    expect(after).toBe(off.tracker);
  });

  test("a failure for a cell with nothing in flight is a no-op", () => {
    const { tracker, rolledBack } = failWrite(EMPTY_WATCHED_TRACKER, 9, 5);
    expect(rolledBack).toBe(false);
    expect(tracker).toBe(EMPTY_WATCHED_TRACKER);
  });
});

describe("confirmToggle — a success that states no set", () => {
  test("promotes only its own cell and leaves the rest of the baseline alone", () => {
    // The failure this exists for: routing a 204 through settleWrite would feed
    // it the empty array the body parsed to, adopt that as the baseline, and
    // erase episodes 1 and 2 from a reader who had marked them.
    const seeded = settleWrite(EMPTY_WATCHED_TRACKER, 1, null, [1, 2]);
    const { tracker } = beginToggle(seeded, 5, 2, false);
    const after = confirmToggle(tracker, 2, 5, true);
    expect([...visibleWatched(after)].sort((a, b) => a - b)).toEqual([1, 2, 5]);
    expect(after.pending.size).toBe(0);
  });

  test("an un-watch removes only its own cell", () => {
    const seeded = settleWrite(EMPTY_WATCHED_TRACKER, 1, null, [1, 2, 5]);
    const { tracker } = beginToggle(seeded, 5, 2, false);
    const after = confirmToggle(tracker, 2, 5, false);
    expect([...visibleWatched(after)].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  test("it does not move `settled`, so a real answer still outranks it", () => {
    const seeded = settleWrite(EMPTY_WATCHED_TRACKER, 1, null, [1]);
    const { tracker } = beginToggle(seeded, 5, 2, false);
    const after = confirmToggle(tracker, 2, 5, true);
    expect(after.settled).toBe(1);
    // A set stated by a later write is still allowed to land.
    const real = settleWrite(after, 3, null, [1, 5, 9]);
    expect([...visibleWatched(real)].sort((a, b) => a - b)).toEqual([1, 5, 9]);
  });

  test("a cell a newer click has taken over keeps its pending paint", () => {
    const on = beginToggle(EMPTY_WATCHED_TRACKER, 5, 1, false);
    const off = beginToggle(on.tracker, 5, 2, false);
    const after = confirmToggle(off.tracker, 1, 5, true);
    // The first write really did land, so the baseline holds 5…
    expect(after.confirmed.has(5)).toBe(true);
    // …but the reader's live intent is the un-watch, and that still wins.
    expect(visibleWatched(after).has(5)).toBe(false);
    expect(after.pending.size).toBe(1);
  });
});

describe("settleWrite bookkeeping", () => {
  test("a response for a cell someone has since re-clicked keeps the new paint", () => {
    const on = beginToggle(EMPTY_WATCHED_TRACKER, 5, 1, false);
    const off = beginToggle(on.tracker, 5, 2, false);
    const settled = settleWrite(off.tracker, 1, 5, [5]);
    // Baseline adopted, but the un-watch is still pending and still winning.
    expect(settled.confirmed.has(5)).toBe(true);
    expect(visibleWatched(settled).has(5)).toBe(false);
    expect(settled.pending.size).toBe(1);
  });

  test("a read carries no cell and clears no pending write", () => {
    const { tracker } = beginToggle(EMPTY_WATCHED_TRACKER, 5, 2, false);
    const settled = settleWrite(tracker, 3, null, [1]);
    expect(settled.pending.size).toBe(1);
    expect([...visibleWatched(settled)].sort((a, b) => a - b)).toEqual([1, 5]);
  });

  test("a no-op settle returns the same object", () => {
    const settled = settleWrite(EMPTY_WATCHED_TRACKER, 0, null, [1, 2]);
    // token 0 is not greater than settled 0, and there is no cell to clear.
    expect(settled).toBe(EMPTY_WATCHED_TRACKER);
  });

  test("the empty tracker is not mutated by any of this", () => {
    // It is a module-level constant shared by every mounted grid; a helper that
    // reached into its Set would leak one anime's progress into another's.
    const on = beginToggle(EMPTY_WATCHED_TRACKER, 5, 1, false);
    settleWrite(on.tracker, 1, 5, [5]);
    expect(EMPTY_WATCHED_TRACKER.confirmed.size).toBe(0);
    expect(EMPTY_WATCHED_TRACKER.pending.size).toBe(0);
  });
});
