import { describe, expect, test } from "bun:test";

import zh from "./zh";
import zhHant from "./zh-Hant";
import zhSpa from "./zh-spa.js";
import zhHantSpa from "./zh-Hant-spa.js";

// zh-Hant is a *derived* dictionary: every one of its entries exists because
// the Simplified one does. That makes it the one pair in the repo where key-set
// equality is a real invariant rather than a coincidence, and worth a gate.
//
// spaDictCoverage.test.ts checks something adjacent but different — that every
// key a client component ASKS for resolves in every dictionary. It cannot see a
// key that exists in zh and is missing from zh-Hant if nothing calls t() on it,
// which is most of the server dictionary. And it does not look at the .ts
// dictionaries at all.
//
// The failure this closes: t() and tFromDict() both return the KEY ITSELF on a
// miss (see lib/i18n.ts), with no throw and no console warning. A dropped key
// renders as `library.overflow.rescan` in the page, which is exactly how that
// string once shipped. A conversion pass that reformats the file, or a merge
// that resolves a conflict by taking one side, can drop a key silently.

/** Leaf paths of a nested dict. Arrays (meta.keywords) count as one leaf. */
function flatten(obj: unknown, prefix = ""): string[] {
  return Object.entries((obj ?? {}) as Record<string, unknown>).flatMap(
    ([k, v]) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? flatten(v, `${prefix}${k}.`)
        : [`${prefix}${k}`],
  );
}

/** Leaf path -> value, for the pairs that compare values rather than keys. */
function leaves(obj: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [k, v] of Object.entries((obj ?? {}) as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [ik, iv] of leaves(v, `${prefix}${k}.`)) out.set(ik, iv);
    } else {
      out.set(`${prefix}${k}`, v);
    }
  }
  return out;
}

/**
 * Hiragana, katakana, and the kana punctuation between them.
 *
 * The dictionaries carry real Japanese — the site's tagline is
 * "Rundle Streetが暮れる。東京が灯る。" — and OpenCC does not know it is
 * looking at Japanese. s2twp maps 灯 to 燈 and around 131 other shinjitai
 * the same way, so a conversion pass run over the whole file corrupts every
 * Japanese string in it and reports success. The rule during the conversion
 * was "never convert a string containing kana"; this is that rule, kept.
 */
const KANA = /[぀-ヿ]/;

const PAIRS: Array<[string, unknown, unknown]> = [
  ["server (.ts)", zh, zhHant],
  ["client (-spa.js)", zhSpa, zhHantSpa],
];

describe.each(PAIRS)("%s: zh-Hant mirrors zh", (_name, simplified, traditional) => {
  const zhKeys = flatten(simplified);
  const hantKeys = flatten(traditional);

  test("the scan actually finds keys", () => {
    // Guards the guard: an import or flatten change that yields nothing would
    // make "the two sets are equal" vacuously true on two empty sets.
    expect(zhKeys.length).toBeGreaterThan(100);
  });

  test("no key is missing from zh-Hant", () => {
    const hant = new Set(hantKeys);
    expect(zhKeys.filter((k) => !hant.has(k))).toEqual([]);
  });

  test("zh-Hant invents no key of its own", () => {
    // The other direction matters too: a key only zh-Hant has is dead weight
    // that no call site can reach, and usually a typo'd rename that left the
    // real key behind in zh.
    const simplifiedSet = new Set(zhKeys);
    expect(hantKeys.filter((k) => !simplifiedSet.has(k))).toEqual([]);
  });

  test("every Japanese string is carried across unconverted", () => {
    const hantLeaves = leaves(traditional);
    const corrupted: string[] = [];
    for (const [key, value] of leaves(simplified)) {
      if (typeof value !== "string" || !KANA.test(value)) continue;
      if (hantLeaves.get(key) !== value) corrupted.push(key);
    }
    expect(corrupted).toEqual([]);
  });
});
