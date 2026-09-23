import { describe, expect, test } from "bun:test";

import { findMergeCycleCuts, wouldCreateMergeCycle } from "./mergeCycles";
import { resolveMergedSeriesIds } from "./resolveMergedIds";

// A merge cycle hides EVERY card on it. useLibrary hides any id that appears
// in any `mergedFrom`, so once A says `mergedFrom: [B]` and B says
// `mergedFrom: [A]` there is no root left to draw — both cards, and every
// episode under them, vanish from the grid at once. That is what a reader sees
// as "merging made everything disappear".

describe("wouldCreateMergeCycle", () => {
  test("★ merging a card into one of its own members closes a cycle", () => {
    // The shape the duplicate sweep produced: the reader merged the older
    // row A into the newer row B, then the sweep (which always targets the
    // oldest) tried to merge B back into A.
    const overrides = [{ seriesId: "B", mergedFrom: ["A"] }];
    expect(wouldCreateMergeCycle(overrides, "B", "A")).toBe(true);
  });

  test("a member reached through a chain counts too", () => {
    const overrides = [
      { seriesId: "C", mergedFrom: ["B"] },
      { seriesId: "B", mergedFrom: ["A"] },
    ];
    expect(wouldCreateMergeCycle(overrides, "C", "A")).toBe(true);
  });

  test("merging into an unrelated card is fine", () => {
    const overrides = [{ seriesId: "B", mergedFrom: ["A"] }];
    expect(wouldCreateMergeCycle(overrides, "C", "A")).toBe(false);
    expect(wouldCreateMergeCycle(overrides, "A", "C")).toBe(false);
  });

  test("the direction that already exists is not a cycle, just a repeat", () => {
    // performMerge answers this one itself ("already merged").
    const overrides = [{ seriesId: "B", mergedFrom: ["A"] }];
    expect(wouldCreateMergeCycle(overrides, "A", "B")).toBe(false);
  });

  test("a self-merge is a cycle of one", () => {
    expect(wouldCreateMergeCycle([], "A", "A")).toBe(true);
  });
});

describe("findMergeCycleCuts", () => {
  test("an acyclic table needs no cuts", () => {
    expect(
      findMergeCycleCuts([
        { seriesId: "C", mergedFrom: ["B"], updatedAt: 1 },
        { seriesId: "B", mergedFrom: ["A"], updatedAt: 2 },
      ]),
    ).toEqual([]);
    expect(findMergeCycleCuts([])).toEqual([]);
    expect(findMergeCycleCuts(null)).toEqual([]);
  });

  test("★ a two-card cycle loses the edge written LAST", () => {
    // B.mergedFrom=[A] is the reader's merge; A.mergedFrom=[B] is the sweep
    // reversing it later. Cutting the later write restores what the reader
    // chose: B is the card, A is inside it.
    const cuts = findMergeCycleCuts([
      { seriesId: "B", mergedFrom: ["A"], updatedAt: 100 },
      { seriesId: "A", mergedFrom: ["B"], updatedAt: 200 },
    ]);
    expect(cuts).toEqual([{ targetSeriesId: "A", sourceSeriesId: "B" }]);
  });

  test("only edges ON the cycle are cut", () => {
    // C holds A (the reader's merge). The sweep then put B and C into A.
    // A→B is a legitimate duplicate merge and must survive; only A→C closes
    // the loop.
    const cuts = findMergeCycleCuts([
      { seriesId: "C", mergedFrom: ["A"], updatedAt: 100 },
      { seriesId: "A", mergedFrom: ["B", "C"], updatedAt: 200 },
    ]);
    expect(cuts).toEqual([{ targetSeriesId: "A", sourceSeriesId: "C" }]);
  });

  test("on a tie, the later entry in mergedFrom goes (it is append-only)", () => {
    const cuts = findMergeCycleCuts([
      { seriesId: "A", mergedFrom: ["B", "C"], updatedAt: 100 },
      { seriesId: "B", mergedFrom: ["A"], updatedAt: 50 },
      { seriesId: "C", mergedFrom: ["A"], updatedAt: 50 },
    ]);
    // Both A→B and A→C sit on a cycle and share A's timestamp. Cutting A→C
    // first still leaves A↔B, so A→B goes on the next round.
    expect(cuts).toEqual([
      { targetSeriesId: "A", sourceSeriesId: "C" },
      { targetSeriesId: "A", sourceSeriesId: "B" },
    ]);
  });

  test("every independent cycle is broken", () => {
    const cuts = findMergeCycleCuts([
      { seriesId: "A", mergedFrom: ["B"], updatedAt: 2 },
      { seriesId: "B", mergedFrom: ["A"], updatedAt: 1 },
      { seriesId: "X", mergedFrom: ["Y"], updatedAt: 3 },
      { seriesId: "Y", mergedFrom: ["X"], updatedAt: 4 },
    ]);
    expect(cuts).toHaveLength(2);
    expect(cuts).toContainEqual({ targetSeriesId: "A", sourceSeriesId: "B" });
    expect(cuts).toContainEqual({ targetSeriesId: "Y", sourceSeriesId: "X" });
  });

  test("a self-edge is cut", () => {
    expect(
      findMergeCycleCuts([{ seriesId: "A", mergedFrom: ["A"], updatedAt: 1 }]),
    ).toEqual([{ targetSeriesId: "A", sourceSeriesId: "A" }]);
  });

  test("★ after the cuts, every series is either a root or reachable from one", () => {
    // The property the grid actually needs. Whatever the cycle looked like,
    // nothing may be left hidden with no visible card to hold it.
    const overrides = [
      { seriesId: "A", mergedFrom: ["B"], updatedAt: 5 },
      { seriesId: "B", mergedFrom: ["C"], updatedAt: 3 },
      { seriesId: "C", mergedFrom: ["A", "D"], updatedAt: 4 },
    ];
    const cuts = findMergeCycleCuts(overrides);
    const repaired = overrides.map((o) => ({
      ...o,
      mergedFrom: o.mergedFrom.filter(
        (id) =>
          !cuts.some((c) => c.targetSeriesId === o.seriesId && c.sourceSeriesId === id),
      ),
    }));
    const hidden = new Set(repaired.flatMap((o) => o.mergedFrom));
    const roots = ["A", "B", "C", "D"].filter((id) => !hidden.has(id));
    const onSomeCard = new Set(
      roots.flatMap((root) => resolveMergedSeriesIds(repaired, root)),
    );
    expect(roots.length).toBeGreaterThan(0);
    expect([...onSomeCard].sort()).toEqual(["A", "B", "C", "D"]);
    expect(findMergeCycleCuts(repaired)).toEqual([]);
  });
});
