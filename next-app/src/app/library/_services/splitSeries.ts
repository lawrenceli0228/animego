"use client";

// Ported from client/src/services/splitSeries.js. Split a Series: extract
// a subset of its Seasons into a brand-new Series and record the lineage on
// the new Series's userOverride row (`splitFrom`).

import type Dexie from "dexie";

interface SeasonRow {
  id: string;
  seriesId: string;
  number: number;
  animeId: number;
  totalEpisodes?: number;
  updatedAt?: number;
}

interface SplitSeriesInput {
  db: Dexie;
  sourceSeriesId: string;
  seasonIds: string[];
  name: string;
  ulid: () => string;
  now?: () => number;
}

export async function splitSeries(input: SplitSeriesInput): Promise<string> {
  const {
    db,
    sourceSeriesId,
    seasonIds,
    name,
    ulid,
    now = () => Date.now(),
  } = input;

  if (!Array.isArray(seasonIds) || seasonIds.length === 0) {
    throw new Error("splitSeries: seasonIds must be a non-empty array");
  }
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (!trimmedName) {
    throw new Error("splitSeries: name must be a non-empty string");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables = db as any;
  return tables.transaction(
    "rw",
    tables.series,
    tables.seasons,
    tables.userOverride,
    async () => {
      // Ownership check: every seasonId must belong to sourceSeriesId.
      const targets = (await tables.seasons.bulkGet(seasonIds)) as Array<
        SeasonRow | undefined
      >;
      if (targets.some((sn) => sn === undefined || sn === null)) {
        throw new Error("splitSeries: one or more seasonIds do not exist");
      }
      if (targets.some((sn) => sn!.seriesId !== sourceSeriesId)) {
        throw new Error(
          "splitSeries: a seasonId does not belong to sourceSeriesId",
        );
      }

      // Reject "split everything" — that's a rename.
      const totalSeasons: number = await tables.seasons
        .where("seriesId")
        .equals(sourceSeriesId)
        .count();
      if (seasonIds.length >= totalSeasons) {
        throw new Error(
          "splitSeries: cannot extract all seasons (use rename instead)",
        );
      }

      const newId = ulid();
      const ts = now();

      await tables.series.add({
        id: newId,
        titleZh: trimmedName,
        titleEn: trimmedName,
        type: "tv",
        confidence: 1.0,
        createdAt: ts,
        updatedAt: ts,
      });

      for (const sn of targets) {
        await tables.seasons.update(sn!.id, { seriesId: newId, updatedAt: ts });
      }

      await tables.userOverride.put({
        seriesId: newId,
        splitFrom: sourceSeriesId,
        updatedAt: ts,
      });

      return newId;
    },
  );
}
