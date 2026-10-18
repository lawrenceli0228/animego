// The order quick-subscribe presses were made in, so their confirmations can
// keep it. Pure, for the same reason as quickSubscribeState: importing the
// hook pulls react-hot-toast, which bun:test cannot evaluate.
//
// The site shows one toast at a time and a newer one replaces the last, but
// writes do not come back in the order they went out: a follow whose POST is
// slow would land its "已加入「在看」" after the follow pressed after it, and
// replace it. A confirmation older than one already on screen is not shown
// (the card's ✓ says it all). A failure always is, so it never asks.

export interface PressOrder {
  /** Claim a place in the order, at the moment of the press. */
  takeTurn(): number;
  /** Whether the confirmation for `turn` may still take the screen; if so, it does. */
  mayConfirm(turn: number): boolean;
}

export function createPressOrder(): PressOrder {
  let issued = 0;
  let shown = 0;
  return {
    takeTurn: () => ++issued,
    mayConfirm(turn) {
      if (turn < shown) return false;
      shown = turn;
      return true;
    },
  };
}
