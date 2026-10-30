import { describe, expect, test } from "bun:test";
import { effectiveTopView, shownCount, topBatchSize, topStaggerMs } from "./batch";

describe("batches", () => {
  test("twenty to a batch on a desktop, whatever the view", () => {
    expect(topBatchSize("grid", "desktop")).toBe(20);
    expect(topBatchSize("chart", "desktop")).toBe(20);
    expect(topBatchSize("table", "desktop")).toBe(20);
  });

  test("a phone: seven rows of three covers, twenty list rows, and the grid where a chart was asked for", () => {
    expect(topBatchSize("grid", "phone")).toBe(21);
    expect(topBatchSize("table", "phone")).toBe(20);
    expect(effectiveTopView("chart", "phone")).toBe("grid");
    expect(effectiveTopView("table", "phone")).toBe("table");
    expect(effectiveTopView("chart", "desktop")).toBe("chart");
  });

  test("a hundred shows open in five batches, and never past the end", () => {
    expect(shownCount(100, 1, 20)).toBe(20);
    expect(shownCount(100, 4, 20)).toBe(80);
    expect(shownCount(100, 5, 20)).toBe(100);
    expect(shownCount(100, 9, 20)).toBe(100);
    expect(shownCount(7, 1, 20)).toBe(7);
    expect(shownCount(100, 0, 20)).toBe(20);
  });

  test("each batch starts its stagger from zero", () => {
    expect(topStaggerMs(0, "grid", "desktop")).toBe(0);
    expect(topStaggerMs(19, "grid", "desktop")).toBe(19 * 16);
    expect(topStaggerMs(20, "grid", "desktop")).toBe(0);
  });
});
