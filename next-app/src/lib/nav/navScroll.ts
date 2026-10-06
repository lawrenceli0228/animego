// Whether the site header is out of the way, and whether it wears its glass.
//
// AniList's behaviour: the bar slides up while the reader scrolls down and
// comes straight back the moment they scroll up. It is transparent at the very
// top of the page (where the homepage hero shows through it) and turns into a
// blurred glass surface as soon as there is content underneath.
//
// Pure on purpose — no window, no React — because every way this goes wrong
// is a sequence of numbers, and a sequence of numbers is easy to test and hard
// to reason about in a scroll handler:
//
//   - a trackpad settles a few pixels after a fling, in either direction;
//   - macOS rubber-bands past both ends of the page and springs back, which
//     reads as a scroll in the opposite direction;
//   - the End key, an anchor link or a restored scroll position jumps
//     thousands of pixels in one event;
//   - the reader has a dropdown open, or keyboard focus inside the bar, and
//     hiding it would take away the thing they are using.
//
// Travel is measured from where the current same-direction run began, not
// between consecutive events — scroll events arrive at the browser's whim, and
// a slow, steady scroll can produce many events of a pixel or two each.

/** Scrolled further than this from the top and the bar becomes glass. */
export const GLASS_AFTER_PX = 8;

/** Continuous downward travel needed before the bar hides. */
export const HIDE_AFTER_PX = 12;

/** Continuous upward travel needed before a hidden bar comes back. */
export const REVEAL_AFTER_PX = 8;

export type ScrollDirection = "up" | "down";

export interface NavScrollState {
  /** The last scroll position seen, clamped to the scrollable range. */
  readonly y: number;
  /** Where the current run of same-direction scrolling began. */
  readonly runStart: number;
  /** Direction of the current run; null before the first movement. */
  readonly direction: ScrollDirection | null;
  readonly hidden: boolean;
  readonly glass: boolean;
}

export interface NavScrollInput {
  /** `window.scrollY` as reported, overscroll included. */
  readonly y: number;
  /** The largest real scroll position: scrollHeight − innerHeight. */
  readonly maxY: number;
  /** The bar's own height. It never hides while the page is within it. */
  readonly barHeight: number;
  /** An open menu, an open drawer, or keyboard focus inside the bar. */
  readonly pinned: boolean;
}

export const INITIAL_NAV_SCROLL: NavScrollState = {
  y: 0,
  runStart: 0,
  direction: null,
  hidden: false,
  glass: false,
};

/**
 * One scroll event's worth of decision.
 *
 * Returns a new state; `prev` is never modified.
 */
export function stepNavScroll(prev: NavScrollState, input: NavScrollInput): NavScrollState {
  // Overscroll is not scrolling. Clamping both ends means a rubber-band above
  // the top reads as the top, and the spring-back from past the end is a
  // delta of zero rather than an upward run.
  const y = Math.min(Math.max(input.y, 0), Math.max(input.maxY, 0));

  const delta = y - prev.y;
  const direction: ScrollDirection | null =
    delta > 0 ? "down" : delta < 0 ? "up" : prev.direction;
  // A turn starts a new run at the position where the turn happened.
  const runStart = direction === prev.direction ? prev.runStart : prev.y;
  const travel = Math.abs(y - runStart);

  return {
    y,
    runStart,
    direction,
    hidden: nextHidden(prev.hidden, { y, direction, travel, input }),
    glass: y > GLASS_AFTER_PX,
  };
}

interface HiddenInputs {
  readonly y: number;
  readonly direction: ScrollDirection | null;
  readonly travel: number;
  readonly input: NavScrollInput;
}

function nextHidden(wasHidden: boolean, { y, direction, travel, input }: HiddenInputs): boolean {
  if (input.pinned) return false;
  // Inside its own height the bar is still sitting in the page; hiding it
  // there would uncover nothing but the space it occupies.
  if (y <= input.barHeight) return false;
  if (direction === "down" && travel >= HIDE_AFTER_PX) return true;
  if (direction === "up" && travel >= REVEAL_AFTER_PX) return false;
  return wasHidden;
}
