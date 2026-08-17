import { describe, expect, test, mock, afterAll, beforeEach } from "bun:test";

// Mutable state that each test can configure before importing i18n.
let mockLangCookie: string | undefined = undefined;
let mockAcceptLanguage = "";
// Tracks whether the server-only Dynamic APIs were touched. Nothing in this
// module may read cookies()/headers(): either one forces every page that
// imports it dynamic, which is what killed ISR on /anime/[id] once already.
// These must stay false through any accessor call.
let cookiesCalled = false;
let headersCalled = false;

mock.module("next/headers", () => ({
  cookies: async () => {
    cookiesCalled = true;
    return {
      get: (name: string) => {
        if (name === "lang" && mockLangCookie !== undefined) {
          return { value: mockLangCookie };
        }
        return undefined;
      },
    };
  },
  headers: async () => {
    headersCalled = true;
    return {
      get: (name: string) => {
        if (name === "accept-language") return mockAcceptLanguage || null;
        return null;
      },
    };
  },
}));

const i18n = await import("./i18n");
const { getDict, getDictByLang, tFromDict } = i18n;

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  mockLangCookie = undefined;
  mockAcceptLanguage = "";
  cookiesCalled = false;
  headersCalled = false;
});

describe("getLang is gone and must stay gone", () => {
  // It returned the constant "zh". Harmless while the site served one locale
  // at one set of URLs; once the routes moved under app/[lang]/ it meant
  // /en/anything rendered Chinese, on every call site at once, with nothing
  // failing. The language is a property of the request path now, so only the
  // router can supply it — lib/i18n/route.ts resolveLocale().
  //
  // Asserted rather than merely deleted because the failure mode is a
  // reintroduction: the next component that finds itself without route params
  // has an obvious, wrong, compiling answer available to it.
  test("the module exports no language-guessing accessor", () => {
    expect("getLang" in i18n).toBe(false);
  });
});

describe("the module never reads Dynamic APIs", () => {
  // The ISR invariant, guarded at the module rather than at one function:
  // a cookies() or headers() read anywhere in here forces every importing
  // page dynamic, and /anime/[id] going dynamic silently empties the
  // Cloudflare edge cache that serves the site's whole SEO surface.
  test("getDict touches neither cookies() nor headers()", async () => {
    mockLangCookie = "en";
    mockAcceptLanguage = "en-US";
    await getDict();
    expect(cookiesCalled).toBe(false);
    expect(headersCalled).toBe(false);
  });

  test("getDictByLang touches neither cookies() nor headers()", () => {
    mockLangCookie = "en";
    mockAcceptLanguage = "en-US";
    getDictByLang("en");
    expect(cookiesCalled).toBe(false);
    expect(headersCalled).toBe(false);
  });
});

describe("getDict", () => {
  test("returns the default (zh) dict", async () => {
    const dict = await getDict();
    // Spot-check a zh-only key to confirm we got the right dict
    expect(dict.common.loading).toBe("加载中...");
  });

  test("ignores the lang cookie — it resolves nothing per-request", async () => {
    // The point of the assertion: getDict is a DEFAULT, not a resolution.
    // A caller that wants the request's language must go through
    // resolveLocale(params), which reads the route segment.
    mockLangCookie = "en";
    const dict = await getDict();
    expect(dict.common.loading).toBe("加载中...");
  });
});

describe("getDictByLang", () => {
  test("returns zh dict synchronously for zh", () => {
    const dict = getDictByLang("zh");
    expect(dict.common.loading).toBe("加载中...");
  });

  test("returns en dict synchronously for en", () => {
    const dict = getDictByLang("en");
    expect(typeof dict).toBe("object");
  });
});

describe("tFromDict", () => {
  test("resolves a deeply nested key", () => {
    const dict = getDictByLang("zh");
    const t = tFromDict(dict);
    expect(t("common.loading")).toBe("加载中...");
  });

  test("returns defaultValue when key path is missing", () => {
    const dict = getDictByLang("zh");
    const t = tFromDict(dict);
    expect(t("no.such.path", { defaultValue: "fallback" })).toBe("fallback");
  });

  test("returns the key itself when path is missing and no defaultValue given", () => {
    const dict = getDictByLang("zh");
    const t = tFromDict(dict);
    expect(t("nonexistent.key")).toBe("nonexistent.key");
  });

  test("resolves a top-level key", () => {
    const dict = getDictByLang("zh");
    const t = tFromDict(dict);
    // meta.titleDefault exists in zh
    expect(t("meta.titleDefault")).toContain("AnimeGoClub");
  });

  test("coerces a non-string leaf value to string", () => {
    const dict = getDictByLang("zh");
    const t = tFromDict(dict);
    // meta.keywords is an array; String([...]) gives a comma-joined string
    const val = t("meta.keywords");
    expect(typeof val).toBe("string");
    expect(val.length).toBeGreaterThan(0);
  });
});
