// 今日更新's sideways rail, as arithmetic: dragging it with the mouse (and the
// fling a quick drag ends in), the slider under it, where it comes to rest,
// and where it opens.
//
// The rail is an overflow-x row. Touch scrolls it natively; a mouse wheel
// does not (a vertical wheel scrolls the page), so on a desktop the row is
// dragged by hand. The slider under it — a thin track and a thumb as wide as
// the share of the row in view — moves it from anywhere: dragged, clicked, or
// from the keyboard. Everything that decides a number or a yes/no lives here,
// so it can be tested without a DOM; the hooks only read geometry off the
// elements and write scrollLeft.
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
 * So does a press that stopped a fling: like native momentum scrolling, that
 * tap means "stop", not "open the card going past". (A short settle onto a
 * card is not a fling: a click then lands where the reader aimed.)
 */
export function suppressesClick(press: RailPress, stoppedMotion = false): boolean {
  return press.dragging || stoppedMotion;
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
 * A page of the rail, for the slider's Page Up / Page Down: about one view's
 * worth of cards in that direction, landing with a card's left edge on the
 * content edge `pad` (the page gutter) rather than mid-card.
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

// ── The slider ────────────────────────────────────────────────────────────

/** The thumb is never narrower than this share of the track, so it stays grabbable. */
export const THUMB_MIN_PCT = 6;

/** The slider's thumb, as shares of the track (0–100). */
export interface Thumb {
  readonly widthPct: number;
  readonly leftPct: number;
}

/**
 * The thumb for where the rail is: as wide as the share of the row in view,
 * as far along the room the track has as the rail is along its scroll. A row
 * that fits fills the track.
 */
export function thumbFor(g: RailGeometry, minPct = THUMB_MIN_PCT): Thumb {
  const max = maxScrollLeft(g);
  if (max <= 0 || g.contentWidth <= 0) return { widthPct: 100, leftPct: 0 };
  const widthPct = Math.min(100, Math.max(minPct, (g.viewWidth / g.contentWidth) * 100));
  return { widthPct, leftPct: (clamp(g.viewLeft, max) / max) * (100 - widthPct) };
}

/**
 * Where a press on the slider took hold of the thumb, in px from its left
 * edge: on the thumb, the spot under the pointer (so it does not jump); on the
 * bare track, the thumb's middle (it comes to the pointer).
 */
export function grabOffset(thumb: Thumb, trackWidth: number, x: number): { onThumb: boolean; grab: number } {
  const width = (thumb.widthPct / 100) * trackWidth;
  const left = (thumb.leftPct / 100) * trackWidth;
  const onThumb = x >= left && x <= left + width;
  return { onThumb, grab: onThumb ? x - left : width / 2 };
}

/**
 * The scrollLeft that puts the thumb's grab point under the pointer, `x` px
 * from the track's left edge. Past either end of the track, the rail's end.
 */
export function scrollForPointer(g: RailGeometry, thumb: Thumb, trackWidth: number, x: number, grab: number): number {
  const room = trackWidth * (1 - thumb.widthPct / 100);
  if (room <= 0) return 0;
  const max = maxScrollLeft(g);
  return clamp(((x - grab) / room) * max, max);
}

// ── Coming to rest ────────────────────────────────────────────────────────

/**
 * The positions the rail comes to rest at, ascending: every item (cards and
 * the 现在 marker, by offsetLeft) flush with the gutter `pad`, and both ends.
 */
export function railStops(g: RailGeometry, starts: readonly number[], pad: number): number[] {
  const max = maxScrollLeft(g);
  const stops = new Set<number>([0, max]);
  for (const start of starts) stops.add(clamp(start - pad, max));
  return [...stops].sort((a, b) => a - b);
}

/** The stop nearest `target`: where a drag, a fling or a click on the track settles. */
export function nearestStop(target: number, stops: readonly number[]): number {
  let best = stops[0] ?? 0;
  for (const stop of stops) if (Math.abs(stop - target) < Math.abs(best - target)) best = stop;
  return best;
}

/**
 * The index of the stop nearest `target` — the slider's range input counts
 * stops, not pixels, so a screen reader's increment moves a card.
 */
export function nearestStopIndex(target: number, stops: readonly number[]): number {
  let best = 0;
  stops.forEach((stop, i) => {
    if (Math.abs(stop - target) < Math.abs(stops[best] - target)) best = i;
  });
  return best;
}

/** The next stop past where the rail is, in `direction` — the slider's arrow keys. An end stays put. */
export function stepStop(g: RailGeometry, stops: readonly number[], direction: 1 | -1): number {
  if (direction > 0) return stops.find((s) => s > g.viewLeft + 1) ?? maxScrollLeft(g);
  for (let i = stops.length - 1; i >= 0; i--) {
    if (stops[i] < g.viewLeft - 1) return stops[i];
  }
  return 0;
}

// ── A fling ───────────────────────────────────────────────────────────────

/** A pointer position at a moment: PointerEvent clientX and timeStamp. */
export interface PointerSample {
  readonly t: number;
  readonly x: number;
}

/** Let go after the pointer has rested this long, and there is no fling. */
export const FLING_REST_MS = 80;
/** The release speed is read over the moves of this last stretch. */
export const FLING_WINDOW_MS = 120;
/** Fraction of its speed a fling keeps per 16 ms frame. */
export const GLIDE_FRICTION = 0.95;
/** Below this speed (px/ms) a fling is over and the rail settles on a stop. */
export const GLIDE_MIN_SPEED = 0.08;

/**
 * The pointer's speed when a drag was let go, px/ms, positive to the right —
 * read over the last FLING_WINDOW_MS of moves. Zero if it had come to rest.
 * The rail flings the other way: dragging left scrolls toward the end.
 */
export function releaseVelocity(samples: readonly PointerSample[], releasedAt: number): number {
  const last = samples[samples.length - 1];
  if (!last || samples.length < 2 || releasedAt - last.t > FLING_REST_MS) return 0;
  const first = samples.find((s) => s.t < last.t && last.t - s.t <= FLING_WINDOW_MS);
  return first ? (last.x - first.x) / (last.t - first.t) : 0;
}

/**
 * Whether a wheel over a flinging rail takes the row over: a sideways scroll
 * (a trackpad) does; a vertical wheel scrolls the page and leaves the fling
 * to finish and settle on a card.
 */
export function takesOverFling(deltaX: number, deltaY: number): boolean {
  return Math.abs(deltaX) > Math.abs(deltaY);
}

/** One frame of a fling: how far the rail moves in `dt` ms, and the speed left after it. */
export function glideStep(velocity: number, dt: number): { dx: number; velocity: number } {
  return { dx: velocity * dt, velocity: velocity * Math.pow(GLIDE_FRICTION, dt / 16) };
}

// ── What is in view ───────────────────────────────────────────────────────

/** An item's place in the rail: offsetLeft and offsetWidth. */
export interface ItemBox {
  readonly start: number;
  readonly width: number;
}

/**
 * Which items (1-based, in order) the reader is looking at: those whose middle
 * is between the gutters. For the slider's spoken value. Null for none.
 */
export function itemsInView(
  g: RailGeometry,
  items: readonly ItemBox[],
  pad: number,
): { first: number; last: number } | null {
  const from = g.viewLeft + pad;
  const to = g.viewLeft + g.viewWidth - pad;
  let first = 0;
  let last = 0;
  items.forEach((item, i) => {
    const middle = item.start + item.width / 2;
    if (middle < from || middle > to) return;
    if (first === 0) first = i + 1;
    last = i + 1;
  });
  return first === 0 ? null : { first, last };
}

/** The last place in the entrance order; everything off screen waits there. */
export const ENTER_ORDER_CAP = 10;

/**
 * The order cards rise in when the rail first comes into view: those on
 * screen left to right from 0, the rest (and any past the cap) at the cap.
 */
export function enterOrder(g: RailGeometry, items: readonly ItemBox[]): number[] {
  let rank = 0;
  return items.map((item) => {
    const middle = item.start + item.width / 2;
    const onScreen = middle >= g.viewLeft && middle <= g.viewLeft + g.viewWidth;
    if (!onScreen) return ENTER_ORDER_CAP;
    const order = Math.min(ENTER_ORDER_CAP, rank);
    rank += 1;
    return order;
  });
}
