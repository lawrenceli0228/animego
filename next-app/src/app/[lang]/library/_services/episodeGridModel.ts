// The episode grid a series card shows, as data.
//
// Extracted out of SeriesDetailSheet so the two rules that decide whether a
// file the user has on disk is reachable at all — which number a chip shows,
// and which chip a file lands in — are testable without mounting React. The
// component that used to hold them is the same component issue #75 shipped
// from, for the same reason: a rule that only exists inside an effect is a
// rule nobody can write a test against.
//
// ─── the defect this exists to fix ──────────────────────────────────────────
//
// A fansub group numbering a sequel continuously from the previous season
// ships season two as episodes 13-24. `parseEpisodeNumber` reads 13,
// `importPipeline` stores `Episode.number = 13`, and the sheet then sized a
// 24-cell grid whose first twelve cells could never be filled.
//
// ─── why the storage layer is left alone ────────────────────────────────────
//
// The offset is a GUESS, and a guess must not enter the primary key space.
// `importPipeline.persistFileRefsOnly` de-duplicates a re-scan by building a
// `byNumber` index from the STORED episodes and looking each cluster item up
// with a freshly parsed `item.episode`. Renumber the stored rows to 1..N and
// the next scan of the same folder parses 13 again, misses the row now filed
// under 1, and creates a second Episode for every file. So this module maps
// ids to display numbers and never writes anything.

import { positiveTotal, resolveEpisodeGridLength } from "./seriesGroups";
import { offsetApplies, readEpisodeOffset } from "@/lib/library/episodeOffset";

/** The `Episode` fields the grid reads. See `lib/library/types.js`. */
export interface GridEpisodeRow {
  readonly id: string;
  readonly seriesId?: string;
  readonly number?: number | null;
  readonly kind?: string | null;
}

/** A whole number that can be an episode number. `0` and below are not. */
function episodeNumberOf(row: GridEpisodeRow | null | undefined): number | undefined {
  const n = row?.number;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * Only `main` is renumbered, and only `main` decides whether to renumber.
 *
 * Specials are numbered in their own space by every fansub group there is —
 * SP01 alongside episode 13 says nothing about where the season starts, and
 * shifting it would move a file the user can currently find.
 */
function isMain(row: GridEpisodeRow | null | undefined): boolean {
  return (row?.kind ?? "main") === "main";
}

/**
 * Display number per episode id, for a card holding `groupTotal` episodes.
 *
 * Keyed by `Episode.id`, never by number: a merged card can hold two members
 * that each ran 1-12, and inside one group a number is not an identity. The
 * raw number stays on the row the caller already has, so both are available.
 *
 * Every episode with a usable number gets an entry. An episode this module
 * declines to move is present with its own number, so a caller never has to
 * decide between "absent because unchanged" and "absent because unknown".
 *
 * ─── when it shifts ─────────────────────────────────────────────────────────
 *
 * With the local main episodes running `[m..n]` and `groupTotal = N`, the
 * shift is `m - 1` when **`m > N`** and nothing else applies. `m > N` is the
 * whole signal: the lowest episode on the card has already overshot the season
 * it belongs to, so it cannot be this season's own numbering.
 *
 * The tempting weaker test — "the run is no longer than the season and does
 * not start at 1" — is not conservative. A 24-episode show with only files
 * 13-18 downloaded satisfies it (`18-13+1 = 6 <= 24`, `13 > 1`) and would be
 * silently renumbered to 1-6, moving six episodes the user can currently find
 * by number. Under `m > N`, `13 < 24` leaves it exactly where it is.
 *
 * ─── every reason it declines ───────────────────────────────────────────────
 *
 *   1. `groupTotal` is unknown or not a positive integer. An unbound series,
 *      or one whose episode count never resolved, has nothing to overshoot.
 *   2. The card holds no `main` episode at all.
 *   3. `m <= N` — the run still fits the season, so it is not an offset.
 *   4. The run has a hole. 13,14,17 is a partial download, not a continuously
 *      numbered season, and 1,2,5 after shifting would claim to be complete.
 *   5. The run is longer than the season (`n - m + 1 > N`). Then `N` is
 *      describing something smaller than what is on the card — a second cour
 *      merged in, or a stale count — and an offset derived from it would push
 *      most of the card off the end of its own grid.
 *
 * All five mean "return identity". Declining is always safe: the grid still
 * renders every episode, it just renders it under the number on disk.
 */
export function normalizeEpisodeNumbers(
  episodes: readonly GridEpisodeRow[] | null | undefined,
  groupTotal: number | null | undefined,
  absoluteOffset?: number | null,
): Map<string, number> {
  const rows = episodes ?? [];
  const out = new Map<string, number>();
  for (const row of rows) {
    const number = episodeNumberOf(row);
    if (row?.id && number !== undefined) out.set(row.id, number);
  }

  const total = positiveTotal(groupTotal); // (1)
  if (total === undefined) return out;

  const mains = rows.filter((row) => isMain(row) && episodeNumberOf(row) !== undefined);
  if (mains.length === 0) return out; // (2)

  const numbers = [...new Set(mains.map((row) => episodeNumberOf(row) as number))].sort(
    (a, b) => a - b,
  );
  const lowest = numbers[0];
  const highest = numbers[numbers.length - 1];
  const span = highest - lowest + 1;

  // ─── a measured offset outranks the inference, both ways ─────────────────
  //
  // `absoluteOffset` is how many episodes precede this season in its
  // franchise's continuous numbering, derived from PREQUEL edges by
  // GET /api/anime/{id}/episode-offset. Pass it only when the server said
  // `known` — an unknown offset must arrive here as undefined and NOT as 0,
  // because 0 is a real answer ("nothing precedes this season") that this
  // branch acts on.
  //
  // It is checked against the files before it is applied. The server knows
  // the franchise; only this side knows what is on disk, and `format` is a
  // coarse proxy for "counts toward the numbering" — so an offset that does
  // not map every episode into [1, total] is discarded rather than trusted.
  //
  // A known offset that does not fit returns identity and does NOT fall
  // through to the inference below. That is the point of measuring: files
  // numbered 1-12 for a season whose offset is 24 are already
  // season-relative, and re-deriving a shift for them from their own lowest
  // value is how a correct set of numbers gets moved.
  //
  // `offsetApplies` is imported rather than restated: `watchSync` has to make
  // the identical decision about the identical files before it pushes them,
  // and two copies of a rule this quiet drift without anything failing — the
  // grid would render episode 10 while the push sent 38.
  const measured = readEpisodeOffset(absoluteOffset);
  if (measured !== undefined) {
    if (offsetApplies(numbers, total, measured)) {
      for (const row of mains) {
        out.set(row.id, (episodeNumberOf(row) as number) - measured);
      }
    }
    return out;
  }

  // ─── otherwise, infer — with the gap this leaves stated ──────────────────
  //
  // `shift = lowest - 1` assumes the lowest file on the card IS the season's
  // first episode. That holds for someone who downloaded the season from the
  // start and fails for someone holding only its tail: a lone finale
  // numbered 38 against a 10-episode season lands in slot 1, which is the
  // bug that produced the offset endpoint above. The inference is kept for
  // the ~quarter of the catalogue with no relation rows, where it is still
  // better than nothing for the common full-season case, and it is reached
  // ONLY when no offset was measured.
  if (lowest <= total) return out; // (3)
  if (numbers.length !== span) return out; // (4) — deduped, so length === span means contiguous
  if (span > total) return out; // (5)

  const shift = lowest - 1;
  for (const row of mains) {
    out.set(row.id, (episodeNumberOf(row) as number) - shift);
  }
  return out;
}

/** The player's episode strip, in the same numbers the sheet's chips show. */
export interface EpisodeNavModel {
  /** Display numbers, ascending and unique — what the strip renders. */
  readonly numbers: number[];
  /**
   * Display number back to the stored one.
   *
   * Everything downstream of a click still runs in the stored number space:
   * `Episode.number` lookups, `matchResult.episodeMap` (keyed by the number
   * parsed out of the filename), the `?resumeEpisode=` hand-off. Only the
   * label moves, so a click has to be translated back before it is used.
   */
  readonly rawByDisplay: ReadonlyMap<number, number>;
  /**
   * The same relation the other way, for surfaces that hold a stored number
   * and need a label — the player's file list, whose rows are keyed by the
   * number parsed from the filename.
   */
  readonly displayByRaw: ReadonlyMap<number, number>;
}

/**
 * The player half of the same rule.
 *
 * The sheet and the player must never disagree about what to call one episode
 * — a sheet saying "EP 01" that opens a player saying "EP 13" is worse than
 * the off-by-a-season grid it was meant to fix. Both read
 * `normalizeEpisodeNumbers`, and this is the shape the strip needs.
 *
 * Two rows can land on one display number (a special numbered 1 next to a
 * shifted main), so the strip shows the slot once and `main` owns it — the
 * same tie-break `buildGridCells` uses, for the same reason.
 *
 * @param isPlayable the player's own lane rule, passed in so this module keeps
 *   no React and no DOM in its import graph (see testImportHygiene.test.ts)
 */
export function buildEpisodeNavNumbers(
  episodes: readonly GridEpisodeRow[] | null | undefined,
  groupTotal: number | null | undefined,
  isPlayable: (kind: string | null | undefined) => boolean = () => true,
  absoluteOffset?: number | null,
): EpisodeNavModel {
  const rows = (episodes ?? []).filter(
    (row): row is GridEpisodeRow =>
      !!row &&
      typeof row.id === "string" &&
      !!row.id &&
      episodeNumberOf(row) !== undefined &&
      isPlayable(row.kind),
  );
  const displayNumbers = normalizeEpisodeNumbers(episodes, groupTotal, absoluteOffset);

  const owner = new Map<number, GridEpisodeRow>();
  for (const row of rows) {
    const number = displayNumbers.get(row.id);
    if (number === undefined) continue;
    const incumbent = owner.get(number);
    if (!incumbent || beats(row, incumbent)) owner.set(number, row);
  }

  const rawByDisplay = new Map<number, number>();
  const displayByRaw = new Map<number, number>();
  for (const [number, row] of owner) {
    const raw = episodeNumberOf(row) as number;
    rawByDisplay.set(number, raw);
    displayByRaw.set(raw, number);
  }

  return {
    numbers: [...owner.keys()].sort((a, b) => a - b),
    rawByDisplay,
    displayByRaw,
  };
}

/** One chip. `episode === null` is a slot the season has and the disk does not. */
export interface GridCell {
  /** Stable React key. Cells are keyed by slot, lane entries by episode id. */
  readonly key: string;
  /** What the chip shows. `null` only in the lane, for a file with no number. */
  readonly number: number | null;
  /** `Episode.number` as stored — what every id-space lookup still uses. */
  readonly rawNumber: number | null;
  readonly episode: GridEpisodeRow | null;
  readonly state: "available" | "notDownloaded";
}

export interface EpisodeGridModel {
  /** The season skeleton, `1..gridLength`, in order. Always this long. */
  readonly cells: readonly GridCell[];
  /**
   * Every local episode that did not win a slot: numbered past the end of the
   * season, numbered zero or not at all, or beaten to its slot by a `main`.
   *
   * ─── MANDATORY REGRESSION R1 ──────────────────────────────────────────────
   *
   * This lane is what makes it safe for `groupTotal` to size the grid. Issue
   * #75 was a merged card showing half its episodes because the QUERY only
   * read the root series; trusting a per-season total as a ceiling here would
   * re-create it from the arithmetic side, on the very same cards — a merged
   * card legitimately holds more episodes than any one of its seasons
   * declares, and `buildGroupTotals` deliberately under-counts a member it
   * cannot identify.
   *
   * So nothing is ever dropped: `cells` + `unclassified` account for every
   * row handed in, and the caller must render both.
   */
  readonly unclassified: readonly GridCell[];
  readonly gridLength: number;
  /** True when no `groupTotal` was known and the length came from the files. */
  readonly inferred: boolean;
  /** Display number per episode id — the same map the player renders from. */
  readonly displayNumbers: ReadonlyMap<string, number>;
  /** How many local episodes this card holds, placed or not. */
  readonly episodeCount: number;
}

/** Deterministic slot winner: `main` first, then lowest id. Never Dexie order. */
function beats(candidate: GridEpisodeRow, incumbent: GridEpisodeRow): boolean {
  const candidateIsMain = isMain(candidate);
  if (candidateIsMain !== isMain(incumbent)) return candidateIsMain;
  return candidate.id < incumbent.id;
}

/**
 * The grid, as cells.
 *
 * `groupTotal` known is the skeleton — the season declares its own length and
 * a missing file reads as a gap in it rather than as an unexplained dead chip.
 * Unknown falls back to `resolveEpisodeGridLength`, the rule that already
 * existed for this, and reports `inferred` so the caller can say so.
 *
 * `resolveEpisodeGridLength` is reused rather than reimplemented, and only for
 * the unknown branch. Its "the declared total is a floor, never a ceiling"
 * rule existed to keep an episode numbered past the season reachable; that is
 * now the lane's job, and it does it without stretching a 12-episode season to
 * 25 chips because one special parsed as 25.
 */
export function buildGridCells(
  episodes: readonly GridEpisodeRow[] | null | undefined,
  groupTotal: number | null | undefined,
  absoluteOffset?: number | null,
): EpisodeGridModel {
  const rows = (episodes ?? []).filter(
    (row): row is GridEpisodeRow => !!row && typeof row.id === "string" && !!row.id,
  );
  const displayNumbers = normalizeEpisodeNumbers(rows, groupTotal, absoluteOffset);

  const total = positiveTotal(groupTotal);
  const inferred = total === undefined;
  const gridLength =
    total ??
    resolveEpisodeGridLength(
      undefined,
      rows.map((row) => ({ number: displayNumbers.get(row.id) })),
    );

  // Claim slots. A row with no display number cannot claim one at all.
  const claimed = new Map<number, GridEpisodeRow>();
  for (const row of rows) {
    const number = displayNumbers.get(row.id);
    if (number === undefined || number < 1 || number > gridLength) continue;
    const incumbent = claimed.get(number);
    if (!incumbent || beats(row, incumbent)) claimed.set(number, row);
  }

  const cells: GridCell[] = [];
  for (let number = 1; number <= gridLength; number += 1) {
    const episode = claimed.get(number) ?? null;
    cells.push({
      key: `slot:${number}`,
      number,
      rawNumber: episode ? (episodeNumberOf(episode) ?? null) : null,
      episode,
      state: episode ? "available" : "notDownloaded",
    });
  }

  // Numbered first and in order, then the unnumbered. Ties break on id rather
  // than on input order, which is Dexie's and therefore not ours to rely on.
  const winners = new Set(claimed.values());
  const unclassified: GridCell[] = rows
    .filter((row) => !winners.has(row))
    .map((row) => ({
      key: `ep:${row.id}`,
      number: displayNumbers.get(row.id) ?? null,
      rawNumber: episodeNumberOf(row) ?? null,
      episode: row,
      state: "available" as const,
    }))
    .sort((a, b) => {
      const left = a.number ?? Number.MAX_SAFE_INTEGER;
      const right = b.number ?? Number.MAX_SAFE_INTEGER;
      if (left !== right) return left - right;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

  return {
    cells,
    unclassified,
    gridLength,
    inferred,
    displayNumbers,
    episodeCount: rows.length,
  };
}
