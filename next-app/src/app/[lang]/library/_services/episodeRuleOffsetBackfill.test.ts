import { beforeEach, describe, expect, test } from "bun:test";
import {
  backfillEpisodeRuleOffsets,
  collectRuleOffsetBackfillIds,
  resetEpisodeRuleOffsetBackfillCache,
  type RuleOffsetItem,
} from "./episodeRuleOffsetBackfill";

// `Series.episodeRuleOffsets` is new: every series already in a library has
// none, including every series that already has its `episodeOffset`. So this
// sweep asks by the new field alone, and stores `[]` for "the curated file has
// no rule" so a series is asked once.

function fakeDb() {
  const writes: { id: string; changes: Record<string, unknown> }[] = [];
  return {
    writes,
    db: {
      series: {
        update: async (id: string, changes: Record<string, unknown>) => {
          writes.push({ id, changes });
          return 1;
        },
      },
    },
  };
}

beforeEach(() => resetEpisodeRuleOffsetBackfillCache());

describe("collectRuleOffsetBackfillIds", () => {
  test("asks for bound series without the field, once per AniList id", () => {
    const ids = collectRuleOffsetBackfillIds([
      { id: "a", anilistId: 179062, episodeOffset: 60 },
      { id: "b", anilistId: 179062 },
      { id: "c", anilistId: 5, episodeRuleOffsets: [] },
      { id: "d", anilistId: 6, episodeRuleOffsets: [12] },
      { id: "e" },
    ]);
    expect(ids).toEqual([179062]);
  });
});

describe("backfillEpisodeRuleOffsets", () => {
  test("★ writes the shifts, and [] for an id the answer has no rule for", async () => {
    const { db, writes } = fakeDb();
    const asked: number[][] = [];
    const summary = await backfillEpisodeRuleOffsets({
      db,
      series: [
        { id: "enen", anilistId: 179062, episodeOffset: 60 },
        { id: "plain", anilistId: 8 },
        { id: "absent", anilistId: 9 },
      ],
      fetchOffsets: async (ids) => {
        asked.push([...ids]);
        const items: RuleOffsetItem[] = [
          { anilistId: 179062, known: true, offset: 60, ruleOffsets: [12] },
          { anilistId: 8, known: true, offset: 0 },
        ];
        return items;
      },
    });
    expect(asked).toEqual([[179062, 8, 9]]);
    expect(writes).toEqual([
      { id: "enen", changes: { episodeRuleOffsets: [12] } },
      { id: "plain", changes: { episodeRuleOffsets: [] } },
      { id: "absent", changes: { episodeRuleOffsets: [] } },
    ]);
    expect(summary).toEqual({ asked: 3, written: 3, failedChunks: 0 });
  });

  test("every series bound to an id gets the answer", async () => {
    const { db, writes } = fakeDb();
    await backfillEpisodeRuleOffsets({
      db,
      series: [
        { id: "x", anilistId: 179062 },
        { id: "y", anilistId: 179062 },
      ],
      fetchOffsets: async () => [{ anilistId: 179062, ruleOffsets: [12] }],
    });
    expect(writes.map((w) => w.id)).toEqual(["x", "y"]);
  });

  test("a failed request writes nothing and stays eligible", async () => {
    const { db, writes } = fakeDb();
    const summary = await backfillEpisodeRuleOffsets({
      db,
      series: [{ id: "x", anilistId: 1 }],
      fetchOffsets: async () => {
        throw new Error("HTTP 502");
      },
    });
    expect(writes).toEqual([]);
    expect(summary.failedChunks).toBe(1);
    expect(collectRuleOffsetBackfillIds([{ id: "x", anilistId: 1 }])).toEqual([1]);
  });

  test("nothing to ask, nothing fetched", async () => {
    const { db } = fakeDb();
    let called = false;
    await backfillEpisodeRuleOffsets({
      db,
      series: [{ id: "x", anilistId: 1, episodeRuleOffsets: [] }],
      fetchOffsets: async () => {
        called = true;
        return [];
      },
    });
    expect(called).toBe(false);
  });
});
