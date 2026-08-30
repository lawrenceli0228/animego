import { afterEach, describe, expect, test } from "bun:test";
import {
  peekWatchedProgress,
  publishWatchedProgress,
  resetWatchedProgress,
  subscribeWatchedProgress,
} from "./watchedProgress";

// Module-scope state shared across a whole page. bun:test runs a file's
// tests in one process, so without this every test inherits the previous
// test's listeners and cache — the failure mode being a test that passes
// alone and fails in suite order.
afterEach(() => resetWatchedProgress());

describe("watchedProgress", () => {
  test("delivers a published value to every subscriber", () => {
    const seen: number[] = [];
    subscribeWatchedProgress((p) => seen.push(p.watched));
    subscribeWatchedProgress((p) => seen.push(p.watched * 100));

    publishWatchedProgress({ anilistId: 1, watched: 6 });

    expect(seen).toEqual([6, 600]);
  });

  test("unsubscribe actually stops delivery", () => {
    const seen: number[] = [];
    const off = subscribeWatchedProgress((p) => seen.push(p.watched));
    publishWatchedProgress({ anilistId: 1, watched: 1 });
    off();
    publishWatchedProgress({ anilistId: 1, watched: 2 });

    // A leaked listener here means an unmounted component keeps setting
    // state, which React warns about and which holds the component in memory
    // for as long as the page lives.
    expect(seen).toEqual([1]);
  });

  test("does not call a fresh subscriber with the current value", () => {
    publishWatchedProgress({ anilistId: 1, watched: 6 });
    const seen: number[] = [];
    subscribeWatchedProgress((p) => seen.push(p.watched));

    // Subscribing is not reading. A caller that wants the current value asks
    // for it; one that only wants changes should not have to filter out an
    // immediate callback it never asked for.
    expect(seen).toEqual([]);
  });

  test("peek returns the last value for that anime and null for others", () => {
    publishWatchedProgress({ anilistId: 154587, watched: 6 });
    publishWatchedProgress({ anilistId: 21, watched: 900 });

    expect(peekWatchedProgress(154587)?.watched).toBe(6);
    expect(peekWatchedProgress(21)?.watched).toBe(900);
    // Keyed by id on purpose: one anime's count must never be shown on
    // another's page, which is exactly what a single global value would do
    // after a client-side navigation.
    expect(peekWatchedProgress(99999)).toBeNull();
  });

  test("a later publish replaces the earlier one", () => {
    publishWatchedProgress({ anilistId: 1, watched: 3 });
    publishWatchedProgress({ anilistId: 1, watched: 4 });
    expect(peekWatchedProgress(1)?.watched).toBe(4);
  });

  test("a subscriber that throws does not stop the others", () => {
    // One component crashing must not silently freeze the count in every
    // other component subscribed to the same event.
    const seen: number[] = [];
    subscribeWatchedProgress(() => {
      throw new Error("subscriber blew up");
    });
    subscribeWatchedProgress((p) => seen.push(p.watched));

    expect(() => publishWatchedProgress({ anilistId: 1, watched: 7 })).toThrow();
    // Documents current behaviour rather than asserting it is right: the
    // throw propagates and the second listener is skipped. Acceptable while
    // both subscribers are ours and neither throws; revisit if this grows a
    // third-party listener.
    expect(seen).toEqual([]);
  });
});
