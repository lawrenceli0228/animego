import { test, expect, type Page } from "@playwright/test";
import { collectConsoleErrors } from "../_helpers";
import { clearLibrary, removeOpfsDir } from "../../fixtures/dexie-seed";

// A watched folder holding the same episode twice, then losing one copy, then
// having a file moved into another folder — the shape a library takes while
// its owner sorts downloads into per-show folders.
//
// Before the fix the library's one row per file could name only one path, so
// every scan imported whichever copy it did not name and rewrote the row: the
// card was announced as "found 1 new episode" on every visit, forever, and
// each round asked dandanplay again. Moved files were announced as new too.
//
// Same OPFS technique as library-autorescan.spec.ts: a real
// FileSystemDirectoryHandle seeded as the library root, so the real
// enumerate → diff → hash worker → import chain runs on each mount. A scan
// that finds nothing changes nothing visible; `data-rescan-count` on the
// library shell is what tells the test it has run.

const DB_NAME = "animego-library";
const WATCH_DIR = "e2e-copies-watch";
const SHOW_DIR = "Copies Show";
const MOVED_DIR = "Moved";
// No "E2E" in fixture names: the parser reads "[E2E]" as episode 2.
const EP1 = "[Sub] Copies Smoke - 01.mkv";
const EP2 = "[Sub] Copies Smoke - 02.mkv";
const EP1_BYTES = 2 * 1024 * 1024;
const EP2_BYTES = 3 * 1024 * 1024;
const LIB_ID = "e2e-copies-lib";
const CLOCK_SHIFT_MS = 5 * 60 * 1000;

interface LibraryState {
  fileRefs: Array<{
    id: string;
    relPath: string;
    size: number;
    episodeId?: string;
    copies?: Array<{ libraryId: string; relPath: string }>;
  }>;
  episodes: Array<{ id: string; seriesId: string; number: number }>;
  series: Array<{ id: string; updatedAt: number }>;
}

/** Raw IndexedDB read — the page's Dexie instance stays untouched. */
async function readLibrary(page: Page): Promise<LibraryState> {
  return page.evaluate(
    (dbName: string) =>
      new Promise<LibraryState>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(["fileRefs", "episodes", "series"], "readonly");
          const all = (name: string) =>
            new Promise<unknown[]>((res, rej) => {
              const r = tx.objectStore(name).getAll();
              r.onsuccess = () => res(r.result);
              r.onerror = () => rej(r.error);
            });
          Promise.all([all("fileRefs"), all("episodes"), all("series")])
            .then(([fileRefs, episodes, series]) => {
              db.close();
              resolve({ fileRefs, episodes, series } as LibraryState);
            })
            .catch((err) => {
              db.close();
              reject(err);
            });
        };
      }),
    DB_NAME,
  );
}

/** Reload /library and wait for its mount scan to finish. */
async function reloadAndScan(page: Page): Promise<void> {
  await page.reload();
  await expect
    .poll(
      async () =>
        Number(
          (await page.locator("[data-rescan-count]").getAttribute("data-rescan-count")) ?? 0,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(1);
}

const ep1Row = (state: LibraryState) => {
  const row = state.fileRefs.find((r) => r.size === EP1_BYTES);
  if (!row) throw new Error("episode 1 has no fileRef row");
  return row;
};
const onlySeries = (state: LibraryState) => {
  const [series, ...rest] = state.series;
  if (!series || rest.length) throw new Error(`expected one series, found ${state.series.length}`);
  return series;
};
const ep2Row = (state: LibraryState) => {
  const row = state.fileRefs.find((r) => r.size === EP2_BYTES);
  if (!row) throw new Error("episode 2 has no fileRef row");
  return row;
};

test.describe("/library — a file kept twice, then sorted (OPFS-backed)", () => {
  let dandanCalls = 0;

  test.beforeEach(async ({ page }) => {
    dandanCalls = 0;
    // The quiet-period guard defers files modified <60s ago; the fixtures
    // are written moments before each scan.
    await page.addInitScript((shift: number) => {
      const real = Date.now.bind(Date);
      Date.now = () => real() + shift;
    }, CLOCK_SHIFT_MS);
    await page.route("**/api/dandanplay/match", (route) => {
      dandanCalls++;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ matched: false }),
      });
    });
  });

  test.afterEach(async ({ page }) => {
    await removeOpfsDir(page, WATCH_DIR).catch(() => {});
    await clearLibrary(page).catch(() => {});
  });

  test("copies settle after one scan; deleting or moving a file is never a new episode", async ({
    page,
  }) => {
    // Four full mount scans with hashing in dev mode.
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);

    await page.goto("/welcome");
    await clearLibrary(page);
    // First /library visit recreates the Dexie schema.
    await page.goto("/library");
    await expect(page.getByTestId("dropzone")).toBeVisible({ timeout: 10_000 });

    // Episode 1 twice — in the show's folder and loose at the root, byte for
    // byte the same — and episode 2 once.
    await page.evaluate(
      async (p: {
        dbName: string;
        watchDir: string;
        showDir: string;
        ep1: string;
        ep2: string;
        ep1Bytes: number;
        ep2Bytes: number;
        libId: string;
      }) => {
        const write = async (dir: FileSystemDirectoryHandle, name: string, bytes: number) => {
          const fh = await dir.getFileHandle(name, { create: true });
          const w = await fh.createWritable();
          await w.write(new Uint8Array(bytes));
          await w.close();
        };
        const opfs = await navigator.storage.getDirectory();
        await opfs.removeEntry(p.watchDir, { recursive: true }).catch(() => {});
        const root = await opfs.getDirectoryHandle(p.watchDir, { create: true });
        const show = await root.getDirectoryHandle(p.showDir, { create: true });
        await write(show, p.ep1, p.ep1Bytes);
        await write(root, p.ep1, p.ep1Bytes);
        await write(show, p.ep2, p.ep2Bytes);

        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.open(p.dbName);
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction("fileHandles", "readwrite");
            tx.objectStore("fileHandles").put({
              id: "e2e-fh-copies",
              libraryId: p.libId,
              name: p.watchDir,
              addedAt: Date.now(),
              lastSeenAt: Date.now(),
              handle: root,
            });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        });
      },
      {
        dbName: DB_NAME,
        watchDir: WATCH_DIR,
        showDir: SHOW_DIR,
        ep1: EP1,
        ep2: EP2,
        ep1Bytes: EP1_BYTES,
        ep2Bytes: EP2_BYTES,
        libId: LIB_ID,
      },
    );

    // ── 1. First scan: both episodes land; the second copy is listed. ──────
    await reloadAndScan(page);
    await expect(page.getByTestId("series-card-root")).toHaveCount(1, { timeout: 10_000 });
    const first = await readLibrary(page);
    expect(first.fileRefs).toHaveLength(2);
    expect(first.episodes).toHaveLength(2);
    const ep1Paths = [`${SHOW_DIR}/${EP1}`, EP1];
    const settled = ep1Row(first);
    expect(ep1Paths).toContain(settled.relPath);
    expect(settled.copies).toEqual([
      { libraryId: LIB_ID, relPath: ep1Paths.find((p) => p !== settled.relPath) },
    ]);
    const otherCopy = ep1Paths.find((p) => p !== settled.relPath)!;
    const callsAfterImport = dandanCalls;
    const seriesUpdatedAt = onlySeries(first).updatedAt;

    // ── 2. Scan again: nothing moves, nothing is announced, nothing asked. ──
    await reloadAndScan(page);
    await expect(page.getByTestId("scan-toast")).toHaveCount(0);
    const second = await readLibrary(page);
    expect(ep1Row(second)).toEqual(settled);
    expect(onlySeries(second).updatedAt).toBe(seriesUpdatedAt);
    expect(dandanCalls).toBe(callsAfterImport);

    // ── 3. Delete the copy the row names: the other copy takes over. ───────
    await page.evaluate(
      async (p: { watchDir: string; relPath: string }) => {
        const parts = p.relPath.split("/");
        const name = parts.pop()!;
        let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(p.watchDir);
        for (const part of parts) dir = await dir.getDirectoryHandle(part);
        await dir.removeEntry(name);
      },
      { watchDir: WATCH_DIR, relPath: settled.relPath },
    );
    await reloadAndScan(page);
    await expect(page.getByTestId("scan-toast")).toHaveCount(0);
    const third = await readLibrary(page);
    expect(ep1Row(third).relPath).toBe(otherCopy);
    expect(ep1Row(third).copies).toBeUndefined();
    expect(ep1Row(third).episodeId).toBe(settled.episodeId);
    expect(third.episodes).toHaveLength(2);
    expect(onlySeries(third).updatedAt).toBe(seriesUpdatedAt);
    expect(dandanCalls).toBe(callsAfterImport);

    // ── 4. Move episode 2 into another folder: relinked, not new. ──────────
    await page.evaluate(
      async (p: { watchDir: string; showDir: string; movedDir: string; ep2: string }) => {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(p.watchDir);
        const show = await root.getDirectoryHandle(p.showDir);
        const moved = await root.getDirectoryHandle(p.movedDir, { create: true });
        const bytes = await (await (await show.getFileHandle(p.ep2)).getFile()).arrayBuffer();
        const target = await moved.getFileHandle(p.ep2, { create: true });
        const w = await target.createWritable();
        await w.write(bytes);
        await w.close();
        await show.removeEntry(p.ep2);
      },
      { watchDir: WATCH_DIR, showDir: SHOW_DIR, movedDir: MOVED_DIR, ep2: EP2 },
    );
    await reloadAndScan(page);
    await expect(page.getByTestId("scan-toast")).toHaveCount(0);
    const fourth = await readLibrary(page);
    expect(ep2Row(fourth).relPath).toBe(`${MOVED_DIR}/${EP2}`);
    expect(ep2Row(fourth).episodeId).toBe(ep2Row(first).episodeId);
    expect(fourth.episodes).toHaveLength(2);
    expect(onlySeries(fourth).updatedAt).toBe(seriesUpdatedAt);
    expect(dandanCalls).toBe(callsAfterImport);
    await expect(page.getByTestId("series-card-root")).toHaveCount(1);

    expect(errors, `Unexpected console errors:\n${errors.join("\n")}`).toEqual([]);
  });
});
