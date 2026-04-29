// @ts-check
// Pure data layer — no React, no DOM.

/** Maximum number of cache entries before oldest are evicted. */
export const MAX_ENTRIES = 2000;

/** Default TTL for cache entries: 7 days in milliseconds. */
export const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * Create a matchCacheRepo bound to the given Dexie database instance.
 *
 * @param {import('dexie').Dexie} db
 * @param {{ now?: () => number }} [opts] - Inject clock for testing.
 * @returns {{
 *   get(hash16M: string, opts?: { ttlMs?: number }): Promise<any|null>,
 *   put(hash16M: string, verdict: any): Promise<void>
 * }}
 */
export function makeMatchCacheRepo(db, { now = () => Date.now() } = {}) {
  /**
   * Retrieve a cached verdict, or null if missing or expired.
   *
   * @param {string} hash16M
   * @param {{ ttlMs?: number }} [opts]
   * @returns {Promise<any|null>}
   */
  async function get(hash16M, opts = {}) {
    const { ttlMs = DEFAULT_TTL_MS } = opts;
    const entry = await db.matchCache.get(hash16M);
    if (!entry) return null;

    const age = now() - entry.updatedAt;
    if (age > ttlMs) return null;

    return entry.verdict;
  }

  /**
   * Store a verdict and evict oldest entries when count exceeds MAX_ENTRIES.
   *
   * @param {string} hash16M
   * @param {any} verdict
   * @returns {Promise<void>}
   */
  async function put(hash16M, verdict) {
    await db.matchCache.put({ hash16M, verdict, updatedAt: now() });

    const count = await db.matchCache.count();
    if (count > MAX_ENTRIES) {
      const excess = count - MAX_ENTRIES;
      // Collect oldest entries by updatedAt ascending
      const toDelete = await db.matchCache
        .orderBy('updatedAt')
        .limit(excess)
        .primaryKeys();
      await db.matchCache.bulkDelete(toDelete);
    }
  }

  return { get, put };
}
