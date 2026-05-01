// @ts-check
// Pure data layer — no React, no DOM.
/** @typedef {import('../types').OpsLog} OpsLog */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {Partial<OpsLog>} entry
 */
function validate(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('opsLogRepo.append: entry must be an object');
  }
  if (typeof entry.seriesId !== 'string' || !entry.seriesId) {
    throw new Error('opsLogRepo.append: seriesId is required');
  }
  if (typeof entry.kind !== 'string' || !entry.kind) {
    throw new Error('opsLogRepo.append: kind is required');
  }
  const allowed = ['merge', 'split', 'rematch', 'unfile', 'delete'];
  if (!allowed.includes(entry.kind)) {
    throw new Error(`opsLogRepo.append: unknown kind "${entry.kind}"`);
  }
  if (entry.payload != null && typeof entry.payload !== 'object') {
    throw new Error('opsLogRepo.append: payload must be an object when present');
  }
}

/**
 * Create an opsLog repo bound to the given Dexie database (v4+).
 *
 * Conventions:
 *   - `id` is auto-assigned (caller passes a `makeId` factory; defaults to ulid-shaped string).
 *   - `ts` is auto-assigned from injected clock unless caller pre-fills.
 *   - `undoableUntil = ts + 24h` unless caller overrides.
 *   - `undone` defaults to false; flips to true via `markUndone(id)`.
 *
 * Why this layer exists:
 *   §5.6 demands a 24h undo window AND a series-detail "recent ops" log. Both are
 *   the same record set, just queried two ways: by id (toast undo) and by
 *   `[seriesId+ts]` index (detail page log). Keeping the write path here means
 *   merge/split/rematch services share one snapshot format.
 *
 * @param {import('dexie').Dexie} db
 * @param {{
 *   now?: () => number,
 *   makeId?: () => string,
 *   undoWindowMs?: number,
 * }} [opts]
 */
export function makeOpsLogRepo(db, {
  now = () => Date.now(),
  makeId = () => `op_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`,
  undoWindowMs = DAY_MS,
} = {}) {
  /**
   * Append a new ops log entry. Returns the persisted record.
   * @param {Partial<OpsLog> & { seriesId: string, kind: OpsLog['kind'], payload?: Record<string, unknown> }} entry
   * @returns {Promise<OpsLog>}
   */
  async function append(entry) {
    validate(entry);
    const ts = typeof entry.ts === 'number' ? entry.ts : now();
    /** @type {OpsLog} */
    const row = {
      id: entry.id ?? makeId(),
      seriesId: entry.seriesId,
      ts,
      kind: entry.kind,
      payload: entry.payload ?? {},
      summary: entry.summary,
      undoableUntil: entry.undoableUntil ?? ts + undoWindowMs,
      undone: entry.undone ?? false,
    };
    await db.opsLog.put(row);
    return row;
  }

  /**
   * Lookup by id. Returns null when absent.
   * @param {string} id
   * @returns {Promise<OpsLog|null>}
   */
  async function get(id) {
    const row = await db.opsLog.get(id);
    return row ?? null;
  }

  /**
   * Recent entries for one series, newest first. Includes already-undone entries
   * so the detail page can render history; UI filters as needed.
   * @param {string} seriesId
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<OpsLog[]>}
   */
  async function listForSeries(seriesId, { limit = 50 } = {}) {
    const rows = await db.opsLog
      .where('[seriesId+ts]')
      .between([seriesId, -Infinity], [seriesId, Infinity])
      .reverse()
      .limit(limit)
      .toArray();
    return rows;
  }

  /**
   * Mark an entry as undone (idempotent — repeat calls are no-ops).
   * Throws if the entry is missing or already past `undoableUntil`.
   * @param {string} id
   * @returns {Promise<OpsLog>}
   */
  async function markUndone(id) {
    return db.transaction('rw', db.opsLog, async () => {
      const row = await db.opsLog.get(id);
      if (!row) throw new Error(`opsLogRepo.markUndone: id "${id}" not found`);
      if (row.undone) return row;
      const t = now();
      if (typeof row.undoableUntil === 'number' && t > row.undoableUntil) {
        throw new Error(`opsLogRepo.markUndone: undo window expired for "${id}"`);
      }
      const updated = { ...row, undone: true };
      await db.opsLog.put(updated);
      return updated;
    });
  }

  /**
   * Garbage-collect entries past their `undoableUntil`. Returns deleted count.
   * Cheap to call on app start.
   * @returns {Promise<number>}
   */
  async function gc() {
    const cutoff = now();
    const rows = await db.opsLog
      .where('undoableUntil')
      .below(cutoff)
      .toArray();
    if (rows.length === 0) return 0;
    await db.opsLog.bulkDelete(rows.map((r) => r.id));
    return rows.length;
  }

  return { append, get, listForSeries, markUndone, gc };
}
