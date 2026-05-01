// @ts-check
// Refresh a Series record's enrichment fields (titleZh / titleEn / posterUrl)
// by re-asking dandanplay for the match using one of its existing fileRefs.
//
// Why this exists: pre-2026-05 imports persisted the anitomy-derived parsedTitle
// (often a fansub group name like "Nekomoe kissaten") and no posterUrl, because
// the dandan client wasn't forwarding `enrichment` to the pipeline. Re-running
// the full import would shuffle records — this lets the user refresh metadata
// in place, keeping seriesId / seasonId / episodeId stable so progress survives.

/** @typedef {import('../lib/library/types').Series} Series */
/** @typedef {import('../lib/library/types').Episode} Episode */
/** @typedef {import('../lib/library/types').FileRef} FileRef */

/**
 * @typedef {Object} DandanEnrichment
 * @property {string} [titleZh]
 * @property {string} [titleEn]
 * @property {string} [posterUrl]
 *
 * @typedef {{ match(hash16M: string, fileName: string, opts?: { fileSize?: number }): Promise<{ isMatched: boolean, animes: Array<{ animeId: number, animeTitle: string }>, enrichment?: DandanEnrichment }|null> }} DandanClient
 *
 * @typedef {Object} RefreshResult
 * @property {string} seriesId
 * @property {boolean} changed       - true if at least one field was updated
 * @property {string[]} fields       - fields that were patched (titleZh/titleEn/posterUrl)
 * @property {string} [skipReason]   - why no update happened: 'no-fileref'|'no-hash'|'no-match'|'no-enrichment'|'unchanged'
 *
 * @typedef {Object} BulkRefreshSummary
 * @property {number} total
 * @property {number} changed
 * @property {number} skipped
 * @property {number} failed
 * @property {RefreshResult[]} results
 */

/**
 * Find one fileRef for a series that has a usable hash16M.
 * Walks episodes → primaryFileId → fileRef; falls back to alternateFileIds.
 * Returns null if nothing usable exists (rare — series with no hashed files).
 *
 * @param {import('dexie').Dexie} db
 * @param {string} seriesId
 * @returns {Promise<FileRef|null>}
 */
async function findUsableFileRef(db, seriesId) {
  const episodes = await db.episodes.where('seriesId').equals(seriesId).toArray();
  if (!episodes.length) return null;

  const idsToTry = [];
  for (const ep of episodes) {
    if (ep.primaryFileId) idsToTry.push(ep.primaryFileId);
    if (Array.isArray(ep.alternateFileIds)) {
      for (const fid of ep.alternateFileIds) idsToTry.push(fid);
    }
  }
  if (!idsToTry.length) return null;

  const seen = new Set();
  for (const id of idsToTry) {
    if (seen.has(id)) continue;
    seen.add(id);
    const ref = await db.fileRefs.get(id);
    if (ref?.hash16M) return ref;
  }
  return null;
}

/**
 * Build the patch object from enrichment, only including fields that differ
 * from the current series record. Returns null when nothing would change.
 *
 * @param {Series} series
 * @param {DandanEnrichment} enrichment
 * @returns {{ patch: Partial<Series>, fields: string[] }|null}
 */
function diffEnrichment(series, enrichment) {
  /** @type {Partial<Series>} */
  const patch = {};
  const fields = [];
  if (enrichment.titleZh && enrichment.titleZh !== series.titleZh) {
    patch.titleZh = enrichment.titleZh;
    fields.push('titleZh');
  }
  if (enrichment.titleEn && enrichment.titleEn !== series.titleEn) {
    patch.titleEn = enrichment.titleEn;
    fields.push('titleEn');
  }
  if (enrichment.posterUrl && enrichment.posterUrl !== series.posterUrl) {
    patch.posterUrl = enrichment.posterUrl;
    fields.push('posterUrl');
  }
  return fields.length ? { patch, fields } : null;
}

/**
 * Refresh enrichment for a single series. Idempotent — calling repeatedly with
 * the same dandan response is a no-op once series is up to date.
 *
 * @param {{ db: import('dexie').Dexie, dandan: DandanClient, seriesId: string, now?: () => number }} input
 * @returns {Promise<RefreshResult>}
 */
export async function refreshSeriesMetadata(input) {
  const { db, dandan, seriesId, now = () => Date.now() } = input;

  if (typeof seriesId !== 'string' || !seriesId) {
    throw new Error('refreshSeriesMetadata: seriesId must be a non-empty string');
  }

  const series = await db.series.get(seriesId);
  if (!series) {
    throw new Error(`refreshSeriesMetadata: series ${seriesId} does not exist`);
  }

  const fileRef = await findUsableFileRef(db, seriesId);
  if (!fileRef) {
    return { seriesId, changed: false, fields: [], skipReason: 'no-fileref' };
  }
  if (!fileRef.hash16M) {
    return { seriesId, changed: false, fields: [], skipReason: 'no-hash' };
  }

  const fileName = fileRef.relPath.split('/').pop() || fileRef.relPath;
  const result = await dandan.match(fileRef.hash16M, fileName, { fileSize: fileRef.size });
  if (!result || !result.isMatched) {
    return { seriesId, changed: false, fields: [], skipReason: 'no-match' };
  }
  if (!result.enrichment) {
    return { seriesId, changed: false, fields: [], skipReason: 'no-enrichment' };
  }

  const diff = diffEnrichment(series, result.enrichment);
  if (!diff) {
    return { seriesId, changed: false, fields: [], skipReason: 'unchanged' };
  }

  await db.series.update(seriesId, { ...diff.patch, updatedAt: now() });
  return { seriesId, changed: true, fields: diff.fields };
}

/**
 * Refresh enrichment for every series in the library. Sequential by design —
 * dandanplay rate-limits and we'd rather be slow than throttled. Reports
 * progress via `onProgress` after each series so the UI can show a live
 * counter without polling.
 *
 * @param {{
 *   db: import('dexie').Dexie,
 *   dandan: DandanClient,
 *   onProgress?: (done: number, total: number, last: RefreshResult|{ seriesId: string, error: string }) => void,
 *   now?: () => number,
 * }} input
 * @returns {Promise<BulkRefreshSummary>}
 */
export async function refreshAllSeriesMetadata(input) {
  const { db, dandan, onProgress, now = () => Date.now() } = input;
  const allSeries = await db.series.toArray();

  /** @type {BulkRefreshSummary} */
  const summary = {
    total: allSeries.length,
    changed: 0,
    skipped: 0,
    failed: 0,
    results: [],
  };

  for (let i = 0; i < allSeries.length; i++) {
    const seriesId = allSeries[i].id;
    try {
      const r = await refreshSeriesMetadata({ db, dandan, seriesId, now });
      summary.results.push(r);
      if (r.changed) summary.changed++;
      else summary.skipped++;
      if (onProgress) onProgress(i + 1, allSeries.length, r);
    } catch (err) {
      summary.failed++;
      const errMsg = err instanceof Error ? err.message : String(err);
      summary.results.push({ seriesId, changed: false, fields: [], skipReason: 'error' });
      if (onProgress) onProgress(i + 1, allSeries.length, { seriesId, error: errMsg });
    }
  }

  return summary;
}
