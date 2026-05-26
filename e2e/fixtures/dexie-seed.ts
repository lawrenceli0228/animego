/// <reference lib="dom" />
// The `indexedDB` / `IDBDatabase` references below all execute inside
// `page.evaluate` (Chromium context, not Node). The tsconfig only
// ships `lib: ["ESNext"]` so we opt this single file into DOM types.

import type { Page } from "@playwright/test";

/**
 * Dexie seed helper for sandbox E2E.
 *
 * The Next.js Library page (`next-app/src/app/library/page.tsx`) loads
 * Dexie inside a `dynamic({ ssr: false })` shell. The shell opens
 * IndexedDB `"animego-library"` (schema v5 per
 * `next-app/src/lib/library/db/db.js`) and subscribes to
 * `db.series.orderBy('updatedAt').reverse().toArray()` via Dexie's
 * `liveQuery`.
 *
 * Playwright cannot trigger `window.showDirectoryPicker()` without a
 * real user gesture (chromium-specific footgun), so the full import
 * flow is not testable. Instead, we pre-populate the `series` table
 * directly via `indexedDB` in a `page.evaluate` block. `useLibrary`
 * picks the records up on next emission and renders cards through
 * `SeriesGrid`.
 *
 * NOTE on `fileHandles`: cards render fine without a corresponding
 * `FileSystemDirectoryHandle`. `useSeriesLibraryStatus` joins
 * `episodes → fileRefs` to compute per-series availability; an empty
 * join means `availabilityBySeries.get(seriesId)` returns `undefined`,
 * which the LibraryShell `mainGridSeries` filter accepts (only
 * `'offline'` / `'partial'` are excluded). So we deliberately skip
 * seeding `episodes` / `fileRefs` / `fileHandles` here — the empty
 * state is the simplest path to a visible card.
 *
 * v2.2 TODO: if the assertions ever fail because LibraryShell starts
 * rejecting series without backing file handles, extend `seedLibrary`
 * to also write to `episodes` + `fileRefs`. The shapes are documented
 * in `next-app/src/lib/library/types.js` (Episode, FileRef).
 */

const DB_NAME = "animego-library";
const DB_VERSION = 5;

/**
 * Object-store layout that mirrors `applySchema` in `db.js`. We must
 * create every store at the right `keyPath` because once Dexie opens
 * the database at v5, it will NOT re-run upgrades — it will just see
 * the existing stores. Indexes are intentionally minimal: we only
 * need the ones `useLibrary` reads from (`updatedAt`).
 */
interface StoreDef {
  name: string;
  keyPath: string;
  indexes: ReadonlyArray<{ name: string; keyPath: string | string[]; unique?: boolean }>;
}

const STORE_DEFS: ReadonlyArray<StoreDef> = [
  {
    name: "libraries",
    keyPath: "id",
    indexes: [
      { name: "name", keyPath: "name" },
      { name: "updatedAt", keyPath: "updatedAt" },
    ],
  },
  {
    name: "series",
    keyPath: "id",
    indexes: [
      { name: "titleZh", keyPath: "titleZh" },
      { name: "updatedAt", keyPath: "updatedAt" },
    ],
  },
  {
    name: "seasons",
    keyPath: "id",
    indexes: [
      { name: "seriesId", keyPath: "seriesId" },
      { name: "animeId", keyPath: "animeId" },
    ],
  },
  {
    name: "episodes",
    keyPath: "id",
    indexes: [
      { name: "seriesId", keyPath: "seriesId" },
      { name: "seasonId", keyPath: "seasonId" },
      { name: "episodeId", keyPath: "episodeId" },
    ],
  },
  {
    name: "fileRefs",
    keyPath: "id",
    indexes: [
      { name: "episodeId", keyPath: "episodeId" },
      { name: "hash16M", keyPath: "hash16M" },
      { name: "matchStatus", keyPath: "matchStatus" },
    ],
  },
  {
    name: "matchCache",
    keyPath: "hash16M",
    indexes: [{ name: "updatedAt", keyPath: "updatedAt" }],
  },
  {
    name: "fileHandles",
    keyPath: "id",
    indexes: [{ name: "libraryId", keyPath: "libraryId" }],
  },
  {
    name: "opsLog",
    keyPath: "id",
    indexes: [
      { name: "undoableUntil", keyPath: "undoableUntil" },
      { name: "ts", keyPath: "ts" },
    ],
  },
  {
    name: "progress",
    keyPath: "episodeId",
    indexes: [
      { name: "seriesId", keyPath: "seriesId" },
      { name: "updatedAt", keyPath: "updatedAt" },
    ],
  },
  {
    name: "userOverride",
    keyPath: "seriesId",
    indexes: [{ name: "updatedAt", keyPath: "updatedAt" }],
  },
  {
    name: "migrationFailures",
    keyPath: "key",
    indexes: [{ name: "attemptedAt", keyPath: "attemptedAt" }],
  },
];

export interface SeedLibraryOptions {
  /** Number of fake series to insert. Defaults to 1. */
  seriesCount?: number;
}

export interface SeedLibraryResult {
  /** Primary series id — stable across runs for deterministic assertions. */
  seriesId: string;
}

const PRIMARY_SERIES_ID = "e2e-test-series-001";

/**
 * Seed the local Dexie database on the page's origin.
 *
 * Call BEFORE the Library page opens its own Dexie connection.
 * Recommended ordering:
 *
 *   1. `await page.goto('/welcome')` — same-origin, no auth, no Dexie.
 *   2. `await seedLibrary(page)`.
 *   3. `await page.goto('/library')` — picks up the seeded rows.
 *
 * @returns The primary series id so callers can write deterministic
 * assertions (`page.locator(\`[data-series-id="\${seriesId}"]\`)` if
 * the card surface gets a data attribute later — today the card root
 * uses `data-testid="series-card-root"` without per-id qualifier).
 */
export async function seedLibrary(
  page: Page,
  opts: SeedLibraryOptions = {},
): Promise<SeedLibraryResult> {
  const seriesCount = Math.max(1, opts.seriesCount ?? 1);

  await page.evaluate(
    async ({
      dbName,
      dbVersion,
      storeDefs,
      seriesCount: count,
      primaryId,
    }: {
      dbName: string;
      dbVersion: number;
      storeDefs: ReadonlyArray<StoreDef>;
      seriesCount: number;
      primaryId: string;
    }) => {
      // Delete any pre-existing DB so we start from a known schema.
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase(dbName);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () =>
          reject(new Error("indexedDB.deleteDatabase blocked"));
      });

      // Open at the target version + create every store Dexie expects.
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName, dbVersion);
        req.onupgradeneeded = () => {
          const opened = req.result;
          for (const def of storeDefs) {
            if (opened.objectStoreNames.contains(def.name)) continue;
            const store = opened.createObjectStore(def.name, {
              keyPath: def.keyPath,
            });
            for (const idx of def.indexes) {
              store.createIndex(idx.name, idx.keyPath as string, {
                unique: idx.unique ?? false,
              });
            }
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      const now = Date.now();
      const records: Array<Record<string, unknown>> = [];
      for (let i = 0; i < count; i += 1) {
        const id = i === 0 ? primaryId : `e2e-test-series-${String(i + 1).padStart(3, "0")}`;
        records.push({
          id,
          titleZh: i === 0 ? "E2E 测试系列" : `E2E 测试系列 ${i + 1}`,
          titleEn: i === 0 ? "E2E Test Series" : `E2E Test Series ${i + 1}`,
          type: "tv",
          posterUrl: "",
          totalEpisodes: 12,
          confidence: 1.0,
          createdAt: now - i * 1000,
          updatedAt: now - i * 1000,
        });
      }

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("series", "readwrite");
        const store = tx.objectStore("series");
        for (const rec of records) {
          store.put(rec);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });

      db.close();
    },
    {
      dbName: DB_NAME,
      dbVersion: DB_VERSION,
      storeDefs: STORE_DEFS,
      seriesCount,
      primaryId: PRIMARY_SERIES_ID,
    },
  );

  return { seriesId: PRIMARY_SERIES_ID };
}

/**
 * Wipe the Dexie database. Useful between tests when a context is reused.
 */
export async function clearLibrary(page: Page): Promise<void> {
  await page.evaluate(
    async ({ dbName }: { dbName: string }) => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase(dbName);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => resolve(); // best-effort; not fatal
      });
    },
    { dbName: DB_NAME },
  );
}
