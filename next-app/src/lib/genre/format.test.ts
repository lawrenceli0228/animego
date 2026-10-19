import { describe, expect, test } from "bun:test";

import { countText, formatCount, heroCountText } from "./format";

describe("formatCount", () => {
  test("groups thousands, for every language alike", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(7)).toBe("7");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1000)).toBe("1,000");
    expect(formatCount(5241)).toBe("5,241");
    expect(formatCount(1234567)).toBe("1,234,567");
  });

  test("anything that is not a count reads as 0", () => {
    expect(formatCount(null)).toBe("0");
    expect(formatCount(undefined)).toBe("0");
    expect(formatCount(Number.NaN)).toBe("0");
    expect(formatCount(-4)).toBe("0");
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe("0");
    expect(formatCount(12.9)).toBe("12");
  });
});

describe("countText", () => {
  test("fills the template", () => {
    expect(countText("{{n}} 部", 84)).toBe("84 部");
    expect(countText("{{n}} titles", 12345)).toBe("12,345 titles");
  });
});

describe("heroCountText", () => {
  const zh = { count: "{{n}} 部", countLine: "{{n}} 部 · {{m}} 部连载中" };
  const en = { count: "{{n}} titles", countLine: "{{n}} titles · {{m}} airing" };
  const hant = { count: "{{n}} 部", countLine: "{{n}} 部 · {{m}} 部連載中" };

  test("the total and what is airing", () => {
    expect(heroCountText(zh, 5241, 84)).toBe("5,241 部 · 84 部连载中");
    expect(heroCountText(en, 5241, 84)).toBe("5,241 titles · 84 airing");
    expect(heroCountText(hant, 5241, 84)).toBe("5,241 部 · 84 部連載中");
  });

  test("nothing airing: only the total; nothing known: nothing", () => {
    expect(heroCountText(zh, 312, 0)).toBe("312 部");
    expect(heroCountText(zh, 0, 0)).toBe("");
    expect(heroCountText(zh, null, null)).toBe("");
  });
});
