import { describe, expect, test } from "bun:test";
import { SETTINGS_SECTIONS, isScrolledToEnd, pickSection } from "./sectionSpy";

describe("pickSection", () => {
  test("marks the first section in the band", () => {
    expect(pickSection(SETTINGS_SECTIONS, new Set(["devices"]), false)).toBe("devices");
    expect(pickSection(SETTINGS_SECTIONS, new Set(["privacy", "account"]), false)).toBe("account");
  });

  test("keeps the current mark between sections", () => {
    expect(pickSection(SETTINGS_SECTIONS, new Set(), false)).toBeNull();
  });

  test("ignores ids that are not sections", () => {
    expect(pickSection(SETTINGS_SECTIONS, new Set(["footer"]), false)).toBeNull();
  });

  test("marks the last section once the page is scrolled to its end", () => {
    expect(pickSection(SETTINGS_SECTIONS, new Set(["privacy"]), true)).toBe("playback");
    expect(pickSection([] as string[], new Set(), true)).toBeNull();
  });
});

describe("isScrolledToEnd", () => {
  test("is true at the bottom of a scrolling page, give or take a pixel", () => {
    expect(isScrolledToEnd(1600, 900, 2500)).toBe(true);
    expect(isScrolledToEnd(1599, 900, 2500)).toBe(true);
  });

  test("is false anywhere above it", () => {
    expect(isScrolledToEnd(1200, 900, 2500)).toBe(false);
    expect(isScrolledToEnd(0, 900, 2500)).toBe(false);
  });

  test("is false on a page that does not scroll", () => {
    expect(isScrolledToEnd(0, 900, 900)).toBe(false);
    expect(isScrolledToEnd(0, 900, 600)).toBe(false);
  });
});
