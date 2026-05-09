// @ts-check
// Split a Series: extract a subset of its Seasons into a brand-new Series and
// record the lineage on the new Series's userOverride row (`splitFrom`).
// Pure orchestration — caller injects db + ulid + clock for testability.

/**
 * @param {{
 *   db: import('dexie').Dexie,
 *   sourceSeriesId: string,
 *   seasonIds: string[],
 *   name: string,
 *   ulid: () => string,
 *   now?: () => number,
 * }} input
 * @returns {Promise<string>} new series id
 */
export async function splitSeries(input) {
  const { db, sourceSeriesId, seasonIds, name, ulid, now = () => Date.now() } = input;

  if (!Array.isArray(seasonIds) || seasonIds.length === 0) {
    throw new Error('splitSeries: seasonIds must be a non-empty array');
  }
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName) {
    throw new Error('splitSeries: name must be a non-empty string');
  }

  return db.transaction('rw', db.series, db.seasons, db.userOverride, async () => {
    // Ownership check: every seasonId must belong to sourceSeriesId.
    // Done inside the txn so concurrent writes can't slip past.
    const targets = await db.seasons.bulkGet(seasonIds);
    if (targets.some((sn) => sn === undefined || sn === null)) {
      throw new Error('splitSeries: one or more seasonIds do not exist');
    }
    if (targets.some((sn) => sn.seriesId !== sourceSeriesId)) {
      throw new Error('splitSeries: a seasonId does not belong to sourceSeriesId');
    }

    // Reject "split everything" — that's a rename, not a split.
    const totalSeasons = await db.seasons
      .where('seriesId')
      .equals(sourceSeriesId)
      .count();
    if (seasonIds.length >= totalSeasons) {
      throw new Error('splitSeries: cannot extract all seasons (use rename instead)');
    }

    const newId = ulid();
    const ts = now();

    await db.series.add({
      id: newId,
      titleZh: trimmedName,
      titleEn: trimmedName,
      type: 'tv',
      confidence: 1.0,
      createdAt: ts,
      updatedAt: ts,
    });

    for (const sn of targets) {
      await db.seasons.update(sn.id, { seriesId: newId, updatedAt: ts });
    }

    await db.userOverride.put({
      seriesId: newId,
      splitFrom: sourceSeriesId,
      updatedAt: ts,
    });

    return newId;
  });
}
