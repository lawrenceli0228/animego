import { describe, expect, test } from "bun:test";
import {
  formatFuzzyDate,
  formatScore,
  pickCharacterName,
  pickStaffName,
  pickTitle,
  pickVoiceActorName,
  stripHtml,
  truncate,
} from "./formatters";

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

describe("pickCharacterName", () => {
  test("prefers nameCn for zh", () => {
    expect(
      pickCharacterName({ nameCn: "炭治郎", nameJa: "炭治郎", nameEn: "Tanjiro" }, "zh"),
    ).toBe("炭治郎");
  });

  test("falls back to nameJa when nameCn is absent for zh", () => {
    expect(pickCharacterName({ nameJa: "炭治郎", nameEn: "Tanjiro" }, "zh")).toBe(
      "炭治郎",
    );
  });

  test("falls back to nameEn when nameJa also absent for zh", () => {
    expect(pickCharacterName({ nameEn: "Tanjiro" }, "zh")).toBe("Tanjiro");
  });

  test("prefers nameEn for en", () => {
    expect(
      pickCharacterName({ nameCn: "炭治郎", nameJa: "炭治郎", nameEn: "Tanjiro" }, "en"),
    ).toBe("Tanjiro");
  });

  test("falls back to nameJa for en when nameEn absent", () => {
    expect(pickCharacterName({ nameJa: "炭治郎" }, "en")).toBe("炭治郎");
  });

  test("returns empty string when all fields missing", () => {
    expect(pickCharacterName({}, "zh")).toBe("");
    expect(pickCharacterName({}, "en")).toBe("");
  });
});

describe("pickVoiceActorName", () => {
  test("prefers voiceActorCn for zh", () => {
    expect(
      pickVoiceActorName(
        { voiceActorCn: "花江夏树", voiceActorJa: "Hanae", voiceActorEn: "Natsuki Hanae" },
        "zh",
      ),
    ).toBe("花江夏树");
  });

  test("falls back to voiceActorJa when Cn absent for zh", () => {
    expect(pickVoiceActorName({ voiceActorJa: "Hanae" }, "zh")).toBe("Hanae");
  });

  test("prefers voiceActorEn for en", () => {
    expect(
      pickVoiceActorName(
        { voiceActorCn: "花江夏树", voiceActorJa: "Hanae", voiceActorEn: "Natsuki Hanae" },
        "en",
      ),
    ).toBe("Natsuki Hanae");
  });

  test("returns empty string when all fields missing", () => {
    expect(pickVoiceActorName({}, "zh")).toBe("");
  });
});

describe("pickStaffName", () => {
  test("prefers nameJa for zh (JP names used for zh users per legacy decision)", () => {
    expect(
      pickStaffName({ nameEn: "Haruo Sotozaki", nameJa: "外崎春雄" }, "zh"),
    ).toBe("外崎春雄");
  });

  test("falls back to nameEn when nameJa absent for zh", () => {
    expect(pickStaffName({ nameEn: "Haruo Sotozaki" }, "zh")).toBe(
      "Haruo Sotozaki",
    );
  });

  test("prefers nameEn for en", () => {
    expect(
      pickStaffName({ nameEn: "Haruo Sotozaki", nameJa: "外崎春雄" }, "en"),
    ).toBe("Haruo Sotozaki");
  });

  test("falls back to nameJa for en when nameEn absent", () => {
    expect(pickStaffName({ nameJa: "外崎春雄" }, "en")).toBe("外崎春雄");
  });

  test("returns empty string when all fields missing", () => {
    expect(pickStaffName({}, "zh")).toBe("");
    expect(pickStaffName({}, "en")).toBe("");
  });
});

describe("formatFuzzyDate (zh locale)", () => {
  test("formats YYYY年MM月DD日 for zh with full date", () => {
    expect(formatFuzzyDate({ year: 2021, month: 12, day: 5 }, "zh")).toBe(
      "2021年12月5日",
    );
  });

  test("formats YYYY年MM月 for zh when day is missing", () => {
    expect(formatFuzzyDate({ year: 2024, month: 7, day: null }, "zh")).toBe(
      "2024年7月",
    );
  });

  test("formats YYYY年 for zh when only year is present", () => {
    expect(formatFuzzyDate({ year: 2020, month: null, day: null }, "zh")).toBe(
      "2020年",
    );
  });

  test("passes through an ISO string without double-formatting", () => {
    // String input is parsed and re-formatted in zh style
    expect(formatFuzzyDate("2021-12-05", "zh")).toBe("2021年12月5日");
  });

  test("passes through a non-parseable string as-is (no year to format)", () => {
    // When the string does not match the YYYY[-MM[-DD]] pattern the helper
    // returns the original string unchanged rather than null.
    expect(formatFuzzyDate("not-a-date")).toBe("not-a-date");
  });
});
