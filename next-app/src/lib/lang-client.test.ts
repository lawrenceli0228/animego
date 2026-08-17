import { describe, expect, test } from "bun:test";
import { nextLang, readCookie } from "./lang-client";
import { DEFAULT_LANG, LANGS, toLang } from "./i18n/lang";

// Covers the two pure helpers behind the client language provider. Both
// replaced two-outcome logic that could not represent a third language:
//
//   cookieLang: /(?:^|;\s*)lang=en\b/.test(jar) ? "en" : "zh"
//   toggle:     lang === "zh" ? "en" : "zh"
//
// Neither had a test, and neither would have failed one written against the
// two languages that existed — which is exactly why the third language would
// have arrived as a runtime symptom (the switcher appears to do nothing)
// rather than as a red suite.
//
// Both helpers take their input as an argument instead of reaching for
// `document.cookie`, so this suite needs no DOM stub. That is deliberate: bun
// shares one process across test files, and a `globalThis.document` left
// behind here would change how unrelated suites behave (see
// testImportHygiene.test.ts for the CI-only failure that pattern produces).

describe("readCookie", () => {
  test("reads a value the old regex could not: any language tag, not just en", () => {
    // The whole point. A parser returns whatever was written; the regex it
    // replaced answered "is it en?" and turned everything else into zh.
    expect(readCookie("lang=zh-Hant", "lang")).toBe("zh-Hant");
    expect(readCookie("lang=ja", "lang")).toBe("ja");
    expect(readCookie("lang=en", "lang")).toBe("en");
    expect(readCookie("lang=zh", "lang")).toBe("zh");
  });

  test("finds the cookie at any position in the jar", () => {
    expect(readCookie("theme=dark; lang=en; sid=abc", "lang")).toBe("en");
    expect(readCookie("theme=dark;lang=en", "lang")).toBe("en");
    expect(readCookie("lang=en; theme=dark", "lang")).toBe("en");
  });

  test("does not match a cookie whose name merely ends with the one asked for", () => {
    // `sitelang=en` must not answer a request for `lang`. The old regex
    // guarded this with `(?:^|;\s*)`; an indexOf-based parser has to guard it
    // by comparing the whole name, which is what the trim + === does.
    expect(readCookie("sitelang=en", "lang")).toBeNull();
    expect(readCookie("xlang=en; theme=dark", "lang")).toBeNull();
    expect(readCookie("sitelang=en; lang=zh", "lang")).toBe("zh");
  });

  test("returns null for an absent cookie and an empty jar", () => {
    expect(readCookie("theme=dark", "lang")).toBeNull();
    expect(readCookie("", "lang")).toBeNull();
  });

  test("tolerates valueless and malformed segments rather than throwing", () => {
    // Real jars contain flag-style entries and stray semicolons.
    expect(readCookie("secure; lang=en", "lang")).toBe("en");
    expect(readCookie(";;; lang=en ;;;", "lang")).toBe("en");
    expect(readCookie("lang=", "lang")).toBe("");
  });

  test("keeps '=' inside the value intact", () => {
    // Only the first '=' separates name from value; a base64-ish neighbour
    // must not corrupt the read.
    expect(readCookie("sid=a=b=c; lang=en", "sid")).toBe("a=b=c");
  });

  test("composes with toLang to reject anything that is not a language", () => {
    // The pair is what cookieLang() does. A junk value falls back rather than
    // being coerced into whichever branch a two-outcome test happened to pick.
    expect(toLang(readCookie("lang=en", "lang"))).toBe("en");
    expect(toLang(readCookie("lang=xx", "lang"))).toBe(DEFAULT_LANG);
    expect(toLang(readCookie("theme=dark", "lang"))).toBe(DEFAULT_LANG);
  });
});

describe("nextLang", () => {
  test("visits every language and returns to the start", () => {
    // The property that matters, stated over LANGS rather than over "zh"/"en":
    // cycling LANGS.length times from any entry must be the identity, and no
    // step may repeat. A language added to LANGS and forgotten by the toggle
    // would break this without the test being edited.
    for (const start of LANGS) {
      const seen = [start];
      let current = start;
      for (let i = 0; i < LANGS.length - 1; i++) {
        current = nextLang(current);
        seen.push(current);
      }
      expect([...seen].sort()).toEqual([...LANGS].sort());
      expect(nextLang(current)).toBe(start);
    }
  });

  test("preserves the two-language behaviour the chrome button shipped with", () => {
    expect(nextLang("zh")).toBe("en");
    expect(nextLang("en")).toBe("zh");
  });

  test("restarts the cycle for a value that is not in LANGS", () => {
    // Defence in depth: toLang already filters the cookie, so this is only
    // reachable via a stale in-memory value. Returning LANGS[0] keeps the
    // button working rather than handing undefined to the dictionary lookup.
    expect(nextLang("de" as never)).toBe(LANGS[0]);
  });
});
