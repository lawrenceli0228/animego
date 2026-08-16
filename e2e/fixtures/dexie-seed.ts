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
 * IndexedDB `"animego-library"` (schema v6 per
 * `next-app/src/lib/library/db/db.js`) and subscribes to
 * `db.series.orderBy('updatedAt').reverse().toArray()` via Dexie's
 * `liveQuery`.
 *
 * Playwright cannot trigger `window.showDirectoryPicker()` without a
 * real user gesture (chromium-specific footgun), so the full import
 * flow is not testable. Instead, we pre-populate the tables directly
 * via `indexedDB` in a `page.evaluate` block. `useLibrary` picks the
 * records up on next emission and renders cards through `SeriesGrid`.
 *
 * NOTE on `fileRefs` / `fileHandles`: cards render fine without a backing
 * `FileSystemDirectoryHandle`. `useSeriesLibraryStatus` joins
 * `episodes → fileRefs` by `Episode.primaryFileId`; an episode whose
 * `primaryFileId` matches no `fileRefs` row is skipped entirely, so
 * `availabilityBySeries.get(seriesId)` stays `undefined`, which the
 * LibraryShell `mainGridSeries` filter accepts (only `'offline'` /
 * `'partial'` are excluded). So we seed `episodes` without file rows and
 * the card still shows.
 */

const DB_NAME = "animego-library";

/**
 * Native IndexedDB version for the app's Dexie **v6** schema.
 *
 * Not 6 — Dexie opens at `Math.round(db.verno * 10)` (dexie 4.4.2,
 * `dist/dexie.js:4509`), so `instance.version(6)` in `db.js` lands on native
 * version **60**. Seeding at the native version Dexie is about to ask for is
 * what keeps the app's `open()` on the no-upgrade path.
 *
 * MEASURED, not assumed: seeding at native 5 (what this fixture used to do)
 * also works, because 5 < 60 triggers `upgradeneeded` and Dexie's
 * `updateTablesAndIndexes` re-runs every declared version ≥ oldVersion/10,
 * diffing against the real store layout and `addIndex`-ing everything that is
 * missing. A probe run confirmed all of `series.anilistId`,
 * `progress.[seriesId+updatedAt]`, `episodes.[seriesId+number]`,
 * `fileRefs.[libraryId+matchStatus]` and `fileRefs.libraryIds` appeared after
 * the first `/library` mount even though the seed never created them. The
 * fixture declares them anyway: relying on the upgrade diff means the seeded
 * rows are written into a schema the seed does not describe, and the failure
 * mode when that stops being true (Dexie's `verifyInstalledSchema` closes the
 * connection and silently re-opens at version+1) is a `console.warn` nobody
 * reads.
 */
const DB_VERSION = 60;

/**
 * Object-store layout that mirrors `applySchema` in `db.js`, flattened to the
 * union of v3 → v6. Every store must exist at the right `keyPath` and every
 * index Dexie declares must exist under the name Dexie generates for it:
 *
 *   'seriesId'            → index named `seriesId`
 *   '[seriesId+number]'   → index named `[seriesId+number]`, keyPath is an ARRAY
 *   '*libraryIds'         → index named `libraryIds`, `multiEntry: true`
 *
 * A mismatch is not fatal (Dexie patches it) but it is invisible, so keep this
 * in step with `db.js` by hand.
 */
interface StoreDef {
  name: string;
  keyPath: string;
  indexes: ReadonlyArray<{
    name: string;
    keyPath: string | string[];
    unique?: boolean;
    multiEntry?: boolean;
  }>;
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
    // v6: `anilistId` — the local-series ↔ AniList binding watch sync reads.
    name: "series",
    keyPath: "id",
    indexes: [
      { name: "titleZh", keyPath: "titleZh" },
      { name: "anilistId", keyPath: "anilistId" },
      { name: "updatedAt", keyPath: "updatedAt" },
    ],
  },
  {
    name: "seasons",
    keyPath: "id",
    indexes: [
      { name: "seriesId", keyPath: "seriesId" },
      { name: "animeId", keyPath: "animeId" },
      { name: "[seriesId+number]", keyPath: ["seriesId", "number"] },
    ],
  },
  {
    name: "episodes",
    keyPath: "id",
    indexes: [
      { name: "seriesId", keyPath: "seriesId" },
      { name: "seasonId", keyPath: "seasonId" },
      { name: "[seriesId+number]", keyPath: ["seriesId", "number"] },
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
      { name: "[libraryId+matchStatus]", keyPath: ["libraryId", "matchStatus"] },
      { name: "libraryIds", keyPath: "libraryIds", multiEntry: true },
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
      { name: "[seriesId+ts]", keyPath: ["seriesId", "ts"] },
      { name: "undoableUntil", keyPath: "undoableUntil" },
      { name: "ts", keyPath: "ts" },
    ],
  },
  {
    // `progressRepo.getBySeries` queries the compound index, not `seriesId`.
    name: "progress",
    keyPath: "episodeId",
    indexes: [
      { name: "seriesId", keyPath: "seriesId" },
      { name: "updatedAt", keyPath: "updatedAt" },
      { name: "[seriesId+updatedAt]", keyPath: ["seriesId", "updatedAt"] },
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

/** A `progress` row to write alongside an episode. */
export interface SeedProgressSpec {
  /** Drives `resolveHighWater` + every `completedCount` read in the UI. */
  completed?: boolean;
  positionSec?: number;
  durationSec?: number;
  /** Defaults to seed time. */
  updatedAt?: number;
}

export interface SeedEpisodeSpec {
  /** Episode number, as `episodeParser` would have produced it. */
  number: number;
  /**
   * One of the 14 `Episode.kind` values. Defaults to `'main'` — the only kind
   * that reaches the server (design doc decision 10), which makes `'ncop'`
   * here the way to assert that an opening never moves the high-water mark.
   */
  kind?: string;
  title?: string;
  /** Omit for "never played". */
  progress?: SeedProgressSpec;
}

export interface SeedSeriesSpec {
  /** Defaults to `e2e-test-series-00N`. */
  id?: string;
  titleZh?: string;
  /**
   * GOTCHA: this is the title the card actually shows. `SeriesCard.tsx:504`
   * picks `titleEn || titleZh || titleJa || id`, so a series seeded with only a
   * `titleZh` renders under whatever `titleEn` the fixture defaulted to — which
   * is why the default below falls back to `titleZh` instead of a generic name.
   */
  titleEn?: string;
  totalEpisodes?: number;
  /** The v6 binding. Omit to seed a series watch sync must skip as unbound. */
  anilistId?: number;
  /** Last value successfully pushed. Omit for "never synced". */
  lastSyncedEpisode?: number;
  episodes?: readonly SeedEpisodeSpec[];
}

export interface SeedLibraryOptions {
  /** Number of fake series to insert. Defaults to 1. Ignored when `series` is given. */
  seriesCount?: number;
  /** Explicit series definitions — takes precedence over `seriesCount`. */
  series?: readonly SeedSeriesSpec[];
}

export interface SeedLibraryResult {
  /** Primary series id — stable across runs for deterministic assertions. */
  seriesId: string;
  /** Every seeded series id, in the order they were written. */
  seriesIds: string[];
  /** seriesId → the `Episode.id` values seeded for it, in the given order. */
  episodeIds: Record<string, string[]>;
}

const PRIMARY_SERIES_ID = "e2e-test-series-001";

/** Deterministic, addressable `Episode.id` — a later mark-completed needs it. */
export function seedEpisodeId(
  seriesId: string,
  kind: string,
  number: number,
): string {
  return `${seriesId}-ep-${kind}-${number}`;
}

function defaultSeriesSpecs(count: number): SeedSeriesSpec[] {
  const out: SeedSeriesSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      id: i === 0 ? PRIMARY_SERIES_ID : `e2e-test-series-${String(i + 1).padStart(3, "0")}`,
      titleZh: i === 0 ? "E2E 测试系列" : `E2E 测试系列 ${i + 1}`,
      titleEn: i === 0 ? "E2E Test Series" : `E2E Test Series ${i + 1}`,
      totalEpisodes: 12,
    });
  }
  return out;
}

/**
 * Seed the local Dexie database on the page's origin.
 *
 * Call BEFORE the Library page opens its own Dexie connection.
 * Recommended ordering:
 *
 *   1. `await page.goto('/welcome')` — same-origin, no auth, no Dexie.
 *   2. `await seedLibrary(page, { series: [...] })`.
 *   3. `await page.goto('/library')` — picks up the seeded rows.
 *
 * @returns the seeded ids, so callers can write deterministic assertions
 * without re-deriving the naming scheme.
 */
export async function seedLibrary(
  page: Page,
  opts: SeedLibraryOptions = {},
): Promise<SeedLibraryResult> {
  const specs =
    opts.series && opts.series.length > 0
      ? opts.series.map((s, i) => ({
          ...s,
          id: s.id ?? (i === 0 ? PRIMARY_SERIES_ID : `e2e-test-series-${String(i + 1).padStart(3, "0")}`),
        }))
      : defaultSeriesSpecs(Math.max(1, opts.seriesCount ?? 1));

  // Episode ids are derived here (Node side) rather than in the page so the
  // return value is available without a second round trip.
  const episodeIds: Record<string, string[]> = {};
  for (const spec of specs) {
    episodeIds[spec.id as string] = (spec.episodes ?? []).map((ep) =>
      seedEpisodeId(spec.id as string, ep.kind ?? "main", ep.number),
    );
  }

  await page.evaluate(
    async ({
      dbName,
      dbVersion,
      storeDefs,
      seriesSpecs,
    }: {
      dbName: string;
      dbVersion: number;
      storeDefs: ReadonlyArray<StoreDef>;
      seriesSpecs: ReadonlyArray<SeedSeriesSpec>;
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
                multiEntry: idx.multiEntry ?? false,
              });
            }
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      const now = Date.now();
      const seriesRows: Array<Record<string, unknown>> = [];
      const episodeRows: Array<Record<string, unknown>> = [];
      const progressRows: Array<Record<string, unknown>> = [];

      seriesSpecs.forEach((spec, i) => {
        const seriesId = spec.id as string;
        const row: Record<string, unknown> = {
          id: seriesId,
          titleZh: spec.titleZh ?? `E2E 测试系列 ${i + 1}`,
          titleEn: spec.titleEn ?? spec.titleZh ?? `E2E Test Series ${i + 1}`,
          type: "tv",
          posterUrl: "",
          totalEpisodes: spec.totalEpisodes ?? 12,
          confidence: 1.0,
          createdAt: now - i * 1000,
          updatedAt: now - i * 1000,
        };
        // Written only when asked: an `anilistId: undefined` key would still
        // land in the record and an index entry on `undefined` is not the
        // same thing as "this series was never bound".
        if (typeof spec.anilistId === "number") row.anilistId = spec.anilistId;
        if (typeof spec.lastSyncedEpisode === "number") {
          row.lastSyncedEpisode = spec.lastSyncedEpisode;
        }
        seriesRows.push(row);

        for (const ep of spec.episodes ?? []) {
          const kind = ep.kind ?? "main";
          const epId = `${seriesId}-ep-${kind}-${ep.number}`;
          episodeRows.push({
            id: epId,
            seriesId,
            number: ep.number,
            kind,
            title: ep.title ?? "",
            // Deliberately points at no fileRefs row — see the file header:
            // an unmatched primaryFileId keeps the card out of the
            // 'offline'/'partial' filter instead of hiding it.
            primaryFileId: `${epId}-file`,
            alternateFileIds: [],
            version: 1,
            updatedAt: now,
          });
          if (!ep.progress) continue;
          progressRows.push({
            episodeId: epId,
            seriesId,
            positionSec: ep.progress.positionSec ?? 0,
            durationSec: ep.progress.durationSec ?? 1440,
            updatedAt: ep.progress.updatedAt ?? now,
            completed: ep.progress.completed === true,
          });
        }
      });

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["series", "episodes", "progress"], "readwrite");
        for (const rec of seriesRows) tx.objectStore("series").put(rec);
        for (const rec of episodeRows) tx.objectStore("episodes").put(rec);
        for (const rec of progressRows) tx.objectStore("progress").put(rec);
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
      seriesSpecs: specs,
    },
  );

  return {
    seriesId: specs[0]?.id ?? PRIMARY_SERIES_ID,
    seriesIds: specs.map((s) => s.id as string),
    episodeIds,
  };
}

/**
 * Write `progress` rows into an ALREADY-OPEN database, without touching the
 * schema. `seedLibrary` deletes the whole DB first, which is exactly wrong
 * once the app holds a connection; this opens at the current version instead
 * (`indexedDB.open(name)` with no version never upgrades and never blocks).
 *
 * Raw IDB writes are invisible to Dexie's `liveQuery` — that observability
 * layer only sees mutations made through Dexie. A page load after this call is
 * therefore required for the app to notice, which is the point when the
 * scenario is "the user finished an episode while the tab was offline".
 */
export async function writeProgress(
  page: Page,
  rows: ReadonlyArray<{
    episodeId: string;
    seriesId: string;
    completed?: boolean;
    positionSec?: number;
    durationSec?: number;
  }>,
): Promise<void> {
  await page.evaluate(
    async ({ dbName, rows: input }: { dbName: string; rows: typeof rows }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const now = Date.now();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("progress", "readwrite");
        const store = tx.objectStore("progress");
        for (const r of input) {
          store.put({
            episodeId: r.episodeId,
            seriesId: r.seriesId,
            positionSec: r.positionSec ?? 1300,
            durationSec: r.durationSec ?? 1440,
            updatedAt: now,
            completed: r.completed === true,
          });
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    },
    { dbName: DB_NAME, rows },
  );
}

/**
 * Read one `series` row back out. Used to assert on `lastSyncedEpisode`, the
 * client half of the no-queue reconciliation contract (design doc decision 5).
 */
export async function readSeriesRow(
  page: Page,
  seriesId: string,
): Promise<Record<string, unknown> | null> {
  return page.evaluate(
    async ({ dbName, id }: { dbName: string; id: string }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const row = await new Promise<Record<string, unknown> | null>((resolve) => {
        const tx = db.transaction("series", "readonly");
        const get = tx.objectStore("series").get(id);
        get.onsuccess = () => resolve((get.result as Record<string, unknown>) ?? null);
        get.onerror = () => resolve(null);
      });
      db.close();
      return row;
    },
    { dbName: DB_NAME, id: seriesId },
  );
}

/**
 * Dump the installed IndexedDB schema (version + per-store indexes).
 *
 * Exists because "did the seed's schema survive contact with Dexie" is not
 * something to assume — see the DB_VERSION note above.
 */
export async function readDbSchema(page: Page): Promise<{
  version: number;
  stores: Record<string, { keyPath: unknown; indexes: string[] }>;
}> {
  return page.evaluate(async ({ dbName }: { dbName: string }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const names = Array.from(db.objectStoreNames);
    const stores: Record<string, { keyPath: unknown; indexes: string[] }> = {};
    if (names.length > 0) {
      const tx = db.transaction(names, "readonly");
      for (const n of names) {
        const st = tx.objectStore(n);
        stores[n] = { keyPath: st.keyPath, indexes: Array.from(st.indexNames) };
      }
    }
    const version = db.version;
    db.close();
    return { version, stores };
  }, { dbName: DB_NAME });
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
