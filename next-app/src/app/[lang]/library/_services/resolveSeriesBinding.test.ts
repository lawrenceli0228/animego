import { beforeEach, describe, expect, test } from "bun:test";

import {
  animeCacheHits,
  makeBindingResolver,
  pickBindingHit,
  resolveSeriesBinding,
  resetSeriesBindingCache,
  seriesSearchKeyword,
  type BindableSeriesRow,
  type SeriesSearchFn,
  type SeriesSearchHit,
} from "./resolveSeriesBinding";

// ─── fakes ──────────────────────────────────────────────────────────────────

interface FakeSeries extends BindableSeriesRow {
  anilistId?: number | null;
}

function fakeDb(
  series: FakeSeries[],
  overrides: Record<string, { locked?: boolean }> = {},
) {
  const writes: { id: string; changes: Record<string, unknown> }[] = [];
  const locks = new Map(Object.entries(overrides));
  return {
    writes,
    series: {
      get: async (id: string) => series.find((s) => s.id === id),
      update: async (id: string, changes: Record<string, unknown>) => {
        writes.push({ id, changes });
        const row = series.find((s) => s.id === id);
        if (row) Object.assign(row, changes);
        return 1;
      },
    },
    userOverride: {
      get: async (id: string) => locks.get(id),
      put: async (row: Record<string, unknown>) => {
        locks.set(String(row.seriesId), row as { locked?: boolean });
        return 1;
      },
    },
  };
}

function searcher(hits: SeriesSearchHit[]): SeriesSearchFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (keyword: string) => {
    calls.push(keyword);
    return { results: hits };
  }) as SeriesSearchFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const cacheHit = (anilistId: number, title: string): SeriesSearchHit => ({
  source: "animeCache",
  anilistId,
  titleChinese: title,
  titleRomaji: title,
});

beforeEach(() => {
  resetSeriesBindingCache();
});

// ─── pure pieces ────────────────────────────────────────────────────────────

describe("seriesSearchKeyword", () => {
  test("prefers zh, then en, then ja", () => {
    expect(seriesSearchKeyword({ titleZh: "药屋", titleEn: "Apothecary" })).toBe("药屋");
    expect(seriesSearchKeyword({ titleEn: "Apothecary", titleJa: "薬屋" })).toBe("Apothecary");
    expect(seriesSearchKeyword({ titleJa: "薬屋" })).toBe("薬屋");
  });

  test("returns an empty string when the series has no title at all", () => {
    // A bare import (dandanplay enrichment failed) has none of the three.
    expect(seriesSearchKeyword({})).toBe("");
    expect(seriesSearchKeyword(null)).toBe("");
  });
});

describe("animeCacheHits", () => {
  test("keeps only animeCache rows — they are the ones carrying an anilistId", () => {
    const hits = animeCacheHits({
      results: [
        { source: "dandanplay", anilistId: 1 },
        cacheHit(2, "x"),
      ],
    });
    expect(hits.map((h) => h.anilistId)).toEqual([2]);
  });

  test("tolerates an empty or malformed response", () => {
    expect(animeCacheHits(null)).toEqual([]);
    expect(animeCacheHits({})).toEqual([]);
  });
});

describe("pickBindingHit", () => {
  const hits = [cacheHit(11, "无职转生"), cacheHit(22, "无职转生 第二季")];

  test("an existing binding wins by exact id, ignoring the fuzzy score", () => {
    const best = pickBindingHit(hits, "无职转生", { anilistId: 22, source: "auto" });
    expect(best?.anilistId).toBe(22);
  });

  test("a MANUAL binding the search cannot see resolves to nothing", () => {
    // Taiga's rule (anime_util.cpp:220-241): the user's pick outranks the
    // official titles from then on. Showing a different show than the one they
    // explicitly chose is worse than showing an un-enriched card.
    const best = pickBindingHit(hits, "无职转生", { anilistId: 999, source: "manual" });
    expect(best).toBeNull();
  });

  test("an AUTO binding the search cannot see re-derives from the title", () => {
    const best = pickBindingHit(hits, "无职转生", { anilistId: 999, source: "auto" });
    expect(best?.anilistId).toBe(11);
  });

  test("with no binding it defers to pickBestHit's season agreement", () => {
    expect(pickBindingHit(hits, "无职转生 第二季", null)?.anilistId ?? null).toBe(22);
    expect(pickBindingHit(hits, "无职转生", null)?.anilistId ?? null).toBe(11);
  });

  test("returns null rather than an arbitrary hits[0]", () => {
    expect(pickBindingHit(hits, "完全不相干的番剧", null)).toBeNull();
  });
});

// ─── on-demand resolution ───────────────────────────────────────────────────

describe("resolveSeriesBinding", () => {
  test("an existing binding answers without touching the network", async () => {
    // Arrange
    const db = fakeDb([{ id: "S1", titleZh: "无职转生", anilistId: 154587 }]);
    const search = searcher([cacheHit(11, "无职转生")]);

    // Act
    const result = await resolveSeriesBinding(db, { id: "S1", titleZh: "无职转生" }, { search });

    // Assert
    expect(result).toEqual({ anilistId: 154587, outcome: "existing", hit: null });
    expect(search.calls).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  test("resolves and persists an unbound series", async () => {
    // Arrange
    const db = fakeDb([{ id: "S1", titleZh: "无职转生" }]);
    const search = searcher([cacheHit(11, "无职转生")]);

    // Act
    const result = await resolveSeriesBinding(db, { id: "S1", titleZh: "无职转生" }, { search });

    // Assert — the write is what turns a per-session guess into the durable key.
    expect(result.anilistId).toBe(11);
    expect(result.outcome).toBe("resolved");
    expect(search.calls).toEqual(["无职转生"]);
    expect(db.writes).toEqual([{ id: "S1", changes: { anilistId: 11 } }]);
  });

  test("a manual binding that the search cannot see does NOT fall back to fuzzy", async () => {
    // Arrange — locked override ⇒ readBinding reports source 'manual'.
    const db = fakeDb([{ id: "S1", titleZh: "无职转生", anilistId: 999 }], {
      S1: { locked: true },
    });
    const search = searcher([cacheHit(11, "无职转生")]);

    // Act — `force` is the metadata path, the only one that searches when bound.
    const result = await resolveSeriesBinding(
      db,
      { id: "S1", titleZh: "无职转生" },
      { search, force: true },
    );

    // Assert — the user's id stays in effect and 11 is never written over it.
    expect(result.anilistId).toBe(999);
    expect(result.hit).toBeNull();
    expect(db.writes).toEqual([]);
  });

  test("a failed search does not throw, and does not latch as unresolved", async () => {
    // Arrange — every caller is fire-and-forget; an exception here would be an
    // unhandled rejection over a playing video.
    const db = fakeDb([{ id: "S1", titleZh: "无职转生" }]);
    const boom: SeriesSearchFn = async () => {
      throw new Error("HTTP 502");
    };

    // Act
    const failed = await resolveSeriesBinding(db, { id: "S1", titleZh: "无职转生" }, { search: boom });
    const retry = searcher([cacheHit(11, "无职转生")]);
    const after = await resolveSeriesBinding(db, { id: "S1", titleZh: "无职转生" }, { search: retry });

    // Assert — a dropped request is not an answer about this title.
    expect(failed).toEqual({ anilistId: null, outcome: "none", hit: null });
    expect(after.anilistId).toBe(11);
    expect(retry.calls).toHaveLength(1);
  });

  test("a title that matches nothing is searched once per session, not once per click", async () => {
    // Arrange
    const db = fakeDb([{ id: "S1", titleZh: "完全不相干的番剧" }]);
    const search = searcher([cacheHit(11, "无职转生")]);

    // Act
    await resolveSeriesBinding(db, { id: "S1", titleZh: "完全不相干的番剧" }, { search });
    await resolveSeriesBinding(db, { id: "S1", titleZh: "完全不相干的番剧" }, { search });
    await resolveSeriesBinding(db, { id: "S1", titleZh: "完全不相干的番剧" }, { search });

    // Assert
    expect(search.calls).toHaveLength(1);
  });

  test("a series with no title never searches", async () => {
    const db = fakeDb([{ id: "S1" }]);
    const search = searcher([cacheHit(11, "x")]);

    const result = await resolveSeriesBinding(db, { id: "S1" }, { search });

    expect(result.outcome).toBe("none");
    expect(search.calls).toEqual([]);
  });

  test("an unreadable database resolves to nothing instead of guessing", async () => {
    const broken = {
      series: {
        get: async () => {
          throw new Error("InvalidStateError");
        },
        update: async () => 1,
      },
      userOverride: null,
    };
    const search = searcher([cacheHit(11, "x")]);

    const result = await resolveSeriesBinding(broken, { id: "S1", titleZh: "x" }, { search });

    expect(result).toEqual({ anilistId: null, outcome: "none", hit: null });
    expect(search.calls).toEqual([]);
  });
});

describe("makeBindingResolver", () => {
  test("adapts to watchSync's seam: series id in, AniList id out", async () => {
    const db = fakeDb([{ id: "S1", titleZh: "无职转生" }]);
    const resolve = makeBindingResolver(db, { search: searcher([cacheHit(11, "无职转生")]) });

    expect(await resolve("S1")).toBe(11);
  });

  test("returns null for a series that is not in the database", async () => {
    const db = fakeDb([]);
    const resolve = makeBindingResolver(db, { search: searcher([]) });

    expect(await resolve("ghost")).toBeNull();
  });
});
