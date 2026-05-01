// @ts-check
// Rematch a Series to a different dandanplay anime. Updates the primary
// season's animeId, refreshes any series record fields the caller passes,
// and merges a userOverride row marking the choice as locked. All of it in
// a single rw transaction across series + seasons + userOverride.
//
// Pure orchestration — caller injects db + ulid + clock for testability.

/**
 * @param {{
 *   db: import('dexie').Dexie,
 *   seriesId: string,
 *   animeId: number,
 *   titleZh?: string,
 *   titleEn?: string,
 *   titleJa?: string,
 *   posterUrl?: string,
 *   type?: 'tv'|'movie'|'ova'|'web',
 *   ulid: () => string,
 *   now?: () => number,
 * }} input
 * @returns {Promise<void>}
 */
export async function rematchSeries(input) {
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

  if (typeof seriesId !== 'string' || !seriesId) {
    throw new Error('rematchSeries: seriesId must be a non-empty string');
  }
  if (
    typeof animeId !== 'number' ||
    !Number.isInteger(animeId) ||
    animeId <= 0
  ) {
    throw new Error('rematchSeries: animeId must be a positive integer');
  }
  if (typeof ulid !== 'function') {
    throw new Error('rematchSeries: ulid factory is required');
  }

  return db.transaction(
    'rw',
    db.series,
    db.seasons,
    db.userOverride,
    async () => {
      const series = await db.series.get(seriesId);
      if (!series) {
        throw new Error(`rematchSeries: series ${seriesId} does not exist`);
      }

      const ts = now();

      // Pick the primary (lowest-numbered) season; create one if absent.
      const seasons = await db.seasons
        .where('seriesId')
        .equals(seriesId)
        .toArray();

      if (seasons.length === 0) {
        await db.seasons.add({
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
        await db.seasons.update(primary.id, { animeId, updatedAt: ts });
      }

      const seriesPatch = { updatedAt: ts };
      if (titleZh !== undefined) seriesPatch.titleZh = titleZh;
      if (titleEn !== undefined) seriesPatch.titleEn = titleEn;
      if (titleJa !== undefined) seriesPatch.titleJa = titleJa;
      if (posterUrl !== undefined) seriesPatch.posterUrl = posterUrl;
      if (type !== undefined) seriesPatch.type = type;
      await db.series.update(seriesId, seriesPatch);

      const existingOverride = (await db.userOverride.get(seriesId)) ?? {};
      await db.userOverride.put({
        ...existingOverride,
        seriesId,
        locked: true,
        overrideSeasonAnimeId: animeId,
        updatedAt: ts,
      });
    },
  );
}
