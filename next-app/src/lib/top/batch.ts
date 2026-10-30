// How much of a ranking is on show.
//
// The whole ranking (at most a hundred) is in the server's HTML, every show a
// real link; this only decides which of them are visible. A batch is one
// screen of the view: twenty on a desktop — four rows of five covers, ten rows
// of chart cards, twenty table rows — and on a phone seven rows of three
// covers or twenty list rows. "Show more", or the reader scrolling near it,
// reveals the next.
//
// Pure: no React, no DOM.

import type { Layout } from "@/lib/seasonal/batch";
import type { ViewKey } from "@/lib/seasonal/state";

const BATCH: Record<Layout, Record<ViewKey, number>> = {
  desktop: { grid: 20, chart: 20, table: 20 },
  // A phone has no chart view (effectiveTopView draws its grid instead).
  phone: { grid: 21, chart: 21, table: 20 },
};

/** Per-card entrance delay within a batch, ms: the seasonal page's stagger. */
const STAGGER_MS: Record<Layout, Record<ViewKey, number>> = {
  desktop: { grid: 16, chart: 34, table: 24 },
  phone: { grid: 16, chart: 16, table: 24 },
};

/**
 * The view a layout draws: a phone offers the cover grid and the list (the
 * table view, drawn as a phone's rows); a chart asked for on a phone is the grid.
 */
export function effectiveTopView(view: ViewKey, layout: Layout): ViewKey {
  return layout === "phone" && view === "chart" ? "grid" : view;
}

export function topBatchSize(view: ViewKey, layout: Layout): number {
  return BATCH[layout][effectiveTopView(view, layout)];
}

/** How many of `total` are visible after `pages` batches. */
export function shownCount(total: number, pages: number, batch: number): number {
  return Math.min(Math.max(0, total), Math.max(1, Math.floor(pages)) * batch);
}

/** The entrance delay of the show at `index`: each batch starts its stagger from zero. */
export function topStaggerMs(index: number, view: ViewKey, layout: Layout): number {
  const shown = effectiveTopView(view, layout);
  return (index % BATCH[layout][shown]) * STAGGER_MS[layout][shown];
}
