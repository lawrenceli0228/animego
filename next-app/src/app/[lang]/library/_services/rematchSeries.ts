"use client";

// Ported from client/src/services/rematchSeries.js. Updates the primary
// season's dandanplay animeId, refreshes any series record fields the caller
// passes, and merges a userOverride row marking the choice as locked. All in a
// single rw transaction across series + seasons + userOverride.
//
// Two id spaces, split on purpose (they used to share one field and corrupt
// each other — see RematchDialog.normalize):
//
//   dandanAnimeId → Season.animeId. This module owns it. Danmaku and episode
//                   listings key off it; the import pipeline reuses seasons by
//                   matching it.
//   anilistId     → Series.anilistId. `animeBinding` owns it, and this module
//                   goes through that door like everyone else. A rematch is by
//                   definition a manual binding, so it is written with
//                   `source: 'manual'` and takes the lock.
//
// A picked hit may carry either id or both — `/api/dandanplay/search` returns
// animeCache rows (anilistId only) and dandanplay rows (dandanAnimeId only) —
// so both inputs are optional and at least one is required.

import type Dexie from "dexie";
import { writeBinding, type BindingDb } from "@/lib/library/animeBinding";

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
  /** dandanplay id space. Omit when the picked hit has no dandanplay row. */
  dandanAnimeId?: number;
  /** AniList id space. Omit when the picked hit has no AniList row. */
  anilistId?: number;
  titleZh?: string;
  titleEn?: string;
  titleJa?: string;
  posterUrl?: string;
  /**
   * The picked hit's episode count. Written only when it is a positive
   * integer — `<= 0` is how every reader of `Series.totalEpisodes` spells
   * "unknown", so a zero would replace a real answer with a fake one.
   */
  totalEpisodes?: number;
  type?: "tv" | "movie" | "ova" | "web";
  ulid: () => string;
  now?: () => number;
}

function assertOptionalId(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`rematchSeries: ${field} must be a positive integer`);
  }
}

export async function rematchSeries(input: RematchSeriesInput): Promise<void> {
  const {
    db,
    seriesId,
    dandanAnimeId,
    anilistId,
    titleZh,
    titleEn,
    titleJa,
    posterUrl,
    totalEpisodes,
    type,
    ulid,
    now = () => Date.now(),
  } = input;

  if (typeof seriesId !== "string" || !seriesId) {
    throw new Error("rematchSeries: seriesId must be a non-empty string");
  }
  assertOptionalId(dandanAnimeId, "dandanAnimeId");
  assertOptionalId(anilistId, "anilistId");
  if (dandanAnimeId === undefined && anilistId === undefined) {
    throw new Error(
      "rematchSeries: at least one of dandanAnimeId / anilistId is required",
    );
  }
  if (typeof ulid !== "function") {
    throw new Error("rematchSeries: ulid factory is required");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables = db as any;
  await tables.transaction(
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
      // Only when we actually have a dandanplay id — writing anything else here
      // is the bug this split exists to prevent.
      if (dandanAnimeId !== undefined) {
        const seasons = (await tables.seasons
          .where("seriesId")
          .equals(seriesId)
          .toArray()) as SeasonRow[];

        if (seasons.length === 0) {
          await tables.seasons.add({
            id: ulid(),
            seriesId,
            number: 1,
            animeId: dandanAnimeId,
            updatedAt: ts,
          });
        } else {
          const primary = seasons.reduce(
            (min, s) => (s.number < min.number ? s : min),
            seasons[0],
          );
          await tables.seasons.update(primary.id, {
            animeId: dandanAnimeId,
            updatedAt: ts,
          });
        }
      }

      const seriesPatch: Record<string, unknown> = { updatedAt: ts };
      if (titleZh !== undefined) seriesPatch.titleZh = titleZh;
      if (titleEn !== undefined) seriesPatch.titleEn = titleEn;
      if (titleJa !== undefined) seriesPatch.titleJa = titleJa;
      if (posterUrl !== undefined) seriesPatch.posterUrl = posterUrl;
      if (
        typeof totalEpisodes === "number" &&
        Number.isInteger(totalEpisodes) &&
        totalEpisodes > 0
      ) {
        seriesPatch.totalEpisodes = totalEpisodes;
      }
      if (type !== undefined) seriesPatch.type = type;
      await tables.series.update(seriesId, seriesPatch);

      const existingOverride = (await tables.userOverride.get(seriesId)) ?? {};
      await tables.userOverride.put({
        ...existingOverride,
        seriesId,
        locked: true,
        ...(dandanAnimeId !== undefined
          ? { overrideSeasonAnimeId: dandanAnimeId }
          : {}),
        updatedAt: ts,
      });
    },
  );

  // Outside the transaction on purpose: writeBinding opens its own reads and
  // writes, and nesting a second Dexie scope inside this one buys nothing here.
  // The lock is already committed above, so an auto match cannot slip in
  // between and claim the binding. If this throws, the season half stands and
  // the caller surfaces the error — a retry of the same rematch is idempotent.
  if (anilistId !== undefined) {
    await writeBinding(
      db as unknown as BindingDb,
      seriesId,
      anilistId,
      "manual",
      now,
    );
  }
}
