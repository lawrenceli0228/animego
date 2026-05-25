// @ts-check
// Pure data layer — no React, no DOM.
/** @typedef {import('../types').UserOverride} UserOverride */

/**
 * Validate a UserOverride before write. Throws on bad input.
 * @param {Partial<UserOverride>} o
 */
function validate(o) {
  if (!o || typeof o !== 'object') {
    throw new Error('userOverrideRepo.put: override must be an object');
  }
  if (typeof o.seriesId !== 'string' || !o.seriesId) {
    throw new Error('userOverrideRepo.put: seriesId is required');
  }
  if (o.overrideSeasonAnimeId !== undefined) {
    const v = o.overrideSeasonAnimeId;
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      throw new Error(
        'userOverrideRepo.put: overrideSeasonAnimeId must be a positive integer',
      );
    }
  }
  if (o.mergedFrom !== undefined) {
    if (
      !Array.isArray(o.mergedFrom) ||
      !o.mergedFrom.every((s) => typeof s === 'string' && s.length > 0)
    ) {
      throw new Error(
        'userOverrideRepo.put: mergedFrom must be an array of non-empty strings',
      );
    }
  }
}

/**
 * Create a userOverrideRepo bound to the given Dexie database instance (v5+).
 *
 * UserOverride records persist the user's manual decisions about a series:
 *   - lock the current match (don't re-match on next import)
 *   - force a specific dandanplay animeId
 *   - record merge/split history
 *
 * Last-write-wins on seriesId (the table's primary key).
 *
 * @param {import('dexie').Dexie} db
 * @param {{ now?: () => number }} [opts]
 * @returns {{
 *   get(seriesId: string): Promise<UserOverride|null>,
 *   put(override: Partial<UserOverride>): Promise<void>,
 *   update(seriesId: string, partial: Partial<UserOverride>): Promise<UserOverride>,
 *   delete(seriesId: string): Promise<void>,
 *   getMany(seriesIds: string[]): Promise<Map<string, UserOverride>>,
 *   list(): Promise<UserOverride[]>,
 * }}
 */
export function makeUserOverrideRepo(db, { now = () => Date.now() } = {}) {
  /** @param {string} seriesId */
  async function get(seriesId) {
    const rec = await db.userOverride.get(seriesId);
    return rec ?? null;
  }

  /**
   * Upsert. Caller-supplied `updatedAt` is preserved if present; otherwise the
   * injected clock fills it in. Validation runs before any IDB write.
   * @param {Partial<UserOverride>} override
   */
  async function put(override) {
    validate(override);
    const updatedAt =
      typeof override.updatedAt === 'number' ? override.updatedAt : now();
    await db.userOverride.put({ ...override, updatedAt });
  }

  /**
   * Atomic read-merge-write. Creates a new record if none exists.
   * Returns the merged record so callers can update local state without a re-read.
   * @param {string} seriesId
   * @param {Partial<UserOverride>} partial
   */
  async function update(seriesId, partial) {
    return db.transaction('rw', db.userOverride, async () => {
      const existing = await db.userOverride.get(seriesId);
      const merged = {
        ...(existing ?? {}),
        ...partial,
        seriesId,
        updatedAt: now(),
      };
      validate(merged);
      await db.userOverride.put(merged);
      return merged;
    });
  }

  /** @param {string} seriesId */
  async function del(seriesId) {
    await db.userOverride.delete(seriesId);
  }

  /**
   * Bulk lookup. Missing keys are omitted from the returned Map (callers can
   * use `map.has(id)` to detect absence cleanly).
   * @param {string[]} seriesIds
   */
  async function getMany(seriesIds) {
    /** @type {Map<string, UserOverride>} */
    const out = new Map();
    if (!seriesIds || seriesIds.length === 0) return out;
    const rows = await db.userOverride.bulkGet(seriesIds);
    for (let i = 0; i < seriesIds.length; i++) {
      const rec = rows[i];
      if (rec) out.set(seriesIds[i], rec);
    }
    return out;
  }

  /** All overrides, newest first. */
  async function list() {
    return db.userOverride.orderBy('updatedAt').reverse().toArray();
  }

  return { get, put, update, delete: del, getMany, list };
}
