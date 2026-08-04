import { test, expect } from "@playwright/test";
import { collectConsoleErrors } from "../_helpers";
import { clearLibrary } from "../../fixtures/dexie-seed";

// Positive end-to-end for the watch-folder auto-rescan (PR-1).
//
// The FSA directory picker can't be driven by Playwright, and a fake handle
// seeded into IDB dies on structuredClone (methods stripped). OPFS is the
// escape hatch: `navigator.storage.getDirectory()` hands out a REAL
// FileSystemDirectoryHandle — no gesture, structured-cloneable into the
// `fileHandles` store, and fully enumerable. Seeding one as a library root
// exercises the real chain on mount:
//
//   probe → enumerate → (relPath,size) diff → md5 hash worker →
//   (stubbed) dandan match → local-title series → liveQuery → card
//
// Two determinism seams:
//   - Date.now is shifted forward in-page: the quiet-period guard defers
//     files modified <60s ago (real torrent half-writes), and the OPFS
//     fixture is written milliseconds before the scan.
//   - /api/dandanplay/match is stubbed unmatched ({matched:false}), so the
//     import lands on the local-title fallback path with zero external
//     network — dandanplay matching accuracy is not under test here.

const DB_NAME = "animego-library";
const WATCH_DIR = "e2e-autorescan-watch";
const VIDEO_NAME = "[E2E] Autorescan Smoke - 01.mkv";
const LIB_ID = "e2e-autorescan-lib";
const CLOCK_SHIFT_MS = 5 * 60 * 1000;

test.describe("/library — watch-folder auto-rescan (OPFS-backed)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((shift: number) => {
      const real = Date.now.bind(Date);
      Date.now = () => real() + shift;
    }, CLOCK_SHIFT_MS);
    await page.route("**/api/dandanplay/match", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ matched: false }),
      }),
    );
  });

  test.afterEach(async ({ page }) => {
    await page
      .evaluate(async (watchDir: string) => {
        const opfs = await navigator.storage.getDirectory();
        await opfs.removeEntry(watchDir, { recursive: true }).catch(() => {});
      }, WATCH_DIR)
      .catch(() => {});
    await clearLibrary(page).catch(() => {});
  });

  test("new file in a watched folder is imported on mount and surfaces a card", async ({
    page,
  }) => {
    const errors = collectConsoleErrors(page);

    await page.goto("/welcome");
    await clearLibrary(page);

    // First /library visit recreates the Dexie schema (clearLibrary deletes
    // the whole DB) and proves the no-roots scan is a silent no-op.
    await page.goto("/library");
    await expect(page.getByTestId("dropzone")).toBeVisible({ timeout: 10_000 });

    // Seed: real OPFS directory with one >1MB "video", registered as a
    // persisted library root exactly as fileHandleStore would store it.
    await page.evaluate(
      async ({
        dbName,
        watchDir,
        videoName,
        libId,
      }: {
        dbName: string;
        watchDir: string;
        videoName: string;
        libId: string;
      }) => {
        const opfs = await navigator.storage.getDirectory();
        await opfs.removeEntry(watchDir, { recursive: true }).catch(() => {});
        const dir = await opfs.getDirectoryHandle(watchDir, { create: true });
        const fh = await dir.getFileHandle(videoName, { create: true });
        const writable = await fh.createWritable();
        await writable.write(new Uint8Array(2 * 1024 * 1024));
        await writable.close();

        await new Promise<void>((resolve, reject) => {
          const req = indexedDB.open(dbName);
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction("fileHandles", "readwrite");
            tx.objectStore("fileHandles").put({
              id: "e2e-fh-autorescan",
              libraryId: libId,
              name: watchDir,
              addedAt: Date.now(),
              lastSeenAt: Date.now(),
              handle: dir,
            });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        });
      },
      { dbName: DB_NAME, watchDir: WATCH_DIR, videoName: VIDEO_NAME, libId: LIB_ID },
    );

    // Fresh mount with the seeded root → the auto-rescan imports the file.
    await page.reload();

    const card = page.getByTestId("series-card-root").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("series-grid")).toContainText(/autorescan/i, {
      timeout: 10_000,
    });

    // Silent contract: the full-screen import drawer/scrim never mounts for
    // an automatic run.
    await expect(page.getByTestId("import-drawer")).toHaveCount(0);
    await expect(page.getByTestId("import-drawer-scrim")).toHaveCount(0);

    await page.waitForLoadState("networkidle");

    expect(
      errors,
      `Unexpected console errors:\n${errors.join("\n")}`,
    ).toEqual([]);
  });
});
