import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatFuzzyDate,
  formatScore,
  pickCharacterName,
  pickDescription,
  pickStaffName,
  pickTitle,
  pickVoiceActorName,
  stripHtml,
  truncate,
} from "./formatters";
import type { AnimeDetail } from "./types";

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

describe("pickDescription", () => {
  const EN = "A high school student finds a notebook that kills.";
  const CN = "高三生夜神月意外捡到一本名《DEATH NOTE》的笔记本。";

  test("prefers descriptionCn for zh and reports its provenance", () => {
    expect(
      pickDescription(
        { description: EN, descriptionCn: CN, descriptionCnSource: "bangumi" },
        "zh",
      ),
    ).toEqual({ text: CN, source: "bangumi" });
  });

  test("reports a null source for zh when descriptionCnSource is absent", () => {
    // Provenance is advisory — a Chinese body with no recorded source is
    // still rendered, it just carries no attribution.
    expect(pickDescription({ description: EN, descriptionCn: CN }, "zh")).toEqual({
      text: CN,
      source: null,
    });
  });

  test("falls back to English description for zh when descriptionCn is null", () => {
    // The zero-behaviour-change case: right after migration 0014 every row
    // has description_cn = NULL, so zh readers must still see exactly the
    // English text they saw before, with no provenance attached.
    expect(pickDescription({ description: EN, descriptionCn: null }, "zh")).toEqual({
      text: EN,
      source: null,
    });
  });

  test("falls back to English description for zh when descriptionCn is undefined", () => {
    // Payloads from every endpoint other than the detail one omit the field.
    expect(pickDescription({ description: EN }, "zh")).toEqual({
      text: EN,
      source: null,
    });
  });

  test("falls back to English description for zh when descriptionCn is an empty string", () => {
    expect(pickDescription({ description: EN, descriptionCn: "" }, "zh")).toEqual({
      text: EN,
      source: null,
    });
  });

  test("never carries a source through the fallback, even if one is set", () => {
    // A stale descriptionCnSource with no descriptionCn must not label the
    // English body as Bangumi-sourced.
    expect(
      pickDescription(
        { description: EN, descriptionCn: null, descriptionCnSource: "bangumi" },
        "zh",
      ),
    ).toEqual({ text: EN, source: null });
  });

  test("always takes description for en, even when descriptionCn is present", () => {
    // en readers must never be served the Chinese synopsis — this is the
    // property that keeps the channel invisible outside zh.
    //
    // Caveat worth knowing before trusting this at the page level: the detail
    // route never reaches this branch today, because getLang() is pinned to
    // "zh" for every server render (i18n.test.ts, "getLang (ISR-islanded)").
    // So this is a live contract for future callers and a dead one for
    // /anime/[id] — once description_cn fills, an en visitor to that route
    // reads the Chinese body, the same trade pickTitle already makes there.
    // If i18n.test.ts ever goes red because getLang learned to read the
    // cookie, that decision has to be revisited here too.
    expect(
      pickDescription(
        { description: EN, descriptionCn: CN, descriptionCnSource: "bangumi" },
        "en",
      ),
    ).toEqual({ text: EN, source: null });
  });

  test("returns an empty text for en when only descriptionCn exists", () => {
    // en does not borrow from the Chinese slot as a fallback.
    expect(pickDescription({ description: null, descriptionCn: CN }, "en")).toEqual({
      text: "",
      source: null,
    });
  });

  test("returns an empty text, never null, when both fields are empty", () => {
    expect(pickDescription({ description: null, descriptionCn: null }, "zh")).toEqual({
      text: "",
      source: null,
    });
    expect(pickDescription({ description: null, descriptionCn: null }, "en")).toEqual({
      text: "",
      source: null,
    });
    expect(pickDescription({}, "zh")).toEqual({ text: "", source: null });
    expect(pickDescription({}, "en")).toEqual({ text: "", source: null });
  });
});

// ---------------------------------------------------------------------------
// descriptionCn wire contract
//
// pickDescription takes DescriptionBearing, whose fields are all optional, so
// `pickDescription(detail, lang)` in the detail page compiles whether or not
// AnimeDetail — and, upstream of it, the Go JSON — actually carries the
// Chinese slot. Every test above would still pass if the field never arrived:
// the object literals in this file supply it themselves.
//
// That makes a wire break silent in exactly the way `library.overflow.rescan`
// was silent (see locales/spaDictCoverage.test.ts): no exception, no warning,
// just zh readers pinned to the English description forever on the one page
// nobody diffs. So the contract gets pinned end to end the same way that one
// is — by reading the sources and asserting the names line up.
//
// `bunx tsc --noEmit` is not part of CI (unit-tests.yml runs `bun test`
// only), which is why the TS half is asserted at runtime here instead of
// being left to the type-level alias below.
// ---------------------------------------------------------------------------

/**
 * Compile-time half of the same contract: fails `tsc` the moment AnimeDetail
 * loses either field. Exported so it reads as deliberate rather than dead.
 */
type Assignable<T extends U, U> = T;
export type DescriptionCnWireContract = Assignable<
  AnimeDetail,
  { descriptionCn: string | null; descriptionCnSource: string | null }
>;

describe("descriptionCn wire contract", () => {
  const REPO = join(import.meta.dir, "..", "..", "..");

  test("go-api serialises both fields under the names pickDescription reads", () => {
    // The detail struct is the only producer — the list endpoints omit these
    // two on purpose (a full synopsis per card would roughly double those
    // payloads), so this is deliberately scoped to detail.go.
    const detailGo = readFileSync(join(REPO, "go-api/internal/anime/detail.go"), "utf8");

    expect(detailGo).toContain('json:"descriptionCn"');
    expect(detailGo).toContain('json:"descriptionCnSource"');
  });

  test("AnimeDetail declares both fields", () => {
    // Guards the type-level alias above, which CI never evaluates.
    const types = readFileSync(join(import.meta.dir, "types.ts"), "utf8");

    expect(types).toContain("descriptionCn: string | null;");
    expect(types).toContain("descriptionCnSource: string | null;");
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
