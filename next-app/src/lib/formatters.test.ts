import { describe, expect, test } from "bun:test";
import { formatFuzzyDate, formatScore, pickTitle, stripHtml, truncate } from "./formatters";

describe("formatFuzzyDate", () => {
  test("returns YYYY-MM-DD when all three fields present", () => {
    expect(formatFuzzyDate({ year: 2021, month: 12, day: 5 })).toBe("2021-12-05");
  });

  test("pads single-digit month and day with leading zero", () => {
    expect(formatFuzzyDate({ year: 2023, month: 3, day: 9 })).toBe("2023-03-09");
  });

  test("returns YYYY-MM when day is missing", () => {
    expect(formatFuzzyDate({ year: 2024, month: 7, day: null })).toBe("2024-07");
  });

  test("returns YYYY when only year is present", () => {
    expect(formatFuzzyDate({ year: 2020, month: null, day: null })).toBe("2020");
  });

  test("returns null when input is null", () => {
    expect(formatFuzzyDate(null)).toBeNull();
  });

  test("returns null when year is missing (cannot format a partial-without-year date)", () => {
    expect(formatFuzzyDate({ year: null, month: 5, day: 12 })).toBeNull();
  });

  test("passes through legacy string shape unchanged", () => {
    // Defensive: if upstream ever normalises to ISO string, do not double-format.
    expect(formatFuzzyDate("2021-12-05")).toBe("2021-12-05");
  });
});

describe("pickTitle", () => {
  test("prefers Chinese for zh", () => {
    expect(
      pickTitle({ titleChinese: "鬼灭之刃", titleEnglish: "Demon Slayer" }, "zh"),
    ).toBe("鬼灭之刃");
  });

  test("falls back to English when Chinese missing for zh", () => {
    expect(pickTitle({ titleChinese: null, titleRomaji: "Kimetsu" }, "zh")).toBe("Kimetsu");
  });

  test("prefers English for en", () => {
    expect(
      pickTitle({ titleChinese: "鬼灭之刃", titleEnglish: "Demon Slayer" }, "en"),
    ).toBe("Demon Slayer");
  });

  test("returns empty string when all titles missing", () => {
    expect(pickTitle({}, "zh")).toBe("");
  });
});

describe("formatScore", () => {
  test("scales 0-100 to 0-10 string", () => {
    expect(formatScore(85)).toBe("8.5");
  });
  test("returns N/A for null", () => {
    expect(formatScore(null)).toBe("N/A");
  });
  test("returns N/A for 0", () => {
    expect(formatScore(0)).toBe("N/A");
  });
});

describe("stripHtml", () => {
  test("removes tags", () => {
    expect(stripHtml("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });
  test("returns empty string for null", () => {
    expect(stripHtml(null)).toBe("");
  });
});

describe("truncate", () => {
  test("appends ... when over limit", () => {
    expect(truncate("hello world", 5)).toBe("hello...");
  });
  test("returns unchanged when under limit", () => {
    expect(truncate("hi", 5)).toBe("hi");
  });
});
