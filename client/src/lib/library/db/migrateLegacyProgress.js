// @ts-check
// One-shot migration of legacy localStorage progress (`animego:progress:<id>:<ep>`)
// into the v5 `progress` IDB table. Idempotent — successful migrations remove the
// legacy key; failures are recorded in `migrationFailures` and the legacy key is
// preserved for future retries.

/**
 * Matches `animego:progress:<animeId>:<episodeNum>` exactly.
 * id and ep are positive integers as written by the legacy player.
 */
export const LEGACY_KEY_RE = /^animego:progress:(\d+):(\d+)$/;

/** @typedef {{ getItem(k:string):string|null, setItem(k:string,v:string):void, removeItem(k:string):void, length:number, key(i:number):string|null }} StorageLike */

/**
 * @param {StorageLike} storage
 * @returns {string[]}
 */
function listLegacyKeys(storage) {
  const out = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && LEGACY_KEY_RE.test(k)) out.push(k);
  }
  return out;
}

/**
 * Resolve a legacy `(animeId, epNum)` pair to a concrete `episodeId` via
 * Season.animeId → Episode[seriesId+number]. Returns null when not yet imported.
 *
 * @param {import('dexie').Dexie} db
 * @param {number} animeId
 * @param {number} epNum
 * @returns {Promise<{ episodeId: string, seriesId: string }|null>}
 */
async function resolveEpisode(db, animeId, epNum) {
  const season = await db.seasons.where('animeId').equals(animeId).first();
  if (!season) return null;
  const episode = await db.episodes
    .where('[seriesId+number]')
    .equals([season.seriesId, epNum])
    .first();
  if (!episode) return null;
  return { episodeId: episode.id, seriesId: season.seriesId };
}

/**
 * Record (or update) a migration failure entry. Increments `attempts` on retry.
 *
 * @param {import('dexie').Dexie} db
 * @param {string} key
 * @param {string} reason
 * @param {unknown} payload
 * @param {number} now
 */
async function recordFailure(db, key, reason, payload, now) {
  const existing = await db.migrationFailures.get(key);
  await db.migrationFailures.put({
    key,
    reason,
    payload,
    attemptedAt: now,
    attempts: (existing?.attempts ?? 0) + 1,
  });
}

/**
 * Walk localStorage, migrate each legacy progress key into the v5 IDB schema.
 * @param {{
 *   db: import('dexie').Dexie,
 *   storage?: StorageLike,
 *   now?: () => number
 * }} opts
 * @returns {Promise<{ total: number, migrated: number, failed: number }>}
 */
export async function migrateLegacyProgress({
  db,
  storage = typeof localStorage !== 'undefined' ? localStorage : undefined,
  now = () => Date.now(),
}) {
  if (!storage) {
    return { total: 0, migrated: 0, failed: 0 };
  }

  const keys = listLegacyKeys(storage);
  let migrated = 0;
  let failed = 0;

  for (const key of keys) {
    const raw = storage.getItem(key);
    if (raw == null) continue;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      await recordFailure(db, key, `parse error: ${err instanceof Error ? err.message : String(err)}`, raw, now());
      failed++;
      continue;
    }

    if (!parsed || typeof parsed.t !== 'number' || !Number.isFinite(parsed.t) || parsed.t < 0) {
      await recordFailure(db, key, 'missing or invalid t (positionSec)', parsed, now());
      failed++;
      continue;
    }

    const m = key.match(LEGACY_KEY_RE);
    if (!m) continue; // listLegacyKeys already filtered; defensive
    const animeId = Number(m[1]);
    const epNum = Number(m[2]);

    const resolved = await resolveEpisode(db, animeId, epNum);
    if (!resolved) {
      await recordFailure(db, key, 'no-matching-episode (anime/episode not yet imported)', { animeId, epNum, t: parsed.t, savedAt: parsed.savedAt }, now());
      failed++;
      continue;
    }

    // durationSec=0 sentinel — legacy format never recorded duration.
    // Player will overwrite on first play.
    await db.progress.put({
      episodeId: resolved.episodeId,
      seriesId: resolved.seriesId,
      positionSec: parsed.t,
      durationSec: 0,
      completed: false,
      updatedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : now(),
    });
    // Drop the failure marker if we previously recorded one for this key.
    await db.migrationFailures.delete(key);
    storage.removeItem(key);
    migrated++;
  }

  return { total: keys.length, migrated, failed };
}
