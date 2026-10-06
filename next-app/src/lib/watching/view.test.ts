import { describe, expect, test } from "bun:test";
import { watchingPageHue, watchingPageState } from "./view";

// The 全部在追 page: which body it renders, and which colour it wears.

describe("watchingPageState", () => {
  test("rows: the cards", () => {
    expect(watchingPageState({ loggedOut: false, unavailable: false, items: [1, 2] })).toBe("list");
  });

  test("signed in with nothing in progress: the empty state", () => {
    expect(watchingPageState({ loggedOut: false, unavailable: false, items: [] })).toBe("empty");
  });

  test("the API refused the session: back to log in", () => {
    expect(watchingPageState({ loggedOut: true, unavailable: false, items: [] })).toBe("signed-out");
  });

  test("the API failed: said as a failure, never as an empty list", () => {
    expect(watchingPageState({ loggedOut: true, unavailable: true, items: [] })).toBe("unavailable");
  });
});

describe("watchingPageHue", () => {
  test("the first show that has a colour", () => {
    expect(watchingPageHue([{ hue: null }, { hue: 210 }, { hue: 30 }])).toBe(210);
  });

  test("hue 0 is red, not 'no colour'", () => {
    expect(watchingPageHue([{ hue: 0 }, { hue: 30 }])).toBe(0);
  });

  test("no coloured show, or no show: neutral", () => {
    expect(watchingPageHue([{ hue: null }])).toBeNull();
    expect(watchingPageHue([])).toBeNull();
  });
});
