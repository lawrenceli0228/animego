import { describe, expect, test } from "bun:test";
import { trapFocusIndex } from "./focusTrap";

// The phone drawer is a modal: Tab and Shift+Tab cycle inside it and never
// reach the page underneath. The browser moves focus between the drawer's own
// controls by itself; the trap only has to step in at the two edges, and when
// focus is somewhere it should not be at all.

describe("trapFocusIndex", () => {
  test("Tab on the last control wraps to the first", () => {
    expect(trapFocusIndex(5, 4, false)).toBe(0);
  });

  test("Shift+Tab on the first control wraps to the last", () => {
    expect(trapFocusIndex(5, 0, true)).toBe(4);
  });

  test("in the middle the browser is left to do it", () => {
    expect(trapFocusIndex(5, 2, false)).toBeNull();
    expect(trapFocusIndex(5, 2, true)).toBeNull();
    // The edges only trap in their own direction.
    expect(trapFocusIndex(5, 0, false)).toBeNull();
    expect(trapFocusIndex(5, 4, true)).toBeNull();
  });

  test("focus outside the list (the panel itself, the page) is pulled back in at the right end", () => {
    expect(trapFocusIndex(5, -1, false)).toBe(0);
    expect(trapFocusIndex(5, -1, true)).toBe(4);
  });

  test("a single control traps onto itself in both directions", () => {
    expect(trapFocusIndex(1, 0, false)).toBe(0);
    expect(trapFocusIndex(1, 0, true)).toBe(0);
  });

  test("nothing focusable means nothing to move to", () => {
    expect(trapFocusIndex(0, -1, false)).toBeNull();
    expect(trapFocusIndex(0, -1, true)).toBeNull();
  });
});
