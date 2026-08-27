import { describe, expect, test } from "bun:test";
import { isTabListKey, nextTabIndex } from "./tabListNav";

// The weekday tabs had no keyboard navigation at all: seven plain buttons,
// seven tab stops, no relationship between them. This is the arithmetic that
// replaced that, and it is tested here rather than through the component
// because the repo has no DOM testing library — the same reason
// episodeGridSkeleton and torrentModalLogic are their own modules.

const COUNT = 7; // a week

describe("movement", () => {
  test("arrows step one at a time", () => {
    expect(nextTabIndex("ArrowRight", 2, COUNT)).toBe(3);
    expect(nextTabIndex("ArrowLeft", 2, COUNT)).toBe(1);
  });

  test("Home and End jump to the edges", () => {
    expect(nextTabIndex("Home", 4, COUNT)).toBe(0);
    expect(nextTabIndex("End", 4, COUNT)).toBe(COUNT - 1);
  });
});

describe("wrapping", () => {
  test("right off the end returns to the start", () => {
    expect(nextTabIndex("ArrowRight", COUNT - 1, COUNT)).toBe(0);
  });

  test("left off the start returns to the end, not to -1", () => {
    // JS `%` keeps the sign of the dividend, so (0 - 1) % 7 is -1. A -1 here
    // is a ref lookup that returns undefined and focus that silently does
    // not move — the failure looks like "the left arrow does nothing at the
    // first tab", which is easy to mistake for intended behaviour.
    expect(nextTabIndex("ArrowLeft", 0, COUNT)).toBe(COUNT - 1);
  });

  test("a full cycle in each direction lands back where it started", () => {
    let i = 0;
    for (let n = 0; n < COUNT; n++) i = nextTabIndex("ArrowRight", i, COUNT)!;
    expect(i).toBe(0);
    for (let n = 0; n < COUNT; n++) i = nextTabIndex("ArrowLeft", i, COUNT)!;
    expect(i).toBe(0);
  });

  test("every index stays in range for both directions", () => {
    for (let from = 0; from < COUNT; from++) {
      for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
        const to = nextTabIndex(key, from, COUNT)!;
        expect(to).toBeGreaterThanOrEqual(0);
        expect(to).toBeLessThan(COUNT);
      }
    }
  });
});

describe("keys this must not claim", () => {
  // The consequence of getting this wrong is worse than the missing arrow
  // keys it was added for: the caller calls preventDefault on any non-null
  // answer, so claiming Tab would trap a keyboard user inside the tablist.
  test("Tab, Enter, Space and ordinary characters fall through", () => {
    for (const key of ["Tab", "Enter", " ", "a", "Escape", "ArrowUp", "ArrowDown"]) {
      expect(nextTabIndex(key, 3, COUNT)).toBeNull();
      expect(isTabListKey(key)).toBe(false);
    }
  });

  test("ArrowUp and ArrowDown are not claimed by a horizontal tablist", () => {
    // Called out separately because they are the tempting ones to add. A
    // horizontal tablist leaves the vertical arrows to the page, which is
    // how a user scrolls while a tab has focus.
    expect(nextTabIndex("ArrowUp", 3, COUNT)).toBeNull();
    expect(nextTabIndex("ArrowDown", 3, COUNT)).toBeNull();
  });
});

describe("degenerate input", () => {
  test("an empty list has nowhere to go", () => {
    expect(nextTabIndex("ArrowRight", 0, 0)).toBeNull();
    expect(nextTabIndex("Home", 0, 0)).toBeNull();
  });

  test("a single tab always stays put", () => {
    expect(nextTabIndex("ArrowRight", 0, 1)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, 1)).toBe(0);
  });

  test("an out-of-range current index still yields a valid target", () => {
    // days.indexOf() returns -1 when the active day is not in the list,
    // which is reachable on the render where the schedule changes under a
    // selection.
    expect(nextTabIndex("ArrowRight", -1, COUNT)).toBe(1);
    expect(nextTabIndex("ArrowLeft", 99, COUNT)).toBe(COUNT - 1);
  });
});
