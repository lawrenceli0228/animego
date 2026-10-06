// The header's search box: where Enter goes, and which Enter does not count.

import { makeQuery, searchPath } from "@/components/search/searchQuery";

/**
 * The /search URL for whatever is in the box.
 *
 * Built by the search page's own `searchPath`, so the header and the page
 * agree on the parameter name and on dropping an empty one: a blank box opens
 * the bare /search rather than /search?q=.
 */
export function navSearchPath(raw: string): string {
  return searchPath(makeQuery(raw, "", 1));
}

export interface KeystrokeLike {
  readonly isComposing: boolean;
  readonly keyCode: number;
}

/**
 * True for a keystroke that belongs to an input method rather than to the
 * page — including the Enter that confirms a candidate.
 *
 * Two signals, because browsers disagree on the order of events. Chrome and
 * Firefox deliver the confirming keydown while the composition is still open
 * (`isComposing`). Safari fires `compositionend` first and the keydown after,
 * so `isComposing` is already false on exactly the keystroke that matters —
 * but the keydown still carries the IME's key code, 229.
 */
export function isImeKeystroke(event: KeystrokeLike): boolean {
  return event.isComposing || event.keyCode === 229;
}
