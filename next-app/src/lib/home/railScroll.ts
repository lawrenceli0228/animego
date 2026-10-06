// 今日更新's sideways rail, as arithmetic: dragging it with the mouse, paging
// it with the ← → buttons, and where it opens.
//
// The rail is an overflow-x row. Touch scrolls it natively; a mouse wheel
// does not (a vertical wheel scrolls the page), so on a desktop the row is
// dragged by hand and paged by two buttons. Everything that decides a number
// or a yes/no lives here, so it can be tested without a DOM; the component
// only reads geometry off the elements and writes scrollLeft.
//
// Pure: no React, no DOM.

/**
 * How far the pointer must travel before a press on the rail is a drag. Below
 * it, the press is a click on whatever card it went down on.
 */
export const DRAG_THRESHOLD_PX = 6;

/** Only the primary button of a mouse drags. Touch and pen scroll natively. */
export function startsDrag(pointerType: string, button: number): boolean {
  return pointerType === "mouse" && button === 0;
}

/**
 * Whether a move arrives with the primary button already up — a press whose
 * release the rail never saw. Before the drag threshold the pointer is not
 * captured, so a press that wandered off the rail (to cancel a click, onto an
 * arrow, into a context menu) is released elsewhere; the next hover must not
 * be mistaken for a drag. `buttons` is PointerEvent.buttons, a bitmask.
 */
export function releasedElsewhere(buttons: number): boolean {
  return (buttons & 1) === 0;
}

/** One press of the mouse on the rail. */
export interface RailPress {
  readonly pointerId: number;
  readonly startX: number;
  /** The rail's scrollLeft when the button went down. */
  readonly startScroll: number;
  /** The farthest the pointer has been from startX, in either direction. */
  readonly travel: number;
  /** Past the threshold: the press is a drag and moves the rail. */
  readonly dragging: boolean;
}

export function beginPress(pointerId: number, x: number, scrollLeft: number): RailPress {
  return { pointerId, startX: x, startScroll: scrollLeft, travel: 0, dragging: false };
}

export interface PressMove {
  readonly press: RailPress;
  /** This move is the one that turned the press into a drag. */
  readonly started: boolean;
  /** Where the rail should be scrolled to; null while it is not a drag. */
  readonly scrollLeft: number | null;
}

/**
 * The pointer moved to `x`. The rail follows the pointer — dragging left
 * scrolls toward the end — once the press has travelled past the threshold.
 */
export function movePress(press: RailPress, x: number): PressMove {
  const dx = x - press.startX;
  const travel = Math.max(press.travel, Math.abs(dx));
  const dragging = press.dragging || travel > DRAG_THRESHOLD_PX;
  return {
    press: { ...press, travel, dragging },
    started: dragging && !press.dragging,
    scrollLeft: dragging ? press.startScroll - dx : null,
  };
}

/**
 * Whether the click that follows the release must not open the card under
 * the pointer. Any press that became a drag counts — even one that came back
 * to where it started: the reader was moving the row, not choosing a card.
 */
export function suppressesClick(press: RailPress): boolean {
  return press.dragging;
}

/** The rail's scroll geometry, read off the element. */
export interface RailGeometry {
  /** scrollLeft */
  readonly viewLeft: number;
  /** clientWidth */
  readonly viewWidth: number;
  /** scrollWidth */
  readonly contentWidth: number;
}

/** The furthest the rail can scroll. */
export function maxScrollLeft(g: RailGeometry): number {
  return Math.max(0, g.contentWidth - g.viewWidth);
}

export interface RailEdges {
  /** There is anything to scroll at all. */
  readonly overflow: boolean;
  readonly atStart: boolean;
  readonly atEnd: boolean;
}

/**
 * Where the rail is relative to its two ends. `slack` absorbs the fractional
 * scroll positions a zoomed or high-density screen reports.
 */
export function railEdges(g: RailGeometry, slack = 1): RailEdges {
  const max = maxScrollLeft(g);
  return {
    overflow: max > slack,
    atStart: g.viewLeft <= slack,
    atEnd: g.viewLeft >= max - slack,
  };
}

function clamp(value: number, max: number): number {
  return Math.min(max, Math.max(0, value));
}

/**
 * Where the ← / → buttons take the rail: about one view's worth of cards in
 * that direction, landing with a card's left edge on the content edge `pad`
 * (the page gutter) rather than mid-card.
 *
 * Forward, the card the view's right edge cuts through becomes the first one
 * shown, so nothing is skipped. Backward mirrors it. `starts` are the items'
 * offsetLeft inside the rail, in order.
 */
export function pageScrollLeft(
  g: RailGeometry,
  starts: readonly number[],
  pad: number,
  direction: 1 | -1,
): number {
  const span = Math.max(1, g.viewWidth - 2 * pad);
  // A plain page, before lining it up with a card.
  const raw = g.viewLeft + direction * span;
  // Each item sits flush with the content edge at its own `start - pad`. Of
  // those that move the rail and stay within a page of where it is, take the
  // farthest: forward, the card cut by the right edge; backward, the one
  // that keeps a full page in view. None (a card wider than the view): the
  // plain page.
  const candidates = starts
    .map((s) => s - pad)
    .filter((a) => (direction > 0 ? a <= raw && a > g.viewLeft + 1 : a >= raw && a < g.viewLeft - 1));
  const target =
    candidates.length === 0 ? raw : direction > 0 ? Math.max(...candidates) : Math.min(...candidates);
  return clamp(target, maxScrollLeft(g));
}

/** The 现在 marker and its neighbours, as offsets inside the rail. */
export interface NowLayout {
  /** The marker's offsetLeft. */
  readonly markerStart: number;
  /** The last aired card's offsetLeft, or null when nothing has aired yet. */
  readonly prevStart: number | null;
  /** The right edge of the first card still to come, or of the marker when none is left. */
  readonly nextEnd: number;
}

/**
 * Where the rail opens: scrolled so the 现在 marker and the next show to air
 * are in view — with the last aired card before them when the view is wide
 * enough for all three. Null when they are in view without scrolling.
 *
 * A reader at 23:00 should not have to scroll past fifteen finished episodes
 * to find the next one.
 */
export function nowScrollLeft(g: RailGeometry, now: NowLayout, pad: number): number | null {
  const visibleEnd = (left: number) => left + g.viewWidth - pad;
  if (now.nextEnd <= visibleEnd(0)) return null;
  const withPrev = now.prevStart === null ? null : now.prevStart - pad;
  const target = withPrev !== null && now.nextEnd <= visibleEnd(withPrev) ? withPrev : now.markerStart - pad;
  return clamp(target, maxScrollLeft(g));
}
