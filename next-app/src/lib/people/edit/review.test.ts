import { describe, expect, test } from "bun:test";

import zhSpa from "@/locales/zh-spa.js";
import enSpa from "@/locales/en-spa.js";
import zhHantSpa from "@/locales/zh-Hant-spa.js";
import { getDictByLang } from "@/lib/i18n";
import { LANGS } from "@/lib/i18n/lang";
import {
  decisionsComplete,
  EDIT_FIELDS,
  fieldLabelKey,
  initialDecisions,
  reviewBody,
  validReviewBody,
  type EditItem,
} from "./review";

function item(id: string, field: EditItem["field"] = "nameCn"): EditItem {
  return { id, field, key: "", old: null, new: "x", meta: null, status: "pending", rejectNote: null, previewUrl: null };
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("the review's decisions", () => {
  test("start all accepted, need a note on every rejection", () => {
    const items = [item(A), item(B, "image")];
    const decisions = initialDecisions(items);
    expect(decisionsComplete(items, decisions)).toBe(true);

    const rejected = { ...decisions, [B]: { accept: false, note: "  " } };
    expect(decisionsComplete(items, rejected)).toBe(false);
    const noted = { ...decisions, [B]: { accept: false, note: " 第二季的造型 " } };
    expect(decisionsComplete(items, noted)).toBe(true);
    expect(reviewBody(items, noted)).toEqual({
      decisions: [
        { itemId: A, accept: true },
        { itemId: B, accept: false, note: "第二季的造型" },
      ],
    });
  });

  test("the server action checks what it forwards", () => {
    expect(validReviewBody({ decisions: [{ itemId: A, accept: true }] })).toBe(true);
    expect(validReviewBody({ decisions: [{ itemId: A, accept: false, note: "why" }] })).toBe(true);
    for (const bad of [
      null,
      {},
      { decisions: [] },
      { decisions: [{ itemId: "x", accept: true }] },
      { decisions: [{ itemId: A, accept: "yes" }] },
      { decisions: [{ itemId: A, accept: false }] },
      { decisions: [{ itemId: A, accept: false, note: "   " }] },
      { decisions: [{ itemId: A, accept: false, note: "x".repeat(501) }] },
      { decisions: [{ itemId: A, accept: true, note: "unexpected" }] },
    ]) {
      expect(validReviewBody(bad)).toBe(false);
    }
  });
});

// Keys built at run time are invisible to the dictionary coverage test, which
// reads t("…") literals: every one of them is checked here, in both
// dictionaries of every language.
describe("every computed key is in every dictionary", () => {
  const spa: Record<string, unknown> = { zh: zhSpa, en: enSpa, "zh-Hant": zhHantSpa };
  const resolve = (dict: unknown, key: string) =>
    key.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), dict);
  const keys = EDIT_FIELDS.map(fieldLabelKey);

  for (const lang of LANGS) {
    test(lang, () => {
      for (const key of keys) {
        expect(typeof resolve(spa[lang], key), `${lang} spa: ${key}`).toBe("string");
        expect(typeof resolve(getDictByLang(lang), key), `${lang} ts: ${key}`).toBe("string");
      }
    });
  }
});
