// The header a page drew for the view it was going to — the genre pressed in
// the strip, the grid 查看全部 opened, the hub on the way back — handed to the
// page that lands there.
//
// Every route change mounts the arriving page afresh (another genre is
// another route segment; another view of the same genre another render key,
// see GenreBrowse), and a fresh header plays its entrance: a fade from
// nothing. The reader has been looking at that very header while the page
// loaded, so it would blink out and back as the page arrived. The arriving
// page asks whether its header was the one on screen, and if so draws it as
// it stands.

import type { FilterGenre } from "@/lib/contentLabels";
import { gridHref, type GridView } from "@/lib/genre/views";
import { genrePath } from "@/lib/hubs/paths";

/** What a header shows, as a key: the address of the view it heads (page 1). */
export type HeaderTarget = { kind: "hub"; genre: FilterGenre } | { kind: "grid"; genre: FilterGenre; view: GridView };

let carried: string | null = null;

function keyOf(target: HeaderTarget): string {
  return target.kind === "hub" ? genrePath(target.genre) : gridHref(target.genre, target.view);
}

/** A link in the page was followed: this header is on screen until its page lands. */
export function carryHeader(target: HeaderTarget): void {
  carried = keyOf(target);
}

/** The page landed, or the reader went Back before it did: nothing is carried any more. */
export function dropCarriedHeader(): void {
  carried = null;
}

/** Whether the header of the page now mounting is the one already on screen. */
export function isHeaderCarried(target: HeaderTarget): boolean {
  return carried !== null && carried === keyOf(target);
}
