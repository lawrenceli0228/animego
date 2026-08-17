import { describe, expect, test } from "bun:test";

import { resolveMergedSeriesIds } from "./resolveMergedIds";

describe("resolveMergedSeriesIds", () => {
  test("returns just the root when nothing was merged", () => {
    expect(resolveMergedSeriesIds([], "C")).toEqual(["C"]);
  });

  test("returns just the root when the override table is absent", () => {
    expect(resolveMergedSeriesIds(null, "C")).toEqual(["C"]);
    expect(resolveMergedSeriesIds(undefined, "C")).toEqual(["C"]);
  });

  test("includes a single direct source", () => {
    const overrides = [{ seriesId: "C", mergedFrom: ["B"] }];
    expect(resolveMergedSeriesIds(overrides, "C")).toEqual(["C", "B"]);
  });

  // The regression this module exists for. A→B then B→C used to yield
  // ["C","B"], so every episode indexed under A vanished from the detail
  // sheet — and useLibrary hides any id that appears in any mergedFrom, so A
  // was gone from the grid as well. Files on disk, reachable from nowhere.
  test("follows a merge chain transitively", () => {
    const overrides = [
      { seriesId: "C", mergedFrom: ["B"] },
      { seriesId: "B", mergedFrom: ["A"] },
    ];
    expect(resolveMergedSeriesIds(overrides, "C")).toEqual(["C", "B", "A"]);
  });

  test("follows a deep chain", () => {
    const overrides = [
      { seriesId: "E", mergedFrom: ["D"] },
      { seriesId: "D", mergedFrom: ["C"] },
      { seriesId: "C", mergedFrom: ["B"] },
      { seriesId: "B", mergedFrom: ["A"] },
    ];
    expect(resolveMergedSeriesIds(overrides, "E")).toEqual([
      "E",
      "D",
      "C",
      "B",
      "A",
    ]);
  });

  test("collects several sources merged into the same target", () => {
    const overrides = [{ seriesId: "C", mergedFrom: ["A", "B"] }];
    expect(resolveMergedSeriesIds(overrides, "C")).toEqual(["C", "A", "B"]);
  });

  test("walks breadth-first so ordering stays root, sources, their sources", () => {
    const overrides = [
      { seriesId: "R", mergedFrom: ["X", "Y"] },
      { seriesId: "X", mergedFrom: ["X1"] },
      { seriesId: "Y", mergedFrom: ["Y1"] },
    ];
    expect(resolveMergedSeriesIds(overrides, "R")).toEqual([
      "R",
      "X",
      "Y",
      "X1",
      "Y1",
    ]);
  });

  test("de-duplicates a source reachable by two paths", () => {
    const overrides = [
      { seriesId: "R", mergedFrom: ["X", "Y"] },
      { seriesId: "X", mergedFrom: ["S"] },
      { seriesId: "Y", mergedFrom: ["S"] },
    ];
    expect(resolveMergedSeriesIds(overrides, "R")).toEqual(["R", "X", "Y", "S"]);
  });

  // performMerge refuses a self-merge and only appends, so a cycle should be
  // unreachable. The override table is user-writable state that outlives any
  // one release, though, and a loop here would hang the detail sheet with
  // nothing in the console to explain it.
  test("terminates on a two-node cycle", () => {
    const overrides = [
      { seriesId: "A", mergedFrom: ["B"] },
      { seriesId: "B", mergedFrom: ["A"] },
    ];
    expect(resolveMergedSeriesIds(overrides, "A")).toEqual(["A", "B"]);
  });

  test("terminates on a self-reference", () => {
    const overrides = [{ seriesId: "A", mergedFrom: ["A"] }];
    expect(resolveMergedSeriesIds(overrides, "A")).toEqual(["A"]);
  });

  test("terminates on a long cycle", () => {
    const overrides = [
      { seriesId: "A", mergedFrom: ["B"] },
      { seriesId: "B", mergedFrom: ["C"] },
      { seriesId: "C", mergedFrom: ["A"] },
    ];
    expect(resolveMergedSeriesIds(overrides, "A")).toEqual(["A", "B", "C"]);
  });

  test("ignores rows with no usable shape", () => {
    const overrides = [
      { seriesId: "C", mergedFrom: ["B"] },
      { seriesId: "", mergedFrom: ["Z"] },
      { mergedFrom: ["Z"] },
      { seriesId: "D" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      null as any,
    ];
    expect(resolveMergedSeriesIds(overrides, "C")).toEqual(["C", "B"]);
  });

  test("drops non-string and empty ids inside mergedFrom", () => {
    const overrides = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { seriesId: "C", mergedFrom: ["B", "", null, 7, undefined] as any },
    ];
    expect(resolveMergedSeriesIds(overrides, "C")).toEqual(["C", "B"]);
  });

  test("returns nothing for an empty root id", () => {
    expect(resolveMergedSeriesIds([{ seriesId: "C", mergedFrom: ["B"] }], "")).toEqual([]);
  });

  // Opening the SOURCE of a merge must not drag in the target's other
  // sources: B was merged away, and its card is hidden from the grid, but if
  // it is ever reached directly it shows only what it actually holds.
  test("does not walk upward from a source to its target", () => {
    const overrides = [{ seriesId: "C", mergedFrom: ["A", "B"] }];
    expect(resolveMergedSeriesIds(overrides, "B")).toEqual(["B"]);
  });
});
