import { describe, expect, test } from "bun:test";
import { resolveEpisodeSkeleton } from "./episodeGridSkeleton";

// The grid only ever reads `episode` off a title row, so the fixtures carry
// only that. `nameCn` / `name` are the cell's caption, not its existence.
const titles = (...episodes: number[]) => episodes.map((episode) => ({ episode }));

describe("resolveEpisodeSkeleton — a catalogue count wins outright", () => {
  test("a count with titles draws exactly the count", () => {
    // Regression guard. This is the path every title with a confirmed total
    // takes, which is most of the catalogue, and it must render what it
    // rendered before this function existed: `total = episodes`, full stop.
    expect(resolveEpisodeSkeleton(12, null, titles(1, 2, 3))).toEqual({
      kind: "authoritative",
      total: 12,
    });
  });

  test("a count with no titles still draws the count", () => {
    // episodeTitles is sparse by design and empty for a large part of the
    // catalogue. An untitled grid of numbered cells is the long-standing
    // behaviour here and is not this change's business.
    expect(resolveEpisodeSkeleton(24, null, [])).toEqual({
      kind: "authoritative",
      total: 24,
    });
  });

  test("the count is never lowered to match the titles it has", () => {
    // The other direction of the same rule: 26 rows of titles against a
    // catalogue count of 13 must not resize the grid. The count is the
    // authority; the titles are decoration hanging off it.
    const many = titles(...Array.from({ length: 26 }, (_, i) => i + 1));
    expect(resolveEpisodeSkeleton(13, null, many)).toEqual({
      kind: "authoritative",
      total: 13,
    });
  });
});

describe("resolveEpisodeSkeleton — no count, titles to infer from", () => {
  test("infers the highest episode number, not the row count", () => {
    // The distinction the whole function exists for. `length` would answer
    // 3 here and silently drop episodes 4 through 9.
    expect(resolveEpisodeSkeleton(null, null, titles(1, 5, 9))).toEqual({
      kind: "inferred",
      total: 9,
    });
  });

  test("a hole in the middle does not truncate the tail", () => {
    // A partial enrichment pass is the ordinary case, not the exotic one.
    // Three rows numbered 1, 2, 5 must still draw five cells — sizing by
    // `length` would end the grid two episodes early.
    expect(resolveEpisodeSkeleton(null, null, titles(1, 2, 5))).toEqual({
      kind: "inferred",
      total: 5,
    });
  });

  test("a duplicated number inflates nothing", () => {
    // `length` is 4 here and the answer is 3. The database has a primary key
    // on (anime_id, episode) so duplicates cannot reach us from there, but
    // this array is parsed JSON off the wire and the guarantee is not ours
    // to assume.
    expect(resolveEpisodeSkeleton(null, null, titles(1, 2, 2, 3))).toEqual({
      kind: "inferred",
      total: 3,
    });
  });

  test("unordered rows do not depend on arriving sorted", () => {
    expect(resolveEpisodeSkeleton(null, null, titles(7, 2, 4))).toEqual({
      kind: "inferred",
      total: 7,
    });
  });

  test("a fractional special sits inside the episode before it", () => {
    // Cells are whole numbers. 5.5 must not round up into a sixth cell that
    // stands for nothing.
    expect(resolveEpisodeSkeleton(null, null, titles(1, 2, 5.5))).toEqual({
      kind: "inferred",
      total: 5,
    });
  });

  test("malformed rows cost their own cell, never the section", () => {
    // One bad row used to be able to take the whole grid down with it. It
    // is skipped instead, and the rows around it still size the skeleton.
    const rows = [
      { episode: 3 },
      { episode: Number.NaN },
      { episode: Number.POSITIVE_INFINITY },
      null,
      undefined,
      { episode: "4" },
    ] as unknown as Array<{ episode: number }>;
    expect(resolveEpisodeSkeleton(null, null, rows)).toEqual({
      kind: "inferred",
      total: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// The inferred count from the backend (AnimeDetail.episodesBgm, migration
// 0023). AniList leaves `episodes` NULL for most of what is currently airing;
// a sweep fills that gap from an external episode source into a SECOND column,
// and the detail page now hands both down.
//
// The rule these pin: an inferred count may size the grid, and it may never
// be labelled `authoritative`. The discriminant is the only thing a call site
// has left to tell the two apart once the numbers look identical — the badge
// prints on it, and animeJsonLd.ts refuses on it.
// ---------------------------------------------------------------------------

describe("resolveEpisodeSkeleton — an inferred count from the backend", () => {
  test("a row with no catalogue count draws the inferred one", () => {
    // The case the whole episodes_bgm column exists for: currently airing,
    // AniList has no total, no episode titles enriched yet. Before this
    // input existed the reader got "count not known yet" and no grid.
    expect(resolveEpisodeSkeleton(null, 24, [])).toEqual({
      kind: "inferred",
      total: 24,
    });
  });

  test("the inferred count is never promoted to authoritative", () => {
    // The load-bearing assertion of this block. `authoritative` is what the
    // badge prints verbatim and what the reader reads as a fact; routing an
    // inference through it would be the SQL-level merge the schema refuses,
    // relocated into this union.
    expect(resolveEpisodeSkeleton(null, 24, []).kind).toBe("inferred");
    expect(resolveEpisodeSkeleton(null, 24, titles(1, 2)).kind).toBe("inferred");
  });

  test("a catalogue count outranks a disagreeing inferred one", () => {
    // Both sources have an answer and they differ — AniList wins, and the
    // result is authoritative. Reconciling them is not this function's job.
    expect(resolveEpisodeSkeleton(12, 13, [])).toEqual({
      kind: "authoritative",
      total: 12,
    });
  });

  test("a stale inferred total cannot cut off a title we already hold", () => {
    // `episodes_bgm` is a snapshot and can lag mid-season. Sizing to 12 with
    // 26 titles in the payload would hide episodes 13-26 — the exact defect
    // highestEpisode was written to prevent, arriving from a new direction.
    const many = titles(...Array.from({ length: 26 }, (_, i) => i + 1));
    expect(resolveEpisodeSkeleton(null, 12, many)).toEqual({
      kind: "inferred",
      total: 26,
    });
  });

  test("the inferred total carries a season the titles have not reached", () => {
    // The other direction, and the ordinary one mid-season: 24 episodes are
    // known to exist, we hold names for five of them.
    expect(resolveEpisodeSkeleton(null, 24, titles(1, 2, 3, 4, 5))).toEqual({
      kind: "inferred",
      total: 24,
    });
  });

  test("an unusable inferred count falls through to the titles", () => {
    // Zero, negative and non-numeric all mean "no answer", not "zero
    // episodes". They must not shrink or erase a grid the titles can size.
    expect(resolveEpisodeSkeleton(null, 0, titles(1, 2, 5))).toEqual({
      kind: "inferred",
      total: 5,
    });
    expect(resolveEpisodeSkeleton(null, -3, titles(1, 2, 5))).toEqual({
      kind: "inferred",
      total: 5,
    });
    expect(
      resolveEpisodeSkeleton(null, Number.NaN as number, titles(1, 2, 5)),
    ).toEqual({ kind: "inferred", total: 5 });
    expect(
      resolveEpisodeSkeleton(null, "7" as unknown as number, titles(1, 2, 5)),
    ).toEqual({ kind: "inferred", total: 5 });
  });

  test("an unusable inferred count with no titles is still pending", () => {
    expect(resolveEpisodeSkeleton(null, 0, [])).toEqual({ kind: "pending" });
    expect(resolveEpisodeSkeleton(null, -1, [])).toEqual({ kind: "pending" });
    expect(
      resolveEpisodeSkeleton(null, Number.POSITIVE_INFINITY, []),
    ).toEqual({ kind: "pending" });
  });

  test("a fractional inferred count draws whole cells", () => {
    expect(resolveEpisodeSkeleton(null, 12.7, [])).toEqual({
      kind: "inferred",
      total: 12,
    });
  });
});

describe("resolveEpisodeSkeleton — nothing to draw", () => {
  test("no count and no titles is pending, and carries no total", () => {
    // The state that used to be `return null`. The caller renders "count not
    // known yet"; the absence of `total` is what stops it drawing a grid.
    expect(resolveEpisodeSkeleton(null, null, [])).toEqual({ kind: "pending" });
  });

  test("a zero count is treated exactly like a missing one", () => {
    // `episodes: 0` and `episodes: null` say the same thing about a show
    // that has aired at least one episode, and the guard this replaces
    // already collapsed them (`!episodes || episodes <= 0`).
    expect(resolveEpisodeSkeleton(0, null, [])).toEqual({ kind: "pending" });
    expect(resolveEpisodeSkeleton(0, null, titles(1, 2, 5))).toEqual({
      kind: "inferred",
      total: 5,
    });
  });

  test("a negative count cannot size a grid either", () => {
    expect(resolveEpisodeSkeleton(-3, null, [])).toEqual({ kind: "pending" });
  });

  test("titles that are all unusable fall through to pending", () => {
    // Not `inferred` with a total of 0 — a grid of zero cells is the empty
    // section this change exists to delete.
    const rows = [{ episode: 0 }, { episode: -1 }] as Array<{ episode: number }>;
    expect(resolveEpisodeSkeleton(null, null, rows)).toEqual({ kind: "pending" });
  });

  test("an absent titles array is not a crash", () => {
    // page.tsx passes `detail.episodeTitles ?? []`, but this module is the
    // one deciding whether a section renders at all and should not depend on
    // its caller having remembered that.
    expect(
      resolveEpisodeSkeleton(
        null,
        null,
        undefined as unknown as Array<{ episode: number }>,
      ),
    ).toEqual({ kind: "pending" });
  });
});

describe("resolveEpisodeSkeleton — the section never disappears", () => {
  test("no input combination returns null or an empty answer", () => {
    // The defect in one assertion: whatever the catalogue holds, the caller
    // always gets something it can render.
    const inputs: Array<[number | null, number | null, Array<{ episode: number }>]> = [
      [12, null, titles(1)],
      [12, 13, []],
      [12, null, []],
      [0, null, []],
      [null, null, []],
      [null, 24, []],
      [null, 0, []],
      [null, null, titles(4)],
      [null, 24, titles(4)],
      [-1, null, titles(4)],
      [-1, -1, []],
    ];
    for (const [episodes, episodesBgm, rows] of inputs) {
      const skeleton = resolveEpisodeSkeleton(episodes, episodesBgm, rows);
      expect(["authoritative", "inferred", "pending"]).toContain(skeleton.kind);
    }
  });

  test("only an authoritative answer may be printed as a total", () => {
    // The badge on the detail page prints `total` verbatim. An inferred
    // count published as "5 episodes" would be the site inventing a fact
    // about a show on a page Google indexes — and that holds whether the
    // inference came from the titles floor or from the backend column.
    expect(resolveEpisodeSkeleton(null, null, titles(5)).kind).not.toBe("authoritative");
    expect(resolveEpisodeSkeleton(null, 5, []).kind).not.toBe("authoritative");
    expect(resolveEpisodeSkeleton(null, 5, titles(5)).kind).not.toBe("authoritative");
    expect(resolveEpisodeSkeleton(5, null, titles(5)).kind).toBe("authoritative");
  });
});
