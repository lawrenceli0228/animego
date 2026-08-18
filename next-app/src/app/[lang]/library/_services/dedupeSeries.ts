"use client";

// Ported from client/src/services/dedupeSeries.js. Find Series records that
// share a Season.animeId and merge the duplicates via performMerge. The
// oldest Series (lowest createdAt) wins as the merge target.

import type Dexie from "dexie";
import { performMerge, type OpsLogRow } from "./mergeOps";

interface SeasonRow {
  seriesId?: string;
  animeId?: number;
}

interface SeriesRow {
  id: string;
  createdAt?: number;
}

export interface DedupePair {
  sourceSeriesId: string;
  targetSeriesId: string;
  animeId: number;
}

export interface DedupeSummary {
  groups: number;
  merged: number;
  skipped: number;
  pairs: DedupePair[];
  opIds: string[];
}

export async function dedupeSeriesByAnimeId({
  db,
}: {
  db: Dexie;
}): Promise<DedupeSummary> {
  if (!db) throw new Error("dedupeSeriesByAnimeId: db is required");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables = db as any;
  const [allSeasons, allSeries] = (await Promise.all([
    tables.seasons.toArray(),
    tables.series.toArray(),
  ])) as [SeasonRow[], SeriesRow[]];

  const seriesMeta = new Map<string, { createdAt: number }>(
    allSeries.map((s) => [s.id, { createdAt: s.createdAt ?? 0 }]),
  );

  const groupsByAnimeId = new Map<number, Set<string>>();
  for (const season of allSeasons) {
    if (typeof season.animeId !== "number") continue;
    if (!season.seriesId) continue;
    let set = groupsByAnimeId.get(season.animeId);
    if (!set) {
      set = new Set();
      groupsByAnimeId.set(season.animeId, set);
    }
    set.add(season.seriesId);
  }

  const summary: DedupeSummary = {
    groups: 0,
    merged: 0,
    skipped: 0,
    pairs: [],
    opIds: [],
  };

  for (const [animeId, seriesIds] of groupsByAnimeId) {
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
      summary.pairs.push({
        sourceSeriesId: source,
        targetSeriesId: target,
        animeId,
      });
      try {
        const op: OpsLogRow | null = await performMerge({
          db,
          sourceSeriesId: source,
          targetSeriesId: target,
          summary: { animeId, auto: true, reason: "dedupeByAnimeId" },
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
        console.warn(
          "[dedupeSeries] merge failed",
          source,
          "→",
          target,
          err,
        );
      }
    }
  }

  return summary;
}
