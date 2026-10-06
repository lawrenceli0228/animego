// Bringing the selected pill into view by scrolling its ROW, as arithmetic.
//
// `scrollIntoView` would do the horizontal part and also scroll the page
// vertically to the pill, which on a phone yanks the list the reader was
// looking at. Scrolling the row's own `scrollLeft` moves nothing else. Split
// out because this repo has no DOM test library; numbers can be tested.
//
// Pure: no React, no DOM.

export interface RowGeometry {
  /** The row's current scrollLeft. */
  viewLeft: number;
  /** The row's clientWidth. */
  viewWidth: number;
  /** The row's scrollWidth. */
  contentWidth: number;
  /** The pill's offsetLeft inside the row. */
  itemStart: number;
  /** The pill's offsetWidth. */
  itemWidth: number;
}

/**
 * The scrollLeft that shows the whole pill with `pad` px to spare, or null
 * when it is already fully visible or the row does not scroll at all.
 */
export function revealScrollLeft(g: RowGeometry, pad: number): number | null {
  const maxLeft = g.contentWidth - g.viewWidth;
  if (maxLeft <= 0) return null;
  const clamp = (v: number) => Math.min(maxLeft, Math.max(0, v));
  if (g.itemStart - pad < g.viewLeft) return clamp(g.itemStart - pad);
  const itemEnd = g.itemStart + g.itemWidth + pad;
  if (itemEnd > g.viewLeft + g.viewWidth) return clamp(itemEnd - g.viewWidth);
  return null;
}
