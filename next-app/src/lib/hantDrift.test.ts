import { describe, expect, test } from "bun:test";
import {
  HANT_POLL_MS,
  hasDrift,
  isBackfillDisabled,
  machineConvertedTitles,
  pickHantInterval,
  totalBehind,
} from "./hantDrift";

// The wire numbers this file keeps quoting come from the contract sheet:
//   total 17518 · titleHant 12350 · descHant 15917 · serpEligible 6422
//   titleBehind 0 · descBehind 2
// Using the real shape matters for the zero cases in particular — the
// interesting inputs here are 0 and "0 on one column, non-zero on the other",
// which is exactly what production looks like most days.

describe("totalBehind", () => {
  test("sums the two columns", () => {
    expect(totalBehind({ titleBehind: 3, descBehind: 2 })).toBe(5);
  });

  test("an all-clear is 0, not a falsy accident", () => {
    expect(totalBehind({ titleBehind: 0, descBehind: 0 })).toBe(0);
  });

  test("one column behind still counts", () => {
    // The production shape: titles are current, two synopses are not.
    expect(totalBehind({ titleBehind: 0, descBehind: 2 })).toBe(2);
    expect(totalBehind({ titleBehind: 2, descBehind: 0 })).toBe(2);
  });

  test("a missing field reads as 0 instead of NaN", () => {
    // An older go-api, or a rolling deploy: the field is absent, arrives as
    // undefined, and turns the whole verdict into NaN the moment it is added.
    // NaN > 0 is false, so the block would quietly render the all-clear.
    const partial = { titleBehind: 4 } as { titleBehind: number; descBehind: number };
    expect(totalBehind(partial)).toBe(4);
    expect(Number.isNaN(totalBehind(partial))).toBe(false);
  });

  test("a negative count cannot subtract from the other column", () => {
    expect(totalBehind({ titleBehind: -9, descBehind: 2 })).toBe(2);
  });
});

describe("hasDrift", () => {
  test("false only when both columns are level", () => {
    expect(hasDrift({ titleBehind: 0, descBehind: 0 })).toBe(false);
  });

  test("true when either column is behind", () => {
    expect(hasDrift({ titleBehind: 0, descBehind: 2 })).toBe(true);
    expect(hasDrift({ titleBehind: 2, descBehind: 0 })).toBe(true);
    expect(hasDrift({ titleBehind: 1, descBehind: 1 })).toBe(true);
  });

  test("garbage in one column does not silence the other", () => {
    const partial = { descBehind: 2 } as { titleBehind: number; descBehind: number };
    expect(hasDrift(partial)).toBe(true);
  });
});

describe("machineConvertedTitles", () => {
  test("is the gap between Traditional titles and the SERP-eligible ones", () => {
    // 12350 - 6422. Rendered so 6422 does not read as "5928 rows failed".
    expect(machineConvertedTitles(12350, 6422)).toBe(5928);
  });

  test("is 0 when every Traditional title came from a human", () => {
    expect(machineConvertedTitles(6422, 6422)).toBe(0);
  });

  test("clamps at 0 rather than rendering a negative count", () => {
    // serpEligible is a generated subset of titleHant, so this can only
    // happen when the two counts were taken at different moments.
    expect(machineConvertedTitles(100, 140)).toBe(0);
  });

  test("degrades to 0 for non-finite input instead of printing NaN", () => {
    expect(machineConvertedTitles(Number.NaN, 6422)).toBe(0);
    expect(machineConvertedTitles(12350, Number.NaN)).toBe(12350);
  });
});

describe("pickHantInterval", () => {
  test("a running backfill polls at 5s", () => {
    expect(pickHantInterval(true)).toBe(HANT_POLL_MS);
    expect(pickHantInterval(true)).toBe(5_000);
  });

  test("an idle block stops polling entirely", () => {
    // The automatic floor is quarterly. Polling an idle block would be a
    // request every five seconds for a number that moves four times a year.
    expect(pickHantInterval(false)).toBe(0);
  });
});

describe("isBackfillDisabled", () => {
  test("disabled while go-api reports a run in flight", () => {
    expect(isBackfillDisabled(true, false)).toBe(true);
  });

  test("disabled while this browser's POST has not come back", () => {
    // `running` cannot cover this window: it is only as fresh as the last
    // poll, so between the click and the refetch the button would stay live
    // and a second click would enqueue a duplicate run.
    expect(isBackfillDisabled(false, true)).toBe(true);
  });

  test("enabled when nothing is in flight", () => {
    expect(isBackfillDisabled(false, false)).toBe(false);
  });

  test("still enabled when nothing is behind", () => {
    // Deliberate: a zero is a claim an operator may want to verify, and
    // running sooner than the quarterly floor is the button's whole job.
    // Nothing about drift being 0 reaches this function at all.
    expect(isBackfillDisabled(false, false)).toBe(false);
  });
});
