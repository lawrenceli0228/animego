import { describe, expect, test } from "bun:test";
import {
  resolveHighWater,
  type HighWaterEpisode,
  type HighWaterProgress,
} from "./watchHighWater";

// Episode ids are ULIDs in production; short readable stand-ins keep the
// fixtures legible without changing anything the function looks at.
function episode(
  id: string,
  number: number,
  kind: HighWaterEpisode["kind"] = "main",
): HighWaterEpisode {
  return { id, number, kind };
}

function done(episodeId: string): HighWaterProgress {
  return { episodeId, completed: true };
}

function partial(episodeId: string): HighWaterProgress {
  return { episodeId, completed: false };
}

describe("resolveHighWater", () => {
  test("returns null when there is no progress at all", () => {
    // Arrange
    const episodes = [episode("e1", 1), episode("e2", 2)];

    // Act
    const highWater = resolveHighWater([], episodes);

    // Assert: null rather than 0, so the caller can tell "subscribed but never
    // watched" apart from a real episode 0.
    expect(highWater).toBeNull();
  });

  test("returns null when only specials, OVAs and creditless openings are finished", () => {
    // Arrange: this is decision 10's whole reason for existing — the parser
    // reads `[NCOP01]` as number 1, so an unfiltered max would claim the user
    // finished episode 1 of a series they never started.
    const episodes = [
      episode("sp1", 1, "sp"),
      episode("ova1", 2, "ova"),
      episode("ncop1", 1, "ncop"),
      episode("e1", 1, "main"),
    ];
    const progress = [done("sp1"), done("ova1"), done("ncop1")];

    // Act
    const highWater = resolveHighWater(progress, episodes);

    // Assert
    expect(highWater).toBeNull();
  });

  test("ignores finished non-main episodes even when they outnumber the main run", () => {
    // Arrange: main watched through 5, plus a creditless OP (parsed as 1) and a
    // special that parses as 12. The SP is the dangerous one — an unfiltered
    // max would push current_episode to 12 for a series with 5 watched, and the
    // server-side GREATEST guard makes that permanent.
    const episodes = [
      episode("e1", 1),
      episode("e2", 2),
      episode("e3", 3),
      episode("e4", 4),
      episode("e5", 5),
      episode("ncop1", 1, "ncop"),
      episode("sp12", 12, "sp"),
    ];
    const progress = [
      done("e1"),
      done("e2"),
      done("e3"),
      done("e4"),
      done("e5"),
      done("ncop1"),
      done("sp12"),
    ];

    // Act
    const highWater = resolveHighWater(progress, episodes);

    // Assert
    expect(highWater).toBe(5);
  });

  test("takes the maximum regardless of input order", () => {
    // Arrange: Dexie returns rows in index order, which is not episode order.
    const episodes = [episode("e3", 3), episode("e1", 1), episode("e12", 12), episode("e7", 7)];
    const progress = [done("e7"), done("e12"), done("e1"), done("e3")];

    // Act
    const highWater = resolveHighWater(progress, episodes);

    // Assert
    expect(highWater).toBe(12);
  });

  test("takes the maximum even with gaps, not the length of the finished set", () => {
    // Arrange: 4 finished episodes, but the highest is 9. Aniyomi's
    // "consecutive run from 1" rule is for binding time, not for us.
    const episodes = [episode("e1", 1), episode("e2", 2), episode("e5", 5), episode("e9", 9)];
    const progress = [done("e1"), done("e2"), done("e5"), done("e9")];

    // Act
    const highWater = resolveHighWater(progress, episodes);

    // Assert
    expect(highWater).toBe(9);
  });

  test("ignores main episodes that are started but not completed", () => {
    // Arrange: 1 and 2 finished, 3 half-watched.
    const episodes = [episode("e1", 1), episode("e2", 2), episode("e3", 3)];
    const progress = [done("e1"), done("e2"), partial("e3")];

    // Act
    const highWater = resolveHighWater(progress, episodes);

    // Assert
    expect(highWater).toBe(2);
  });

  test("returns null when every main episode is merely in progress", () => {
    const episodes = [episode("e1", 1), episode("e2", 2)];

    const highWater = resolveHighWater([partial("e1"), partial("e2")], episodes);

    expect(highWater).toBeNull();
  });

  test("treats a missing completed flag as not completed", () => {
    // Arrange: rows written before the flag existed have it undefined.
    const episodes = [episode("e1", 1), episode("e2", 2)];
    const progress: HighWaterProgress[] = [{ episodeId: "e1" }, done("e2")];

    const highWater = resolveHighWater(progress, episodes);

    expect(highWater).toBe(2);
  });

  test("skips progress rows whose episode no longer exists instead of throwing", () => {
    // Arrange: a rescan/split can delete an episode and orphan its progress row.
    const episodes = [episode("e1", 1), episode("e2", 2)];
    const progress = [done("e1"), done("ghost-episode"), done("e2")];

    // Act
    const highWater = resolveHighWater(progress, episodes);

    // Assert
    expect(highWater).toBe(2);
  });

  test("returns null when every progress row is orphaned", () => {
    const highWater = resolveHighWater([done("ghost-a"), done("ghost-b")], []);

    expect(highWater).toBeNull();
  });

  test("accepts a prebuilt id-to-episode Map so the caller can index once", () => {
    // Arrange: the reconciler reads every episode once and reuses one index
    // across all series.
    const byId = new Map<string, HighWaterEpisode>([
      ["e1", episode("e1", 1)],
      ["e4", episode("e4", 4)],
      ["ncop1", episode("ncop1", 1, "ncop")],
    ]);
    const progress = [done("e1"), done("e4"), done("ncop1")];

    // Act
    const highWater = resolveHighWater(progress, byId);

    // Assert
    expect(highWater).toBe(4);
  });

  test("does not bound the result by any client-side episode count (server owns that)", () => {
    // Design doc §6.1 (T4): the upper bound lives on the server, which has the
    // authoritative anime_cache.episodes and answers 400. The client's
    // Series.totalEpisodes is optional and often wrong, so a client-side bound
    // would silently drop legitimate pushes. The stray `> totalEpisodes → 不推`
    // line in the §8.1 diagram is a first-draft leftover.
    const episodes = [episode("e1", 1), episode("e99", 99)];

    const highWater = resolveHighWater([done("e1"), done("e99")], episodes);

    expect(highWater).toBe(99);
  });

  test("skips episodes whose parsed number is not finite", () => {
    // Arrange: a NaN would poison Math.max-style comparisons and reach the
    // PATCH body as `null`; an Infinity would win the high-water race forever.
    const episodes = [
      episode("e2", 2),
      episode("bad", Number.NaN),
      episode("worse", Number.POSITIVE_INFINITY),
    ];
    const progress = [done("e2"), done("bad"), done("worse")];

    // Act
    const highWater = resolveHighWater(progress, episodes);

    // Assert
    expect(highWater).toBe(2);
  });
});
