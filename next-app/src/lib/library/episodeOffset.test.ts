import { describe, expect, test } from "bun:test";
import { readRuleOffsets, toSiteNumbers } from "./episodeOffset";

// Enen no Shouboutai: San no Shou Part 2 runs 1–13. LoliHouse numbers the
// season's two cours continuously, so Part 2's files are "S3 - 13" … "25".
// The PREQUEL walk sums every earlier season and answers 60; the curated
// anime-relations rule (`149118:13-25 -> 179062:1-13`) answers 12. Pushing
// 13–25 unchanged was rejected with a 400 on every sync.

const PART2 = Array.from({ length: 13 }, (_, i) => 13 + i);
const asArray = (m: Map<number, number>) => [...m.entries()].sort((a, b) => a[0] - b[0]);

describe("toSiteNumbers — anime-relations shifts", () => {
  test("★ a rule shift places a cour numbered on from the one before", () => {
    const out = toSiteNumbers(PART2, 13, 60, [12]);
    expect(asArray(out)).toEqual(PART2.map((n) => [n, n - 12]));
  });

  test("a rule shift that does not fit is skipped for the next one", () => {
    const out = toSiteNumbers(PART2, 13, undefined, [24, 12]);
    expect(asArray(out)).toEqual(PART2.map((n) => [n, n - 12]));
  });

  test("a rule shift needs evidence: numbers all inside the season stay put", () => {
    // A lone "13" may be Part 2's own finale under per-cour numbering.
    expect(asArray(toSiteNumbers([13], 13, undefined, [12]))).toEqual([[13, 13]]);
    expect(asArray(toSiteNumbers([1, 2, 3], 13, undefined, [12]))).toEqual([[1, 1], [2, 2], [3, 3]]);
  });

  test("a rule shift that does not map every number falls back to the offset", () => {
    // 61–73 is franchise-wide numbering: the rule cannot place it, the
    // walked offset can.
    const nums = Array.from({ length: 13 }, (_, i) => 61 + i);
    expect(asArray(toSiteNumbers(nums, 13, 60, [12]))).toEqual(nums.map((n) => [n, n - 60]));
  });

  test("a negative shift moves an episode 0 up", () => {
    expect(asArray(toSiteNumbers([0, 1, 2], 3, undefined, [-1]))).toEqual([[0, 1], [1, 2], [2, 3]]);
  });

  test("without rule shifts nothing changes from before", () => {
    expect(asArray(toSiteNumbers(PART2, 13, 60))).toEqual(PART2.map((n) => [n, n]));
    expect(asArray(toSiteNumbers([38], 10, 28, undefined))).toEqual([[38, 10]]);
  });

  test("an unknown total applies no rule shift", () => {
    expect(asArray(toSiteNumbers(PART2, undefined, undefined, [12]))).toEqual(PART2.map((n) => [n, n]));
  });
});

describe("readRuleOffsets", () => {
  test("keeps non-zero integers, in order and once each", () => {
    expect(readRuleOffsets([12, 0, 12, -1, 2.5, "3"])).toEqual([12, -1]);
  });

  test("anything that is not an array reads as unknown", () => {
    expect(readRuleOffsets(undefined)).toBeUndefined();
    expect(readRuleOffsets(null)).toBeUndefined();
    expect(readRuleOffsets(12)).toBeUndefined();
  });

  test("an empty array is a known answer: no rule", () => {
    expect(readRuleOffsets([])).toEqual([]);
  });
});
