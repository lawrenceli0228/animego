import { describe, expect, test, mock, afterAll, beforeEach } from "bun:test";

// Mutable state that each test can configure before importing i18n.
let mockLangCookie: string | undefined = undefined;
let mockAcceptLanguage = "";

mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      if (name === "lang" && mockLangCookie !== undefined) {
        return { value: mockLangCookie };
      }
      return undefined;
    },
  }),
  headers: async () => ({
    get: (name: string) => {
      if (name === "accept-language") return mockAcceptLanguage || null;
      return null;
    },
  }),
}));

const { getLang, getDict, getDictByLang, tFromDict } = await import(
  "./i18n"
);

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  mockLangCookie = undefined;
  mockAcceptLanguage = "";
});

describe("getLang", () => {
  test("returns zh when lang cookie is zh", async () => {
    mockLangCookie = "zh";
    expect(await getLang()).toBe("zh");
  });

  test("returns en when lang cookie is en", async () => {
    mockLangCookie = "en";
    expect(await getLang()).toBe("en");
  });

  test("falls back to Accept-Language zh when no lang cookie", async () => {
    mockLangCookie = undefined;
    mockAcceptLanguage = "zh-CN,zh;q=0.9,en;q=0.8";
    expect(await getLang()).toBe("zh");
  });

  test("falls back to Accept-Language en when no lang cookie and first pref is en", async () => {
    mockLangCookie = undefined;
    mockAcceptLanguage = "en-US,en;q=0.9";
    expect(await getLang()).toBe("en");
  });

  test("defaults to zh when no cookie and no Accept-Language header", async () => {
    mockLangCookie = undefined;
    mockAcceptLanguage = "";
    expect(await getLang()).toBe("zh");
  });

  test("ignores unrecognised cookie value and uses Accept-Language", async () => {
    mockLangCookie = "fr";  // not zh or en
    mockAcceptLanguage = "en-GB";
    expect(await getLang()).toBe("en");
  });
});

describe("getDict", () => {
  test("returns zh dict when lang is zh", async () => {
    mockLangCookie = "zh";
    const dict = await getDict();
    // Spot-check a zh-only key to confirm we got the right dict
    expect(dict.common.loading).toBe("加载中...");
  });

  test("returns a dict object when lang is en", async () => {
    mockLangCookie = "en";
    const dict = await getDict();
    expect(typeof dict).toBe("object");
    expect(dict).not.toBeNull();
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
    expect(t("meta.titleDefault")).toContain("AnimeGo");
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
