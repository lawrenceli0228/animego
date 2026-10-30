// The header a ranking page drew for the ranking it was going to — a year
// pressed in the strip, a format chip, a genre — handed to the page that lands
// there (the genre page's carriedHeader.ts, keyed by a ranking's address).
//
// Every ranking mounts afresh when it lands (another year is another route
// segment, another filter another render key, see TopBrowse), and a fresh
// header plays its entrance: a fade from nothing. The reader has been looking
// at that very header — the new heading, the strip's block under the new
// year, the chip lit — while the page loaded, so it would blink out and back
// as the page arrived. The arriving page asks whether its header was the one
// on screen, and if so draws it as it stands.

let carried: string | null = null;

/** A link in the page was followed: the header of `key` is on screen until its page lands. */
export function carryHeader(key: string): void {
  carried = key;
}

/** The page landed, or the reader went Back before it did: nothing is carried any more. */
export function dropCarriedHeader(): void {
  carried = null;
}

/** Whether the header of the page now mounting (`key`) is the one already on screen. */
export function isHeaderCarried(key: string): boolean {
  return carried !== null && carried === key;
}
