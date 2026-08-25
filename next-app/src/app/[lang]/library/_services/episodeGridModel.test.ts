import { describe, expect, test } from "bun:test";

import {
  buildEpisodeNavNumbers,
  buildGridCells,
  normalizeEpisodeNumbers,
  type GridEpisodeRow,
} from "./episodeGridModel";

// ─── fixtures ───────────────────────────────────────────────────────────────

/**
 * Ids are deliberately NOT derived from the number. Keying anything in this
 * module by number is the bug the id-keyed map exists to prevent, and a
 * fixture like `ep-13` would hide it by making the two spaces isomorphic.
 */
function ep(
  id: string,
  number: number | null,
  kind: string = "main",
  seriesId = "A",
): GridEpisodeRow {
  return { id, number, kind, seriesId };
}

/** `[from..to]` of one kind, ids prefixed so two runs never share one. */
function run(
  prefix: string,
  from: number,
  to: number,
  kind = "main",
  seriesId = "A",
): GridEpisodeRow[] {
  const out: GridEpisodeRow[] = [];
  for (let n = from; n <= to; n += 1) out.push(ep(`${prefix}${n}`, n, kind, seriesId));
  return out;
}

const displayOf = (rows: GridEpisodeRow[], total: number | undefined, id: string) =>
  normalizeEpisodeNumbers(rows, total).get(id);

// ─── normalizeEpisodeNumbers ────────────────────────────────────────────────

describe("normalizeEpisodeNumbers — the sequel that starts at 13", () => {
  test("shifts a 13-24 run onto a 12-episode season", () => {
    const rows = run("s2-", 13, 24);
    const map = normalizeEpisodeNumbers(rows, 12);
    expect(map.get("s2-13")).toBe(1);
    expect(map.get("s2-18")).toBe(6);
    expect(map.get("s2-24")).toBe(12);
  });

  test("shifts a partial sequel run too", () => {
    // 13,14,15 of a 12-episode season: still an offset, just not a full one.
    const map = normalizeEpisodeNumbers(run("s2-", 13, 15), 12);
    expect([...map.values()].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});

describe("normalizeEpisodeNumbers — every reason it declines", () => {
  // THE trap. `n - m + 1 <= N && m > 1` — the condition an earlier draft used
  // — is satisfied here (18-13+1 = 6 <= 24, and 13 > 1) and would renumber six
  // episodes the user can currently find by their real number. `m > N` is
  // false (13 < 24), so nothing moves.
  test("a 24-episode show holding only 13-18 is left alone", () => {
    const rows = run("mid-", 13, 18);
    const map = normalizeEpisodeNumbers(rows, 24);
    expect(map.get("mid-13")).toBe(13);
    expect(map.get("mid-18")).toBe(18);
  });

  test("a season that starts at 1 is left alone", () => {
    const rows = run("s1-", 1, 12);
    const map = normalizeEpisodeNumbers(rows, 12);
    expect(map.get("s1-1")).toBe(1);
    expect(map.get("s1-12")).toBe(12);
  });

  test("a hole in the run is left alone", () => {
    // 13,14,17 against a 12-episode season passes `m > N` but is a partial
    // download, not a continuously numbered season. Shifting would produce
    // 1,2,5 — a grid claiming the user is missing episodes 3 and 4 of a
    // season they do not have.
    const rows = [ep("h-13", 13), ep("h-14", 14), ep("h-17", 17)];
    const map = normalizeEpisodeNumbers(rows, 12);
    expect(map.get("h-13")).toBe(13);
    expect(map.get("h-17")).toBe(17);
  });

  test("an unknown total is left alone", () => {
    const rows = run("u-", 13, 24);
    for (const total of [undefined, null, 0, -3, Number.NaN]) {
      const map = normalizeEpisodeNumbers(rows, total);
      expect(map.get("u-13")).toBe(13);
    }
  });

  test("a run longer than the season it claims is left alone", () => {
    // 13-36 against a total of 12: the total is describing something smaller
    // than what is on the card, so an offset from it would push half the
    // episodes off the end of their own grid.
    const rows = run("long-", 13, 36);
    const map = normalizeEpisodeNumbers(rows, 12);
    expect(map.get("long-13")).toBe(13);
    expect(map.get("long-36")).toBe(36);
  });

  test("a card with no main episode at all is left alone", () => {
    const rows = [ep("sp-13", 13, "sp"), ep("ova-14", 14, "ova")];
    const map = normalizeEpisodeNumbers(rows, 12);
    expect(map.get("sp-13")).toBe(13);
    expect(map.get("ova-14")).toBe(14);
  });

  test("rows with no usable number get no entry at all", () => {
    const rows = [ep("none", null), ep("zero", 0), ep("ok", 5)];
    const map = normalizeEpisodeNumbers(rows, 12);
    expect(map.has("none")).toBe(false);
    expect(map.has("zero")).toBe(false);
    expect(map.get("ok")).toBe(5);
  });
});

describe("normalizeEpisodeNumbers — specials", () => {
  test("a special is never renumbered, even when the mains are", () => {
    const rows = [...run("s2-", 13, 24), ep("sp-1", 1, "sp")];
    const map = normalizeEpisodeNumbers(rows, 12);
    expect(map.get("s2-13")).toBe(1);
    expect(map.get("sp-1")).toBe(1); // its own number, not 1 - 12
  });

  test("a special does not drag the run down and block the shift", () => {
    // If SP01 counted toward the run, the lowest number would be 1, `m > N`
    // would be false, and the sequel would never be normalised at all.
    const withSpecial = [ep("sp-1", 1, "sp"), ...run("s2-", 13, 24)];
    expect(displayOf(withSpecial, 12, "s2-13")).toBe(1);
  });

  test("a special does not fill a hole and make a broken run look contiguous", () => {
    const rows = [ep("h-13", 13), ep("sp-14", 14, "sp"), ep("h-15", 15)];
    const map = normalizeEpisodeNumbers(rows, 12);
    expect(map.get("h-13")).toBe(13);
    expect(map.get("h-15")).toBe(15);
  });
});

describe("normalizeEpisodeNumbers — merged cards", () => {
  test("a merged card covering 1-24 is not shifted", () => {
    // performMerge is soft, so both seasons' rows sit on one card and
    // buildGroupTotals reports the sum. The lowest number is 1: nothing has
    // overshot anything, and renumbering here would move season one.
    const rows = [...run("s1-", 1, 12, "main", "A"), ...run("s2-", 13, 24, "main", "B")];
    const map = normalizeEpisodeNumbers(rows, 24);
    expect(map.get("s1-1")).toBe(1);
    expect(map.get("s2-13")).toBe(13);
    expect(map.get("s2-24")).toBe(24);
  });

  test("two members that each ran 1-12 keep twenty-four separate entries", () => {
    // A number is not an identity inside a merge group. A map keyed by number
    // would hold twelve entries here and silently lose one member entirely.
    const rows = [...run("a-", 1, 12, "main", "A"), ...run("b-", 1, 12, "main", "B")];
    const map = normalizeEpisodeNumbers(rows, 12);
    expect(map.size).toBe(24);
    expect(map.get("a-7")).toBe(7);
    expect(map.get("b-7")).toBe(7);
  });

  test("two members that each ran 13-24 both shift, and stay distinct", () => {
    const rows = [...run("a-", 13, 24, "main", "A"), ...run("b-", 13, 24, "main", "B")];
    const map = normalizeEpisodeNumbers(rows, 12);
    expect(map.size).toBe(24);
    expect(map.get("a-13")).toBe(1);
    expect(map.get("b-13")).toBe(1);
  });
});

describe("normalizeEpisodeNumbers — a measured offset outranks the inference", () => {
  // The reported bug, with the real numbers. Frieren's second season runs 10
  // episodes and its first ran 28, so a group numbering continuously calls
  // the finale 38. `lowest - 1` reads that lone file as the season opener and
  // renders the finale in slot 1 — and the watch push sends 38 into a range
  // check that stops at 10, so the season's progress never syncs at all.
  test("★ a lone finale lands on the finale, not on episode 1", () => {
    const rows = [ep("frieren-38", 38)];
    expect(normalizeEpisodeNumbers(rows, 10).get("frieren-38")).toBe(1);
    expect(normalizeEpisodeNumbers(rows, 10, 28).get("frieren-38")).toBe(10);
  });

  test("★ a trailing run keeps its position", () => {
    // Wrong in the same way and less obviously so: three files at the end of
    // the season get pulled to its front.
    const rows = run("tail-", 36, 38);
    const guessed = normalizeEpisodeNumbers(rows, 10);
    expect([guessed.get("tail-36"), guessed.get("tail-38")]).toEqual([1, 3]);

    const measured = normalizeEpisodeNumbers(rows, 10, 28);
    expect([measured.get("tail-36"), measured.get("tail-38")]).toEqual([8, 10]);
  });

  test("a full season maps the same either way — the case the inference got right", () => {
    const rows = run("full-", 29, 38);
    for (const map of [
      normalizeEpisodeNumbers(rows, 10),
      normalizeEpisodeNumbers(rows, 10, 28),
    ]) {
      expect(map.get("full-29")).toBe(1);
      expect(map.get("full-38")).toBe(10);
    }
  });

  test("offset 0 means nothing precedes the season, and nothing moves", () => {
    const rows = run("s1-", 1, 12);
    const map = normalizeEpisodeNumbers(rows, 12, 0);
    expect(map.get("s1-1")).toBe(1);
    expect(map.get("s1-12")).toBe(12);
  });

  test("★ a known offset that does not fit is discarded, NOT fallen back from", () => {
    // Files already numbered 1-10 for a season whose offset is 28. Applying
    // the offset would produce -27; falling through to `lowest - 1` would be
    // a no-op here, but the same fall-through moves a 13-24 run that is
    // genuinely season-relative. Identity is the only safe answer once a
    // measurement exists and the files disagree with it.
    const rows = run("rel-", 1, 10);
    const map = normalizeEpisodeNumbers(rows, 10, 28);
    expect(map.get("rel-1")).toBe(1);
    expect(map.get("rel-10")).toBe(10);
  });

  test("★ a known offset suppresses the inference even when the inference would fire", () => {
    // 13-24 against a 12-episode season is the inference's own headline case
    // (`lowest > total`), and it would shift to 1-12. But the franchise says
    // 30 episodes precede this season, so these files are not absolutely
    // numbered in the way the inference assumes — and a measurement that
    // disagrees is a reason to stop, not to guess.
    const rows = run("mixed-", 13, 24);
    expect(normalizeEpisodeNumbers(rows, 12).get("mixed-13")).toBe(1);
    expect(normalizeEpisodeNumbers(rows, 12, 30).get("mixed-13")).toBe(13);
  });

  test("a non-integer or negative offset is ignored, not coerced", () => {
    const rows = [ep("odd-38", 38)];
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(normalizeEpisodeNumbers(rows, 10, bad).get("odd-38")).toBe(1);
    }
  });

  test("null and undefined both mean unmeasured, and neither means zero", () => {
    // The distinction the endpoint's `known` flag exists to preserve. If
    // unknown arrived here as 0 it would take the measured branch, find that
    // 38 does not fit [1,10], and freeze the file at 38 — a different wrong
    // answer, arrived at confidently.
    const rows = [ep("unk-38", 38)];
    expect(normalizeEpisodeNumbers(rows, 10, null).get("unk-38")).toBe(1);
    expect(normalizeEpisodeNumbers(rows, 10, undefined).get("unk-38")).toBe(1);
  });
});

// ─── buildGridCells ─────────────────────────────────────────────────────────

/**
 * MANDATORY REGRESSION R1, as an invariant rather than a case.
 *
 * Issue #75 was a merged card showing half its episodes. This task is ABOUT
 * trusting a per-season total, which is the same bug from the arithmetic side,
 * so the guarantee worth asserting is not "case X survives" but "no input row
 * is ever unreachable". Every episode handed in appears exactly once, either
 * in a slot or in the unclassified lane. A total used as a ceiling fails this.
 */
function expectNothingLost(rows: GridEpisodeRow[], total: number | undefined) {
  const model = buildGridCells(rows, total);
  const reachable = [
    ...model.cells.filter((c) => c.episode).map((c) => c.episode!.id),
    ...model.unclassified.map((c) => c.episode!.id),
  ];
  expect(reachable.slice().sort()).toEqual(rows.map((r) => r.id).sort());
  expect(new Set(reachable).size).toBe(reachable.length);
  return model;
}

describe("buildGridCells — the season skeleton", () => {
  test("a known total sizes the grid", () => {
    const model = buildGridCells(run("s1-", 1, 6), 12);
    expect(model.gridLength).toBe(12);
    expect(model.cells).toHaveLength(12);
    expect(model.inferred).toBe(false);
  });

  test("a slot with no local file reads as not downloaded, not as a dead cell", () => {
    const model = buildGridCells(run("s1-", 1, 6), 12);
    expect(model.cells[5].state).toBe("available");
    expect(model.cells[6].state).toBe("notDownloaded");
    expect(model.cells[6].episode).toBe(null);
    expect(model.cells[6].number).toBe(7);
  });

  test("the shifted sequel fills its grid from 1", () => {
    const model = buildGridCells(run("s2-", 13, 24), 12);
    expect(model.gridLength).toBe(12);
    expect(model.cells.every((c) => c.state === "available")).toBe(true);
    expect(model.cells[0].number).toBe(1);
    expect(model.cells[0].rawNumber).toBe(13); // both numbers survive
    expect(model.cells[0].episode?.id).toBe("s2-13");
    expect(model.unclassified).toHaveLength(0);
  });

  test("an unknown total falls back to the local files and says so", () => {
    const model = buildGridCells(run("x-", 1, 7), undefined);
    expect(model.gridLength).toBe(7);
    expect(model.inferred).toBe(true);
  });

  test("an unknown total on a card with nothing indexed still renders one slot", () => {
    const model = buildGridCells([], undefined);
    expect(model.gridLength).toBe(1);
    expect(model.cells).toHaveLength(1);
    expect(model.cells[0].state).toBe("notDownloaded");
  });
});

describe("buildGridCells — MANDATORY REGRESSION R1", () => {
  test("a file numbered past groupTotal lands in the lane rather than vanishing", () => {
    // The whole shape of this task is "start trusting a total". A ceiling here
    // reproduces issue #75 exactly: the file is on disk, it is indexed, and it
    // is reachable from nowhere.
    const rows = [...run("s1-", 1, 12), ep("ova-25", 25, "ova")];
    const model = expectNothingLost(rows, 12);
    expect(model.cells).toHaveLength(12);
    expect(model.unclassified.map((c) => c.episode!.id)).toEqual(["ova-25"]);
    expect(model.unclassified[0].number).toBe(25);
  });

  test("a merged card under-counted by buildGroupTotals keeps every episode", () => {
    // buildGroupTotals deliberately counts DOWN when it cannot identify a
    // member, so a merged card legitimately holds more than its total claims.
    const rows = [...run("s1-", 1, 12, "main", "A"), ...run("s2-", 13, 24, "main", "B")];
    const model = expectNothingLost(rows, 12);
    expect(model.cells).toHaveLength(12);
    expect(model.unclassified).toHaveLength(12);
    expect(model.unclassified.map((c) => c.number)).toEqual([
      13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
    ]);
  });

  test("two members that each ran 1-12 keep all twenty-four rows reachable", () => {
    const rows = [...run("a-", 1, 12, "main", "A"), ...run("b-", 1, 12, "main", "B")];
    const model = expectNothingLost(rows, 12);
    expect(model.cells).toHaveLength(12);
    expect(model.unclassified).toHaveLength(12);
  });

  test("a special displaced by a shift is still reachable", () => {
    // main 13 becomes display 1, which SP01 already occupied. `main` wins the
    // slot; the special must not simply disappear.
    const rows = [...run("s2-", 13, 24), ep("sp-1", 1, "sp")];
    const model = expectNothingLost(rows, 12);
    expect(model.cells[0].episode?.id).toBe("s2-13");
    expect(model.unclassified.map((c) => c.episode!.id)).toEqual(["sp-1"]);
  });

  test("a row with no number at all is still reachable", () => {
    const rows = [...run("s1-", 1, 3), ep("nan", null)];
    const model = expectNothingLost(rows, 12);
    expect(model.unclassified.map((c) => c.episode!.id)).toEqual(["nan"]);
    expect(model.unclassified[0].number).toBe(null);
  });

  test("nothing is lost across a spread of shapes", () => {
    expectNothingLost(run("a-", 1, 12), 12);
    expectNothingLost(run("b-", 13, 24), 12);
    expectNothingLost(run("c-", 13, 18), 24);
    expectNothingLost([...run("d-", 1, 4), ep("d-sp", 2, "sp")], 4);
    expectNothingLost(run("e-", 1, 5), undefined);
    expectNothingLost([], 12);
  });
});

describe("buildGridCells — who wins a slot", () => {
  test("main beats a special holding the same number", () => {
    const rows = [ep("sp-2", 2, "sp"), ep("main-2", 2, "main")];
    const model = buildGridCells(rows, 4);
    expect(model.cells[1].episode?.id).toBe("main-2");
    expect(model.unclassified.map((c) => c.episode!.id)).toEqual(["sp-2"]);
  });

  test("the winner does not depend on the order the rows arrived in", () => {
    const forward = buildGridCells([ep("z-2", 2, "main"), ep("a-2", 2, "main")], 4);
    const backward = buildGridCells([ep("a-2", 2, "main"), ep("z-2", 2, "main")], 4);
    expect(forward.cells[1].episode?.id).toBe(backward.cells[1].episode?.id);
    expect(forward.cells[1].episode?.id).toBe("a-2");
  });
});

// ─── the sheet and the player agree ─────────────────────────────────────────

/** The player's lane rule, as `buildLibraryMatchResult.isWatchableKind` spells it. */
const WATCHABLE = new Set(["main", "sp", "ova", "movie", "unknown"]);
const isWatchable = (kind: string | null | undefined) => WATCHABLE.has(kind || "main");

describe("the sheet and the player show the same number for the same episode", () => {
  /**
   * The self-contradiction this guards is a sheet chip labelled "01" opening a
   * player header labelled "EP13". Both surfaces are asked the same question
   * about the same rows here, and the two answers are compared directly.
   */
  function agree(rows: GridEpisodeRow[], total: number | undefined) {
    const sheet = buildGridCells(rows, total);
    const player = buildEpisodeNavNumbers(rows, total, isWatchable);

    for (const cell of sheet.cells) {
      if (!cell.episode || !isWatchable(cell.episode.kind)) continue;
      expect(player.numbers).toContain(cell.number as number);
      expect(player.rawByDisplay.get(cell.number as number)).toBe(cell.rawNumber);
    }
    return { sheet, player };
  }

  test("on the shifted sequel", () => {
    const { player } = agree(run("s2-", 13, 24), 12);
    expect(player.numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(player.rawByDisplay.get(1)).toBe(13);
  });

  test("on the 24-episode show holding only 13-18", () => {
    const { player } = agree(run("mid-", 13, 18), 24);
    expect(player.numbers).toEqual([13, 14, 15, 16, 17, 18]);
    expect(player.rawByDisplay.get(13)).toBe(13);
  });

  test("on a merged card", () => {
    agree([...run("s1-", 1, 12, "main", "A"), ...run("s2-", 13, 24, "main", "B")], 24);
  });

  test("on a card with a special beside a shifted run", () => {
    const { player } = agree([...run("s2-", 13, 24), ep("sp-1", 1, "sp")], 12);
    // The strip shows slot 1 once, and clicking it opens the main episode —
    // the same episode the sheet's first chip opens.
    expect(player.rawByDisplay.get(1)).toBe(13);
  });

  test("the player strip drops the kinds the player will not play", () => {
    const rows = [...run("s1-", 1, 3), ep("ncop", 4, "ncop")];
    const player = buildEpisodeNavNumbers(rows, 12, isWatchable);
    expect(player.numbers).toEqual([1, 2, 3]);
  });

  test("with no lane rule supplied, every numbered row is on the strip", () => {
    const rows = [...run("s1-", 1, 3), ep("ncop", 4, "ncop")];
    expect(buildEpisodeNavNumbers(rows, 12).numbers).toEqual([1, 2, 3, 4]);
  });

  test("displayByRaw labels the player's file rows, which are keyed by the stored number", () => {
    const nav = buildEpisodeNavNumbers(run("s2-", 13, 24), 12, isWatchable);
    expect(nav.displayByRaw.get(13)).toBe(1);
    expect(nav.displayByRaw.get(24)).toBe(12);
    // A row the strip does not own falls through to its own number at the
    // call site, which is what an unshifted card needs.
    expect(nav.displayByRaw.get(99)).toBeUndefined();
  });

  test("displayByRaw is the exact inverse of rawByDisplay", () => {
    const rows = [...run("s2-", 13, 24), ep("sp-1", 1, "sp")];
    const nav = buildEpisodeNavNumbers(rows, 12, isWatchable);
    for (const [display, raw] of nav.rawByDisplay) {
      expect(nav.displayByRaw.get(raw)).toBe(display);
    }
    expect(nav.displayByRaw.size).toBe(nav.rawByDisplay.size);
  });
});
