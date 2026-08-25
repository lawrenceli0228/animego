"use client";

// Find Series rows that are the same title recorded twice, and merge them.
//
// WHY THIS STOPPED WORKING
//
// It used to group on `Season.animeId` alone. #105 removed the fallback that
// was filling that field, because the value it stored was a bgm.tv subject id
// living in a dandanplay-shaped column — `/api/dandanplay/match` returns no
// dandanplay animeId in any phase, so `?? merged.bgmId` was not a fallback,
// it was the only branch that ever fired.
//
// Removing it was right, and it left this pass with nothing to group by: an
// automatically imported series has no `Season.animeId` at all, so duplicate
// cards for the same show simply never met each other. The header of this file
// said so and nothing acted on it.
//
// `Series.anilistId` is the better key and #105 is also what made it reliable
// — the binding sweep fills it for series nobody clicked, and the import path
// writes it directly. It is the id the site itself is keyed on, so two local
// rows sharing one is the definition of "the same show, twice".
//
// ─── the two id spaces must not share a Map ─────────────────────────────────
//
// `Season.animeId` (dandanplay) still has a live population — a manual rematch
// through the dandanplay search writes a real one — so it stays a usable key
// where it exists. But the two spaces COLLIDE: id 806 is a valid anime in
// both, and both endpoints answer 200 for it. Grouping them in one numeric map
// would merge two unrelated shows with total confidence, which is the exact
// failure #105's branded types exist to prevent one layer down.
//
// So the key is a namespaced string, never a number. `anilist:806` and
// `dandan:806` cannot collide because they are not the same string.

import type Dexie from "dexie";
import { performMerge, type OpsLogRow } from "./mergeOps";

interface SeasonRow {
  seriesId?: string;
  animeId?: number;
  number?: number;
}

interface SeriesRow {
  id: string;
  createdAt?: number;
  anilistId?: number | null;
}

interface OverrideRow {
  seriesId?: string;
  splitFrom?: string;
}

export interface DedupePair {
  sourceSeriesId: string;
  targetSeriesId: string;
  /** The namespaced identity both rows resolved to. */
  identity: string;
}

export interface DedupeSummary {
  groups: number;
  merged: number;
  skipped: number;
  /** Pairs left alone because the reader had deliberately split them apart. */
  splitGuarded: number;
  pairs: DedupePair[];
  opIds: string[];
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * The namespaced identity of one series, or null when it has none.
 *
 * AniList first, deliberately. It is the id every other surface keys on, it is
 * the one the binding sweep and the import path actually write, and it
 * survives a rematch that changes the dandanplay side. `Season.animeId` is the
 * fallback rather than the peer: it exists on a shrinking population (manual
 * rematches only) and describes a season rather than a title.
 *
 * A series with several seasons uses the lowest-numbered one's animeId, the
 * same "primary season" rule `seriesGroups.primaryAnimeIdBySeries` uses, so
 * two passes over the same library cannot disagree about which season speaks
 * for a card.
 */
export function identityKeyFor(
  series: SeriesRow,
  seasonsBySeries: ReadonlyMap<string, readonly SeasonRow[]>,
): string | null {
  const anilistId = positiveInt(series?.anilistId);
  if (anilistId !== undefined) return `anilist:${anilistId}`;

  let best: { number: number; animeId: number } | undefined;
  for (const season of seasonsBySeries.get(series?.id ?? "") ?? []) {
    const animeId = positiveInt(season?.animeId);
    if (animeId === undefined) continue;
    const number = positiveInt(season?.number) ?? 1;
    if (
      !best ||
      number < best.number ||
      (number === best.number && animeId < best.animeId)
    ) {
      best = { number, animeId };
    }
  }
  return best ? `dandan:${best.animeId}` : null;
}

/**
 * Was this pair deliberately taken apart by the reader?
 *
 * `splitSeries` records the lineage on the NEW series' override row, so the
 * relation is one-directional and has to be checked both ways round.
 *
 * This is the guard that makes an automatic pass safe to run at all. Without
 * it a reader who split a card in two would watch it re-merge on their next
 * visit, every visit, with no way to make it stop — an automatic action
 * undoing a manual one is worse than not automating it.
 */
export function wasDeliberatelySplit(
  a: string,
  b: string,
  splitFrom: ReadonlyMap<string, string>,
): boolean {
  return splitFrom.get(a) === b || splitFrom.get(b) === a;
}

/**
 * Merge every group of Series rows that resolve to the same identity.
 *
 * The oldest row (lowest `createdAt`) wins as the merge target, so the card
 * the reader has had longest is the one that keeps its place.
 *
 * NEVER THROWS on a single bad pair — `performMerge` validates its inputs and
 * a failure there must not cost the rest of the library its grouping.
 */
export async function dedupeSeriesByIdentity({
  db,
}: {
  db: Dexie;
}): Promise<DedupeSummary> {
  if (!db) throw new Error("dedupeSeriesByIdentity: db is required");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables = db as any;
  const [allSeasons, allSeries, allOverrides] = (await Promise.all([
    tables.seasons.toArray(),
    tables.series.toArray(),
    tables.userOverride.toArray(),
  ])) as [SeasonRow[], SeriesRow[], OverrideRow[]];

  const seasonsBySeries = new Map<string, SeasonRow[]>();
  for (const season of allSeasons) {
    if (!season?.seriesId) continue;
    const bucket = seasonsBySeries.get(season.seriesId);
    if (bucket) bucket.push(season);
    else seasonsBySeries.set(season.seriesId, [season]);
  }

  const splitFrom = new Map<string, string>();
  for (const row of allOverrides) {
    if (row?.seriesId && typeof row.splitFrom === "string" && row.splitFrom) {
      splitFrom.set(row.seriesId, row.splitFrom);
    }
  }

  const seriesMeta = new Map<string, { createdAt: number }>(
    allSeries.map((s) => [s.id, { createdAt: s.createdAt ?? 0 }]),
  );

  const groupsByIdentity = new Map<string, Set<string>>();
  for (const series of allSeries) {
    if (!series?.id) continue;
    const identity = identityKeyFor(series, seasonsBySeries);
    if (identity === null) continue;
    let set = groupsByIdentity.get(identity);
    if (!set) {
      set = new Set();
      groupsByIdentity.set(identity, set);
    }
    set.add(series.id);
  }

  const summary: DedupeSummary = {
    groups: 0,
    merged: 0,
    skipped: 0,
    splitGuarded: 0,
    pairs: [],
    opIds: [],
  };

  for (const [identity, seriesIds] of groupsByIdentity) {
    if (seriesIds.size < 2) continue;
    summary.groups++;

    const sorted = Array.from(seriesIds).sort((a, b) => {
      const ca = seriesMeta.get(a)?.createdAt ?? 0;
      const cb = seriesMeta.get(b)?.createdAt ?? 0;
      if (ca !== cb) return ca - cb;
      return a.localeCompare(b);
    });
    const target = sorted[0];
    const sources = sorted.slice(1);

    for (const source of sources) {
      if (wasDeliberatelySplit(source, target, splitFrom)) {
        summary.splitGuarded++;
        continue;
      }
      summary.pairs.push({
        sourceSeriesId: source,
        targetSeriesId: target,
        identity,
      });
      try {
        const op: OpsLogRow | null = await performMerge({
          db,
          sourceSeriesId: source,
          targetSeriesId: target,
          summary: { identity, auto: true, reason: "dedupeByIdentity" },
        });
        if (op) {
          summary.merged++;
          summary.opIds.push(op.id);
        } else {
          summary.skipped++;
        }
      } catch (err) {
        // performMerge throws on validation issues only (bad inputs). Log and
        // keep going so one bad pair doesn't block the rest.
        // eslint-disable-next-line no-console
        console.warn("[dedupeSeries] merge failed", source, "→", target, err);
      }
    }
  }

  return summary;
}
