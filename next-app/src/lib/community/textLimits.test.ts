import { describe, expect, test } from "bun:test";
import {
  REPLY_MAX,
  REVIEW_BODY_MAX,
  REVIEW_BODY_MIN,
  normalizeBody,
  normalizeLine,
  replyProblem,
  reviewProblems,
  storedBodyLength,
  threadProblems,
  visibleLength,
} from "./textLimits";

// These mirror go-api/internal/community/validate.go. The cases are the
// same ones validate_test.go runs, so the counter under a field and the
// server's 400 change at the same character.

const ZWSP = String.fromCharCode(0x200b);
const BOM = String.fromCharCode(0xfeff);
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);

describe("visibleLength", () => {
  test.each([
    ["", 0],
    ["好", 1],
    [`好${" ".repeat(400)}好`, 3],
    ["  first para\n\nsecond  ", "first para second".length],
    [`一${ZWSP}二${BOM}三`, 3],
    [ZWSP + ZWSP, 0],
    ["a b", 3],
  ])("%j → %i", (input, want) => {
    expect(visibleLength(input as string)).toBe(want as number);
  });

  test("counts code points, not UTF-16 units", () => {
    expect(visibleLength("😀😀")).toBe(2);
    expect("😀😀".length).toBe(4);
  });
});

describe("normalisation matches the server's", () => {
  test("bodies: line endings, controls, trim", () => {
    expect(normalizeBody("a\r\nb\rc")).toBe("a\nb\nc");
    expect(normalizeBody("  第一段\n\n第二段  ")).toBe("第一段\n\n第二段");
    expect(normalizeBody(`a${String.fromCharCode(0)}b${String.fromCharCode(7)}c`)).toBe("abc");
    expect(normalizeBody("a\tb")).toBe("a\tb");
  });

  test("lines collapse every whitespace run", () => {
    expect(normalizeLine("  一句\n\n 话总结\t ")).toBe("一句 话总结");
    expect(normalizeLine(`full width${IDEOGRAPHIC_SPACE}space`)).toBe("full width space");
  });
});

describe("reviewProblems", () => {
  const ok = "好".repeat(REVIEW_BODY_MIN);
  test("valid at both minimums", () => {
    expect(reviewProblems("一".repeat(10), ok)).toEqual([]);
  });
  test("summary one short and one long", () => {
    expect(reviewProblems("一".repeat(9), ok)).toEqual(["summaryLength"]);
    expect(reviewProblems("一".repeat(61), ok)).toEqual(["summaryLength"]);
  });
  test("summary padded to length with zero-width spaces is still short", () => {
    expect(reviewProblems(`短${ZWSP.repeat(20)}`, ok)).toEqual(["summaryLength"]);
  });
  test("body one short, padded with spaces, and over the maximum", () => {
    expect(reviewProblems("一".repeat(10), "好".repeat(REVIEW_BODY_MIN - 1))).toEqual(["bodyShort"]);
    expect(reviewProblems("一".repeat(10), `好${" ".repeat(400)}好`)).toEqual(["bodyShort"]);
    expect(reviewProblems("一".repeat(10), "好".repeat(REVIEW_BODY_MAX + 1))).toEqual(["bodyLong"]);
  });
  test("both at once, in field order", () => {
    expect(reviewProblems("", "")).toEqual(["summaryLength", "bodyShort"]);
  });
});

describe("threadProblems and replyProblem", () => {
  test("thread", () => {
    expect(threadProblems("第五集讨论", "说说看")).toEqual([]);
    expect(threadProblems("三个字", "x")).toEqual(["titleLength"]);
    expect(threadProblems("第 五", "x")).toEqual(["titleLength"]);
    expect(threadProblems("第五集讨论", " \n ")).toEqual(["bodyEmpty"]);
  });
  test("reply", () => {
    expect(replyProblem("  我也看完了！ ")).toBeNull();
    expect(replyProblem(`${ZWSP} \n`)).toBe("empty");
    expect(replyProblem("字".repeat(REPLY_MAX))).toBeNull();
    expect(replyProblem("字".repeat(REPLY_MAX + 1))).toBe("tooLong");
    expect(storedBodyLength(`  ${"字".repeat(REPLY_MAX)}  `)).toBe(REPLY_MAX);
  });
});
