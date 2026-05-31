"use client";

// Ported from client/src/services/rematchSeries.js. Updates the primary
// season's animeId, refreshes any series record fields the caller passes,
// and merges a userOverride row marking the choice as locked. All in a
// single rw transaction across series + seasons + userOverride.

import type Dexie from "dexie";

interface SeasonRow {
  id: string;
  seriesId: string;
  number: number;
  animeId: number;
  totalEpisodes?: number;
  updatedAt?: number;
}

interface RematchSeriesInput {
  db: Dexie;
  seriesId: string;
  animeId: number;
  titleZh?: string;
  titleEn?: string;
  titleJa?: string;
  posterUrl?: string;
  type?: "tv" | "movie" | "ova" | "web";
  ulid: () => string;
  now?: () => number;
}

export async function rematchSeries(input: RematchSeriesInput): Promise<void> {
  const {
    db,
    seriesId,
    animeId,
    titleZh,
    titleEn,
    titleJa,
    posterUrl,
    type,
    ulid,
    now = () => Date.now(),
  } = input;

  if (typeof seriesId !== "string" || !seriesId) {
    throw new Error("rematchSeries: seriesId must be a non-empty string");
  }
  if (
    typeof animeId !== "number" ||
    !Number.isInteger(animeId) ||
    animeId <= 0
  ) {
    throw new Error("rematchSeries: animeId must be a positive integer");
  }
  if (typeof ulid !== "function") {
    throw new Error("rematchSeries: ulid factory is required");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables = db as any;
  return tables.transaction(
    "rw",
    tables.series,
    tables.seasons,
    tables.userOverride,
    async () => {
      const series = await tables.series.get(seriesId);
      if (!series) {
        throw new Error(`rematchSeries: series ${seriesId} does not exist`);
      }

      const ts = now();

      // Pick the primary (lowest-numbered) season; create one if absent.
      const seasons = (await tables.seasons
        .where("seriesId")
        .equals(seriesId)
        .toArray()) as SeasonRow[];

      if (seasons.length === 0) {
        await tables.seasons.add({
          id: ulid(),
          seriesId,
          number: 1,
          animeId,
          updatedAt: ts,
        });
      } else {
        const primary = seasons.reduce(
          (min, s) => (s.number < min.number ? s : min),
          seasons[0],
        );
        await tables.seasons.update(primary.id, { animeId, updatedAt: ts });
      }

      const seriesPatch: Record<string, unknown> = { updatedAt: ts };
      if (titleZh !== undefined) seriesPatch.titleZh = titleZh;
      if (titleEn !== undefined) seriesPatch.titleEn = titleEn;
      if (titleJa !== undefined) seriesPatch.titleJa = titleJa;
      if (posterUrl !== undefined) seriesPatch.posterUrl = posterUrl;
      if (type !== undefined) seriesPatch.type = type;
      await tables.series.update(seriesId, seriesPatch);

      const existingOverride = (await tables.userOverride.get(seriesId)) ?? {};
      await tables.userOverride.put({
        ...existingOverride,
        seriesId,
        locked: true,
        overrideSeasonAnimeId: animeId,
        updatedAt: ts,
      });
    },
  );
}
