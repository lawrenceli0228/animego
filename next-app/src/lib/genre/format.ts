// The genre page's numbers: "5,241", and the lines they sit in.
//
// Grouped by hand rather than with toLocaleString: Node and the browser ship
// different ICU data, and a count that rendered "5,241" on the server and
// "5241" in the browser would be a hydration mismatch in the page's first line.
//
// Pure: no React, no DOM.

import { fillTemplate } from "@/lib/home/time";

/** "5,241". Anything that is not a non-negative finite number reads as 0. */
export function formatCount(n: number | null | undefined): string {
  const v = typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A count template ("{{n}} 部") with the grouped number in it. */
export function countText(template: string, n: number | null | undefined): string {
  return fillTemplate(template, { n: formatCount(n) });
}

/**
 * The hero's line: "5,241 部 · 84 部连载中". A genre with nothing airing
 * says only the first half; one the API knows nothing about says nothing.
 */
export function heroCountText(
  copy: { countLine: string; count: string },
  total: number | null | undefined,
  airing: number | null | undefined,
): string {
  if (!total) return "";
  if (!airing) return countText(copy.count, total);
  return fillTemplate(copy.countLine, { n: formatCount(total), m: formatCount(airing) });
}
