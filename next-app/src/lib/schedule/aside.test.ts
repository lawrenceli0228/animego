import { describe, expect, test } from "bun:test";
import { asideBox } from "./aside";

// Which box the schedule page's aside shows between the week chart and the
// next-season link. The case that matters is the third: a signed-in reader
// whose schedule failed to load must not be told nothing they follow airs.

describe("asideBox", () => {
  test("signed in, schedule loaded: 我追的 · 本周", () => {
    expect(asideBox({ 21: 3 }, true)).toBe("mine");
  });

  test("signed in and following nothing still gets the box — its empty line is true", () => {
    expect(asideBox({}, true)).toBe("mine");
  });

  test("signed in, schedule failed: no box, rather than a false 'nothing airs this week'", () => {
    expect(asideBox({ 21: 3 }, false)).toBeNull();
  });

  test("a visitor gets the sign-in prompt whether or not the schedule loaded", () => {
    expect(asideBox(null, true)).toBe("signIn");
    expect(asideBox(null, false)).toBe("signIn");
  });
});
