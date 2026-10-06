import { describe, expect, test } from "bun:test";
import { revealScrollLeft } from "./reveal";

// On a phone the day tabs are a sideways-scrolling row. When the selected
// pill is cut off at either edge the ROW scrolls to show it — the page must
// not move, which is what scrollIntoView would also do.

const row = { viewWidth: 350, contentWidth: 700 };

describe("revealScrollLeft", () => {
  test("a pill already fully in view needs no scroll", () => {
    expect(revealScrollLeft({ ...row, viewLeft: 0, itemStart: 100, itemWidth: 80 }, 16)).toBeNull();
  });

  test("a pill cut off on the right scrolls just far enough, plus the padding", () => {
    // Right edge at 400 + 16 padding = 416; the view is 350 wide.
    expect(revealScrollLeft({ ...row, viewLeft: 0, itemStart: 320, itemWidth: 80 }, 16)).toBe(66);
  });

  test("a pill cut off on the left scrolls back to it, minus the padding", () => {
    expect(revealScrollLeft({ ...row, viewLeft: 200, itemStart: 150, itemWidth: 80 }, 16)).toBe(134);
  });

  test("never scrolls past either end of the row", () => {
    expect(revealScrollLeft({ ...row, viewLeft: 100, itemStart: 4, itemWidth: 80 }, 16)).toBe(0);
    expect(revealScrollLeft({ ...row, viewLeft: 0, itemStart: 640, itemWidth: 60 }, 16)).toBe(350);
  });

  test("a row that does not overflow never scrolls", () => {
    expect(
      revealScrollLeft({ viewWidth: 900, contentWidth: 900, viewLeft: 0, itemStart: 860, itemWidth: 80 }, 16),
    ).toBeNull();
  });
});
