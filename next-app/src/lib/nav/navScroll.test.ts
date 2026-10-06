import { describe, expect, test } from "bun:test";
import {
  GLASS_AFTER_PX,
  HIDE_AFTER_PX,
  INITIAL_NAV_SCROLL,
  REVEAL_AFTER_PX,
  stepNavScroll,
  type NavScrollInput,
  type NavScrollState,
} from "./navScroll";

// The site header slides away while the reader scrolls down and comes back
// the moment they scroll up — AniList's behaviour. The decision lives here,
// free of the DOM, because every way it goes wrong is a sequence of numbers:
// a trackpad jitters a few pixels, a page bounces past its end on macOS, a
// keyboard user tabs into a header that is off-screen.

const BAR = 64;
const MAX = 5_000;

/** Feed a run of scroll positions through the machine, as the browser would. */
function scrollThrough(
  ys: number[],
  overrides: Partial<Omit<NavScrollInput, "y">> = {},
  from: NavScrollState = INITIAL_NAV_SCROLL,
): NavScrollState {
  return ys.reduce(
    (state, y) => stepNavScroll(state, { y, maxY: MAX, barHeight: BAR, pinned: false, ...overrides }),
    from,
  );
}

describe("at the top of the page", () => {
  test("the bar starts visible and transparent", () => {
    expect(INITIAL_NAV_SCROLL.hidden).toBe(false);
    expect(INITIAL_NAV_SCROLL.glass).toBe(false);
  });

  test("a few pixels of scroll do not turn the glass on yet", () => {
    expect(scrollThrough([GLASS_AFTER_PX]).glass).toBe(false);
  });

  test("past the threshold the bar becomes glass, and returning to the top clears it", () => {
    const scrolled = scrollThrough([GLASS_AFTER_PX + 1]);
    expect(scrolled.glass).toBe(true);
    expect(scrollThrough([0], {}, scrolled).glass).toBe(false);
  });

  test("it never hides while the page has not scrolled past the bar itself", () => {
    // Long downward travel, but all of it inside the bar's own height.
    const state = scrollThrough([10, 20, 30, 40, 50, BAR]);
    expect(state.hidden).toBe(false);
  });
});

describe("scrolling down", () => {
  test("hides the bar once the reader has travelled far enough", () => {
    const state = scrollThrough([100, 100 + HIDE_AFTER_PX + 1]);
    expect(state.hidden).toBe(true);
  });

  test("does not hide on a short nudge", () => {
    // A trackpad settling, a scroll-snap correction: movement, not intent.
    // Down to 1 000 (hidden), back up to 600 (shown), then the nudge.
    const shown = scrollThrough([1_000, 600]);
    expect(shown.hidden).toBe(false);
    const state = scrollThrough([600 + HIDE_AFTER_PX - 1], {}, shown);
    expect(state.hidden).toBe(false);
  });

  test("counts travel from where the downward run began, not from the top", () => {
    // Up to 400, then a nudge down: the run is only the nudge.
    const up = scrollThrough([800, 400]);
    const nudged = scrollThrough([400 + HIDE_AFTER_PX - 1], {}, up);
    expect(nudged.hidden).toBe(false);
  });

  test("a single large jump (End key, anchor link) hides it", () => {
    expect(scrollThrough([3_000]).hidden).toBe(true);
  });
});

describe("scrolling up", () => {
  const hiddenAt = (y: number) => scrollThrough([100, y]);

  test("reveals the bar after a short upward run", () => {
    const state = scrollThrough([1_000 - REVEAL_AFTER_PX], {}, hiddenAt(1_000));
    expect(state.hidden).toBe(false);
  });

  test("ignores an upward twitch smaller than the reveal distance", () => {
    const state = scrollThrough([1_000 - REVEAL_AFTER_PX + 1], {}, hiddenAt(1_000));
    expect(state.hidden).toBe(true);
  });

  test("a direction change restarts the run", () => {
    // Up a little, down a little, up a little: three runs, none long enough.
    const step = REVEAL_AFTER_PX - 2;
    const state = scrollThrough([1_000 - step, 1_000 - step + 2, 1_000 - 2 * step + 2], {}, hiddenAt(1_000));
    expect(state.hidden).toBe(true);
  });

  test("reaching the top always shows it", () => {
    expect(scrollThrough([0], {}, hiddenAt(1_000)).hidden).toBe(false);
  });

  test("coming back within the bar's own height shows it even without a long run", () => {
    // Hidden just below the bar's own height; the last step up is far shorter
    // than the reveal distance, but the reader is back where the bar sits.
    const justBelow: NavScrollState = {
      y: BAR + 4,
      runStart: 0,
      direction: "down",
      hidden: true,
      glass: true,
    };
    expect(REVEAL_AFTER_PX).toBeGreaterThan(4);
    expect(scrollThrough([BAR], {}, justBelow).hidden).toBe(false);
  });
});

describe("pinned", () => {
  // An open dropdown or drawer, or keyboard focus inside the header: hiding
  // it would take away the thing the reader is using.
  test("stays visible through any amount of downward scroll", () => {
    const state = scrollThrough([100, 1_000, 3_000], { pinned: true });
    expect(state.hidden).toBe(false);
  });

  test("a pinned bar that was already hidden comes back", () => {
    const hidden = scrollThrough([100, 1_000]);
    expect(hidden.hidden).toBe(true);
    expect(stepNavScroll(hidden, { y: 1_000, maxY: MAX, barHeight: BAR, pinned: true }).hidden).toBe(false);
  });

  test("once released, the next real downward run hides it again", () => {
    const pinned = scrollThrough([100, 1_000], { pinned: true });
    const released = scrollThrough([1_000 + HIDE_AFTER_PX + 1], {}, pinned);
    expect(released.hidden).toBe(true);
  });
});

describe("overscroll", () => {
  test("rubber-banding above the top reads as the top", () => {
    const state = scrollThrough([-40]);
    expect(state.y).toBe(0);
    expect(state.hidden).toBe(false);
    expect(state.glass).toBe(false);
  });

  test("bouncing back from past the end does not count as scrolling up", () => {
    // macOS lets the page travel past maxY and spring back; the spring-back is
    // an upward delta of the overshoot and must not reveal the bar.
    const atEnd = scrollThrough([100, MAX]);
    expect(atEnd.hidden).toBe(true);
    const bounced = scrollThrough([MAX + 60, MAX], {}, atEnd);
    expect(bounced.hidden).toBe(true);
  });

  test("a page shorter than the window never hides the bar", () => {
    const state = scrollThrough([0, 30, 0], { maxY: 0 });
    expect(state.hidden).toBe(false);
  });
});

describe("the state it hands back", () => {
  test("is a new object every step and leaves the previous one untouched", () => {
    const before = scrollThrough([100]);
    const snapshot = { ...before };
    const after = stepNavScroll(before, { y: 900, maxY: MAX, barHeight: BAR, pinned: false });
    expect(after).not.toBe(before);
    expect(before).toEqual(snapshot);
  });

  test("glass is independent of hidden", () => {
    const hidden = scrollThrough([100, 1_000]);
    expect(hidden.hidden).toBe(true);
    expect(hidden.glass).toBe(true);
    const revealed = scrollThrough([1_000 - REVEAL_AFTER_PX], {}, hidden);
    expect(revealed.hidden).toBe(false);
    expect(revealed.glass).toBe(true);
  });
});
