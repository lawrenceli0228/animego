// How much of the list is on show, and how the next batch arrives.
//
// Every item of the filtered list is in the HTML (search engines read the
// links); this only decides which of them are visible. A batch is a full
// screen or two of the view in use — six rows of six covers on a desktop,
// seven rows of three on a phone — and "show more" (or scrolling near the
// end) reveals the next one.
//
// Pure: no React, no DOM.

import type { ViewKey } from "./state";

/** Desktop and tablet share one layout family; phones (≤600px) get their own. */
export type Layout = "desktop" | "phone";

const BATCH: Record<Layout, Record<ViewKey, number>> = {
  desktop: { grid: 36, chart: 12, table: 16 },
  // A phone has no table view (its columns do not fit), so its table batch is
  // never used; it is the grid's for completeness.
  phone: { grid: 21, chart: 7, table: 21 },
};

/** Per-card entrance delay within a batch, ms — AniList's stagger, slower on bigger cards. */
const STAGGER_MS: Record<Layout, Record<ViewKey, number>> = {
  desktop: { grid: 16, chart: 34, table: 24 },
  phone: { grid: 22, chart: 40, table: 22 },
};

/** The view a layout can draw: a phone shows the cover grid where a table was asked for. */
export function effectiveView(view: ViewKey, layout: Layout): ViewKey {
  return layout === "phone" && view === "table" ? "grid" : view;
}

export function batchSize(view: ViewKey, layout: Layout): number {
  return BATCH[layout][effectiveView(view, layout)];
}

/** How many of `total` items are visible after `pages` batches. */
export function visibleCount(total: number, pages: number, batch: number): number {
  return Math.min(Math.max(0, total), Math.max(1, Math.floor(pages)) * batch);
}

/** How many are still hidden. */
export function hiddenCount(total: number, pages: number, batch: number): number {
  return Math.max(0, total - visibleCount(total, pages, batch));
}

/**
 * The entrance delay of the item at `index`: each batch starts its own
 * stagger from zero, so a revealed batch ripples in like the first one did
 * rather than waiting behind the cards already on screen.
 */
export function staggerMs(index: number, view: ViewKey, layout: Layout): number {
  const shown = effectiveView(view, layout);
  return (index % BATCH[layout][shown]) * STAGGER_MS[layout][shown];
}
