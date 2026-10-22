// When a request finishes and takes part of the page with it (a signed-out
// device's tile, an unblocked row, the pass's save bar), whether focus has
// to be moved somewhere first. Pure, so it can be tested without a DOM.

/** Anything that can say whether a node is inside it — an Element, in the page. */
export interface FocusContainer {
  contains(node: Node | null): boolean;
}

/**
 * True when focus is about to be lost: it is inside something that is going
 * away, or it has already fallen back to the body. Anywhere else — the reader
 * moved on and is typing in the username field, say — it is left alone.
 */
export function shouldMoveFocus(
  active: Node | null,
  body: Node | null,
  leaving: ReadonlyArray<FocusContainer | null | undefined>,
): boolean {
  if (!active || active === body) return true;
  return leaving.some((container) => container?.contains(active) ?? false);
}
