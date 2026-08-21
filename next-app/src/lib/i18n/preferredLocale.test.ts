import { describe, expect, test } from "bun:test";
import { preferredLocale } from "./preferredLocale";
import { LOCALES, type Locale } from "./locale";

// The hint this feeds is shown once per visitor and then never again, so a
// wrong answer is not something the visitor can correct by reloading — they
// dismiss it and it is gone. That asymmetry is why the decision lives in a
// pure function with a table of real Accept-Language values rather than
// inside a component where it can only be checked by hand.

describe("Chinese tags resolve by script, not by region name", () => {
  const cases: Array<[string, Locale]> = [
    // Traditional-using regions.
    ["zh-TW", "zh-Hant"],
    ["zh-HK", "zh-Hant"],
    ["zh-MO", "zh-Hant"],
    ["zh-Hant", "zh-Hant"],
    ["zh-Hant-TW", "zh-Hant"],
    ["zh-Hant-HK", "zh-Hant"],
    // Simplified-using regions.
    ["zh-CN", "zh-Hans"],
    ["zh-SG", "zh-Hans"],
    ["zh-MY", "zh-Hans"],
    ["zh-Hans", "zh-Hans"],
    ["zh-Hans-CN", "zh-Hans"],
  ];

  for (const [tag, want] of cases) {
    test(`${tag} -> ${want}`, () => {
      // Current is `en` so any Chinese preference is a real suggestion.
      expect(preferredLocale([tag], "en")).toBe(want);
    });
  }

  test("bare zh resolves to Simplified", () => {
    // A coin flip in the standard, and deliberately called this way: a
    // browser set up by a Traditional reader almost always carries a region
    // or script subtag, and guessing Simplified fails into "no hint shown"
    // rather than into a hint pointing the wrong way.
    expect(preferredLocale(["zh"], "en")).toBe("zh-Hans");
  });

  test("case and whitespace do not change the answer", () => {
    expect(preferredLocale(["  ZH-tw  "], "en")).toBe("zh-Hant");
    expect(preferredLocale(["ZH-HANT-hk"], "en")).toBe("zh-Hant");
  });
});

describe("only the first recognised tag counts", () => {
  test("a reader already on their first choice gets no hint", () => {
    expect(preferredLocale(["zh-CN", "en"], "zh-Hans")).toBeNull();
    expect(preferredLocale(["en-US", "zh-TW"], "en")).toBeNull();
  });

  test("and the lower-ranked tag is NOT used as a fallback", () => {
    // The failure this prevents: ["zh-CN", "en"] on the Simplified tree
    // scanning past the satisfied preference and suggesting English, which
    // would move a reader off the page they asked for.
    expect(preferredLocale(["zh-CN", "en"], "zh-Hans")).toBeNull();
  });

  test("tags we do not serve are skipped, not treated as a match", () => {
    expect(preferredLocale(["fr-FR", "de", "zh-TW"], "zh-Hans")).toBe("zh-Hant");
  });

  test("a list of nothing we serve produces no hint", () => {
    expect(preferredLocale(["fr", "de", "ja", "ko"], "zh-Hans")).toBeNull();
  });
});

describe("degenerate input", () => {
  test.each([
    ["undefined", undefined],
    ["empty list", []],
    ["empty strings", ["", "   "]],
  ])("%s produces no hint", (_name, input) => {
    expect(preferredLocale(input as string[] | undefined, "zh-Hans")).toBeNull();
  });
});

describe("it can only ever suggest a locale the site publishes", () => {
  test("every possible answer is in LOCALES", () => {
    const tags = ["zh-TW", "zh-CN", "zh", "en-GB", "zh-Hant", "fr", "ja"];
    for (const tag of tags) {
      const got = preferredLocale([tag], "en");
      if (got !== null) expect(LOCALES).toContain(got);
    }
  });

  test("an unpublished locale is not offered", () => {
    // Simulates zh-Hant being pulled from LOCALES. A hint that survived that
    // would point at a 404, which is worse than no hint: hreflang aside, it
    // is a dead end handed to the one visitor who wanted that language.
    const withoutHant = LOCALES.filter((l) => l !== "zh-Hant");
    expect(preferredLocale(["zh-TW"], "zh-Hans", withoutHant)).toBeNull();
    // …and the Simplified path still works, so the narrowing is specific.
    expect(preferredLocale(["en-US"], "zh-Hans", withoutHant)).toBe("en");
  });
});
