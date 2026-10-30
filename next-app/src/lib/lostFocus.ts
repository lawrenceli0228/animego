/**
 * True when nothing in particular has focus: it is on <body>, on nothing, or
 * on an element that has left the document. That is where a browser leaves
 * focus when the focused element is removed — a confirmation's 取消 that
 * closes the confirmation, a row that goes after its own sign-out — and from
 * there Tab starts over at the top of the page and a dialog's own keys no
 * longer reach it. Components call this after such a change to decide
 * whether focus needs putting somewhere.
 *
 * Browser-only: call it from an effect or a handler, never while rendering.
 */
export function focusIsLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}
