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

/**
 * A `fileRefs` row to write alongside an episode.
 *
 * Only worth seeding when something has to resolve the file itself — the
 * player's `getFile(episodeId)` walks `Episode.primaryFileId → FileRef →
 * FileSystemDirectoryHandle`, and a missing FileRef stops it at the first hop.
 * Cards render without one (see the `fileRefs` note in the file header), so
 * every spec that only needs a card should keep leaving it out.
 */
export interface SeedFileRefSpec {
  /** Must match a `fileHandles` row's `libraryId` — see `seedOpfsLibraryRoot`. */
  libraryId: string;
  /** Path relative to the library root, e.g. `"Season2/ep13.mp4"`. */
  relPath: string;
  size?: number;
  mtime?: number;
}

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
  /** Omit unless a caller has to resolve the actual file. */
  fileRef?: SeedFileRefSpec;
}

/**
 * A `seasons` row.
 *
 * The one field that matters is `animeId`: `buildGroupTotals` folds a merged
 * card's members by their season identity before summing, and a member it
 * cannot identify is deliberately treated as a duplicate of one already
 * counted. So a merged card seeded WITHOUT season rows reports no group total
 * at all, and the detail sheet falls back to sizing its grid from the files.
 * Both are real states; seed seasons when the spec is about the branch that
 * trusts a declared total.
 */
export interface SeedSeasonSpec {
  /** S1 / S2. Only used to pick a member's primary season deterministically. */
  number: number;
  /** dandanplay's per-season id. Distinct ids are what make two members sum. */
  animeId: number;
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
  /**
   * Cover URL, as the dandanplay match writes it. Defaults to "" — which is a
   * blind spot worth naming: with no poster, `SeriesCard`'s `safePoster` guard
   * resolves to null and the card renders its monogram fallback, so the page
   * makes NO image request at all. Every library spec was therefore green
   * through the 3.13.0 next/image migration that left /library rendering 26
   * empty cards and 115 console 400s.
   *
   * Seed a real URL to exercise the image path. Use a NON-AniList host: the
   * whole point is that these covers come from wherever the match returned,
   * and `remotePatterns` only allows s4.anilist.co, so a call site that
   * forgets `unoptimized` 400s here and silently renders nothing.
   */
  posterUrl?: string;
  totalEpisodes?: number;
  /** The v6 binding. Omit to seed a series watch sync must skip as unbound. */
  anilistId?: number;
  /** Last value successfully pushed. Omit for "never synced". */
  lastSyncedEpisode?: number;
  episodes?: readonly SeedEpisodeSpec[];
  /** `seasons` rows for this series. See `SeedSeasonSpec`. */
  seasons?: readonly SeedSeasonSpec[];
  /**
   * Series ids soft-merged INTO this one — written as this series'
   * `userOverride.mergedFrom`, which is the only record a merge leaves.
   *
   * `performMerge` never moves an episode row, so the merged-in sources keep
   * their own `series` / `episodes` / `progress` rows and must still be seeded
   * normally. `useLibrary` then hides them from the grid, which is what makes
   * one card out of several rows — and what made issue #75 able to hide half a
   * card's episodes without hiding the card.
   */
  mergedFrom?: readonly string[];
  /**
   * The series this one was SPLIT OUT OF — written as this series'
   * `userOverride.splitFrom`, exactly as `splitSeries` records it.
   *
   * One-directional on purpose, because that is how the real thing stores it:
   * only the new row knows its lineage. Anything deciding whether a pair may
   * be re-merged has to look both ways round, and a fixture that recorded it
   * on both rows would hide a guard that only checked one.
   */
  splitFrom?: string;
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
      const seasonRows: Array<Record<string, unknown>> = [];
      const fileRefRows: Array<Record<string, unknown>> = [];
      const overrideRows: Array<Record<string, unknown>> = [];

      seriesSpecs.forEach((spec, i) => {
        const seriesId = spec.id as string;
        const row: Record<string, unknown> = {
          id: seriesId,
          titleZh: spec.titleZh ?? `E2E 测试系列 ${i + 1}`,
          titleEn: spec.titleEn ?? spec.titleZh ?? `E2E Test Series ${i + 1}`,
          type: "tv",
          posterUrl: spec.posterUrl ?? "",
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

        if (typeof spec.splitFrom === "string" && spec.splitFrom) {
          overrideRows.push({
            seriesId,
            splitFrom: spec.splitFrom,
            updatedAt: now,
          });
        }

        if (spec.mergedFrom && spec.mergedFrom.length > 0) {
          overrideRows.push({
            seriesId,
            mergedFrom: [...spec.mergedFrom],
            updatedAt: now,
          });
        }

        (spec.seasons ?? []).forEach((season, si) => {
          seasonRows.push({
            id: `${seriesId}-season-${season.number}`,
            seriesId,
            number: season.number,
            animeId: season.animeId,
            updatedAt: now - si,
          });
        });

        for (const ep of spec.episodes ?? []) {
          const kind = ep.kind ?? "main";
          const epId = `${seriesId}-ep-${kind}-${ep.number}`;
          episodeRows.push({
            id: epId,
            seriesId,
            number: ep.number,
            kind,
            title: ep.title ?? "",
            // Points at a fileRefs row only when the spec asked for one — see
            // the file header: an unmatched primaryFileId keeps the card out
            // of the 'offline'/'partial' filter instead of hiding it.
            primaryFileId: `${epId}-file`,
            alternateFileIds: [],
            version: 1,
            updatedAt: now,
          });
          if (ep.fileRef) {
            fileRefRows.push({
              id: `${epId}-file`,
              libraryId: ep.fileRef.libraryId,
              libraryIds: [ep.fileRef.libraryId],
              episodeId: epId,
              relPath: ep.fileRef.relPath,
              size: ep.fileRef.size ?? 1024,
              mtime: ep.fileRef.mtime ?? now,
              // 'manual' rather than 'matched': nothing here went through
              // dandanplay, and claiming otherwise would misrepresent the
              // fixture to any surface that branches on match provenance.
              matchStatus: "manual",
            });
          }
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
        const tx = db.transaction(
          ["series", "episodes", "progress", "seasons", "fileRefs", "userOverride"],
          "readwrite",
        );
        for (const rec of seriesRows) tx.objectStore("series").put(rec);
        for (const rec of episodeRows) tx.objectStore("episodes").put(rec);
        for (const rec of progressRows) tx.objectStore("progress").put(rec);
        for (const rec of seasonRows) tx.objectStore("seasons").put(rec);
        for (const rec of fileRefRows) tx.objectStore("fileRefs").put(rec);
        for (const rec of overrideRows) tx.objectStore("userOverride").put(rec);
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
 * Read one row back out, keyed by series id.
 *
 * Defaults to `series` — the original use, asserting on `lastSyncedEpisode`,
 * the client half of the no-queue reconciliation contract (design doc decision
 * 5). `userOverride` is the other store keyed the same way, and it is where
 * the only record of a soft merge lives: `performMerge` moves no Season,
 * Episode or Progress row, so `mergedFrom` on the target is the whole trace.
 */
export async function readSeriesRow(
  page: Page,
  seriesId: string,
  store: "series" | "userOverride" = "series",
): Promise<Record<string, unknown> | null> {
  return page.evaluate(
    async ({ dbName, id, storeName }: { dbName: string; id: string; storeName: string }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const row = await new Promise<Record<string, unknown> | null>((resolve) => {
        const tx = db.transaction(storeName, "readonly");
        const get = tx.objectStore(storeName).get(id);
        get.onsuccess = () => resolve((get.result as Record<string, unknown>) ?? null);
        get.onerror = () => resolve(null);
      });
      db.close();
      return row;
    },
    { dbName: DB_NAME, id: seriesId, storeName: store },
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

export interface SeedOpfsRootOptions {
  /** Directory name under OPFS. Must be unique per spec — OPFS is per-origin. */
  dirName: string;
  /** `FileRef.libraryId` the seeded `fileRefs` rows point at. */
  libraryId: string;
  /** File name inside `dirName`; must match the `relPath` of the FileRef. */
  fileName: string;
  /** File bytes. Read a real fixture off disk and pass `[...buffer]`. */
  bytes: readonly number[];
}

/**
 * Register a REAL directory handle as a persisted library root.
 *
 * The FSA directory picker cannot be driven by Playwright and a hand-built
 * fake handle dies on `structuredClone` (methods are stripped), so OPFS is the
 * only way to get a genuine `FileSystemDirectoryHandle` into the `fileHandles`
 * store — the same escape hatch `library-autorescan.spec.ts` documents. With
 * one seeded, `useFileHandles.selectFileByName` resolves an actual `File` and
 * the player can reach its playing state without a user gesture.
 *
 * ─── why this is safe to call while /library is open ────────────────────────
 *
 * Two independent reasons, and both are load-bearing:
 *
 *   1. The write goes through raw IndexedDB, which Dexie's `liveQuery` does
 *      not observe, so nothing in the mounted page reacts to it.
 *   2. `enumerator.js` skips any video under `MIN_VIDEO_SIZE` (1 MiB). The
 *      144-byte fixture in `e2e/fixtures/black1s.mp4` is far below that, so
 *      even if a watch-folder rescan does fire — the periodic fallback tick,
 *      a tab-return — it enumerates this directory and imports nothing.
 *
 * Without (2) this helper would quietly mint a second series card mid-spec.
 */
export async function seedOpfsLibraryRoot(
  page: Page,
  opts: SeedOpfsRootOptions,
): Promise<void> {
  await page.evaluate(
    async ({
      dbName,
      dirName,
      libraryId,
      fileName,
      bytes,
    }: { dbName: string } & SeedOpfsRootOptions) => {
      const opfs = await navigator.storage.getDirectory();
      await opfs.removeEntry(dirName, { recursive: true }).catch(() => {});
      const dir = await opfs.getDirectoryHandle(dirName, { create: true });
      const fileHandle = await dir.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(new Uint8Array(bytes));
      await writable.close();

      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("fileHandles", "readwrite");
        tx.objectStore("fileHandles").put({
          id: `fh-${libraryId}`,
          libraryId,
          name: dirName,
          addedAt: Date.now(),
          lastSeenAt: Date.now(),
          handle: dir,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    },
    { dbName: DB_NAME, ...opts, bytes: [...opts.bytes] },
  );
}

/** Best-effort OPFS teardown. OPFS outlives `indexedDB.deleteDatabase`. */
export async function removeOpfsDir(page: Page, dirName: string): Promise<void> {
  await page.evaluate(async (name: string) => {
    const opfs = await navigator.storage.getDirectory();
    await opfs.removeEntry(name, { recursive: true }).catch(() => {});
  }, dirName);
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
