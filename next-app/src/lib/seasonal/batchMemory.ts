// How many batches were open, remembered in the history entry.
//
// Opening a show from deep in the list and coming Back used to land on the
// first batch again: the page remounts with one batch open, and the place the
// reader left is past the end of what is shown. The entry now remembers how
// many batches were open — for the address they were open on, so a value
// left by another page (or by this page under other filters) is never read
// as this one's.
//
// Pure: no React, no DOM. BrowseView does the reading and writing.

/** The history-state key the page keeps its batches under. */
export const BATCH_MEMORY_KEY = "seasonalBatches";

/** Never restore past this many batches: a season holds a few hundred shows at most. */
export const MAX_REMEMBERED_PAGES = 30;

export interface BatchMemory {
  /** The address the batches were open on (see memoryUrl). */
  url: string;
  pages: number;
}

/** An address as the memory compares it: the pathname and its query, the query in one spelling. */
export function memoryUrl(pathname: string, search: string): string {
  const query = new URLSearchParams(search).toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** The batches a history entry remembers for `url`; 1 when it remembers nothing for it. */
export function rememberedPages(historyState: unknown, url: string): number {
  if (!historyState || typeof historyState !== "object") return 1;
  const saved = (historyState as Record<string, unknown>)[BATCH_MEMORY_KEY];
  if (!saved || typeof saved !== "object") return 1;
  const { url: savedUrl, pages } = saved as Partial<BatchMemory>;
  if (savedUrl !== url || typeof pages !== "number" || !Number.isInteger(pages) || pages < 1) return 1;
  return Math.min(pages, MAX_REMEMBERED_PAGES);
}

/** The history-state entry that remembers `pages` batches open on `url`. */
export function batchMemory(url: string, pages: number): Record<string, BatchMemory> {
  return { [BATCH_MEMORY_KEY]: { url, pages } };
}
