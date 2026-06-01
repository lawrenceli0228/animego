import { describe, expect, test, mock, afterAll, beforeEach } from "bun:test";

// Mutable state that each test can configure before importing i18n.
let mockLangCookie: string | undefined = undefined;
let mockAcceptLanguage = "";
// Tracks whether the server-only Dynamic APIs were touched. getLang() is now
// ISR-islanded — it must NEVER read cookies()/headers() (that forced every
// page dynamic), so these must stay false through any getLang/getDict call.
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

const { getLang, getDict, getDictByLang, tFromDict } = await import(
  "./i18n"
);

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  mockLangCookie = undefined;
  mockAcceptLanguage = "";
  cookiesCalled = false;
  headersCalled = false;
});

describe("getLang (ISR-islanded — always zh, never reads cookies/headers)", () => {
  test("returns zh regardless of the lang cookie", async () => {
    mockLangCookie = "en";
    expect(await getLang()).toBe("zh");
  });

  test("returns zh regardless of Accept-Language", async () => {
    mockAcceptLanguage = "en-US,en;q=0.9";
    expect(await getLang()).toBe("zh");
  });

  test("returns zh with no cookie and no header", async () => {
    expect(await getLang()).toBe("zh");
  });

  test("does NOT read cookies() or headers() — the whole ISR point", async () => {
    mockLangCookie = "en";
    mockAcceptLanguage = "en-US";
    await getLang();
    expect(cookiesCalled).toBe(false);
    expect(headersCalled).toBe(false);
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
