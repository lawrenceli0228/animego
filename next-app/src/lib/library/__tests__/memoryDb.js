// In-memory stand-in for the slice of the Dexie API the import pipeline, the
// rescan service and the repositories use. Rows are cloned on the way in and
// out, as IndexedDB does, so a test cannot pass by mutating a returned row.
//
// Test helper only — not a test file (bun collects *.test.js).

const clone = (row) => structuredClone(row);

function memoryTable(seedRows = [], key = "id") {
  const rows = new Map(seedRows.map((row) => [row[key], clone(row)]));
  return {
    /** Live view for assertions. */
    rows,
    toArray: async () => [...rows.values()].map(clone),
    get: async (id) => (rows.has(id) ? clone(rows.get(id)) : undefined),
    put: async (row) => {
      rows.set(row[key], clone(row));
    },
    bulkPut: async (list) => {
      for (const row of list) rows.set(row[key], clone(row));
    },
    update: async (id, patch) => {
      if (!rows.has(id)) return 0;
      rows.set(id, { ...rows.get(id), ...clone(patch) });
      return 1;
    },
    count: async () => rows.size,
    bulkDelete: async (ids) => {
      for (const id of ids) rows.delete(id);
    },
    where: (field) => ({
      equals: (value) => ({
        toArray: async () =>
          [...rows.values()].filter((row) => row[field] === value).map(clone),
      }),
    }),
  };
}

/**
 * @param {{
 *   series?: any[], seasons?: any[], episodes?: any[], fileRefs?: any[],
 *   matchCache?: any[], userOverride?: any[],
 * }} [seed]
 */
export function memoryDb(seed = {}) {
  return {
    series: memoryTable(seed.series),
    seasons: memoryTable(seed.seasons),
    episodes: memoryTable(seed.episodes),
    fileRefs: memoryTable(seed.fileRefs),
    matchCache: memoryTable(seed.matchCache, "hash16M"),
    userOverride: memoryTable(seed.userOverride, "seriesId"),
    transaction: async (_mode, _tables, fn) => fn(),
  };
}

/** dandanplay client that records every call and never identifies anything. */
export function recordingDandan() {
  const calls = [];
  return {
    calls,
    match: async (...args) => {
      calls.push(args);
      return null;
    },
  };
}
