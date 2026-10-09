import { describe, expect, test } from "bun:test";

import zhSpa from "@/locales/zh-spa.js";
import enSpa from "@/locales/en-spa.js";
import zhHantSpa from "@/locales/zh-Hant-spa.js";
import { getDictByLang } from "@/lib/i18n";
import { LANGS } from "@/lib/i18n/lang";
import { EDIT_ERROR_KEYS, editErrorKey } from "./errors";
import { fitSize } from "./photo";

describe("errors and photos", () => {
  test("go-api's messages map to the edit page's own words", () => {
    expect(editErrorKey(400, "Nothing changed")).toBe("peopleEdit.errors.nothingChanged");
    expect(editErrorKey(409, "This page already has a submission of yours waiting for review")).toBe(
      "peopleEdit.errors.pending",
    );
    expect(editErrorKey(400, "invalid change: nameCn: too long")).toBe("peopleEdit.errors.invalid");
    expect(editErrorKey(401, "Authentication required")).toBe("peopleEdit.errors.login");
    expect(editErrorKey(429, "something new")).toBe("peopleEdit.errors.tooMany");
    expect(editErrorKey(500, undefined)).toBe("peopleEdit.errors.failed");
    expect(editErrorKey(400, "constructor")).toBe("peopleEdit.errors.failed");
  });

  test("a photo is scaled to fit, never enlarged", () => {
    expect(fitSize(2400, 3600)).toEqual({ width: 800, height: 1200 });
    expect(fitSize(3000, 1000)).toEqual({ width: 1200, height: 400 });
    expect(fitSize(230, 345)).toEqual({ width: 230, height: 345 });
    expect(fitSize(0, 10)).toEqual({ width: 0, height: 0 });
  });
});

// Keys built at run time are invisible to the dictionary coverage test, which
// reads t("…") literals: every one of them is checked here, in both
// dictionaries of every language.
describe("every computed key is in every dictionary", () => {
  const spa: Record<string, unknown> = { zh: zhSpa, en: enSpa, "zh-Hant": zhHantSpa };
  const resolve = (dict: unknown, key: string) =>
    key.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), dict);
  const keys = EDIT_ERROR_KEYS;

  for (const lang of LANGS) {
    test(lang, () => {
      for (const key of keys) {
        expect(typeof resolve(spa[lang], key), `${lang} spa: ${key}`).toBe("string");
        expect(typeof resolve(getDictByLang(lang), key), `${lang} ts: ${key}`).toBe("string");
      }
    });
  }
});
