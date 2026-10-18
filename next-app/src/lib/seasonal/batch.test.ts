import { describe, expect, test } from "bun:test";

import { batchSize, effectiveView, hiddenCount, staggerMs, visibleCount } from "./batch";

describe("batches", () => {
  test("a desktop shows 36 covers, 12 chart cards or 16 rows at a time", () => {
    expect(batchSize("grid", "desktop")).toBe(36);
    expect(batchSize("chart", "desktop")).toBe(12);
    expect(batchSize("table", "desktop")).toBe(16);
  });

  test("a phone shows 21 covers or 7 chart cards, and draws the grid where a table was asked for", () => {
    expect(batchSize("grid", "phone")).toBe(21);
    expect(batchSize("chart", "phone")).toBe(7);
    expect(effectiveView("table", "phone")).toBe("grid");
    expect(batchSize("table", "phone")).toBe(21);
    expect(effectiveView("table", "desktop")).toBe("table");
  });

  test("visible and hidden counts", () => {
    expect(visibleCount(99, 1, 36)).toBe(36);
    expect(visibleCount(99, 2, 36)).toBe(72);
    expect(visibleCount(99, 3, 36)).toBe(99);
    expect(visibleCount(10, 1, 36)).toBe(10);
    expect(visibleCount(99, 0, 36)).toBe(36);
    expect(hiddenCount(99, 2, 36)).toBe(27);
    expect(hiddenCount(10, 1, 36)).toBe(0);
  });

  test("each revealed batch starts its stagger from zero", () => {
    expect(staggerMs(0, "grid", "desktop")).toBe(0);
    expect(staggerMs(35, "grid", "desktop")).toBe(35 * 16);
    expect(staggerMs(36, "grid", "desktop")).toBe(0);
    expect(staggerMs(37, "grid", "desktop")).toBe(16);
    expect(staggerMs(13, "chart", "desktop")).toBe(34);
    expect(staggerMs(17, "table", "desktop")).toBe(24);
    expect(staggerMs(22, "grid", "phone")).toBe(22);
    expect(staggerMs(8, "chart", "phone")).toBe(40);
  });
});
