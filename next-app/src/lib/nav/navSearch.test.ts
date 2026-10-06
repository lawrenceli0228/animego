import { describe, expect, test } from "bun:test";
import { isImeKeystroke, navSearchPath } from "./navSearch";

// The header's search box: Enter goes to /search?q=…, but not the Enter that
// a Chinese or Japanese reader presses to confirm a candidate in their IME.
// Submitting on that one searches for half-typed pinyin or kana.

describe("navSearchPath", () => {
  test("a keyword becomes the search page's own query parameter", () => {
    expect(navSearchPath("frieren")).toBe("/search?q=frieren");
  });

  test("CJK is encoded and surrounding whitespace dropped", () => {
    expect(navSearchPath("  葬送的芙莉莲 ")).toBe(`/search?q=${encodeURIComponent("葬送的芙莉莲")}`);
  });

  test("characters that mean something in a URL stay inside the value", () => {
    expect(navSearchPath("spy family")).toBe("/search?q=spy+family");
    expect(navSearchPath("Re:Zero & friends?#1")).toBe("/search?q=Re%3AZero+%26+friends%3F%231");
  });

  test("an empty or blank box opens the bare search page, not ?q=", () => {
    expect(navSearchPath("")).toBe("/search");
    expect(navSearchPath("   ")).toBe("/search");
  });
});

describe("isImeKeystroke", () => {
  test("a plain Enter is not", () => {
    expect(isImeKeystroke({ isComposing: false, keyCode: 13 })).toBe(false);
  });

  test("Chrome and Firefox: the confirming Enter arrives with isComposing set", () => {
    expect(isImeKeystroke({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeKeystroke({ isComposing: true, keyCode: 229 })).toBe(true);
  });

  test("Safari: compositionend has already fired, but the key code is still 229", () => {
    // The ordering bug: Safari ends the composition BEFORE the keydown, so
    // isComposing alone reads false on exactly the keystroke that matters.
    expect(isImeKeystroke({ isComposing: false, keyCode: 229 })).toBe(true);
  });
});
