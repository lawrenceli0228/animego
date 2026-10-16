import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearLibrary,
  removeOpfsDir,
  seedAlternateFileId,
  seedEpisodeId,
  seedLibrary,
  seedOpfsLibraryRoot,
} from "../../fixtures/dexie-seed";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A second release of an episode the library already holds.
//
// The import attaches it to that episode as an alternate instead of minting a
// duplicate card — and until this lane existed nothing in the UI read
// `alternateFileIds`: the sheet and the player both resolve an episode to its
// primary file, so a whole second release could sit in the library with no way
// to see or play it. The claim is only visible end to end: the sheet has to
// list the file, and the player has to open THAT file rather than the
// episode's primary. `data-playing-file` on the player header says which.
//
// Same OPFS technique as episode-display.spec.ts: a real directory handle is
// seeded as the library root, so the player resolves an actual File. Every
// name here is this spec's own (series id, library id, OPFS directory), and
// the series is never bound to AniList, so watch sync writes nothing.

const SERIES_ID = "othver-series";
const SERIES_TITLE = "其他版本测试";
const BARE_SERIES_ID = "othver-bare";
const BARE_SERIES_TITLE = "没有其他版本的测试";
const LIBRARY_ID = "othver-lib";
const WATCH_DIR = "othver-watch";
// No "E2E" in fixture names: the parser reads "[E2E]" as episode 2.
const PRIMARY_FILE = "Versions Smoke - 01.mp4";
const OTHER_DIR = "Second Release";
const OTHER_FILE = "Versions Smoke 01 alt.mp4";

const FIXTURE_MP4 = path.resolve(__dirname, "../../fixtures/black1s.mp4");
const FIXTURE_BYTES: readonly number[] = [...fs.readFileSync(FIXTURE_MP4)];

const ALT_ID = seedAlternateFileId(SERIES_ID, "main", 1, 0);
const PRIMARY_ID = `${seedEpisodeId(SERIES_ID, "main", 1)}-file`;

async function openSheet(page: Page, title: string): Promise<void> {
  const grid = page.getByTestId("series-grid");
  await expect(grid).toBeVisible({ timeout: 30_000 });
  // Scoped to the grid: the new-additions row can render the same card.
  await grid
    .getByTestId("series-card-root")
    .filter({ hasText: title })
    .locator('[data-series-card-button="true"]')
    .click();
  await expect(page.getByTestId("series-detail-sheet")).toBeVisible({ timeout: 30_000 });
}

test.describe("other versions of an episode", () => {
  test.afterEach(async ({ page }) => {
    await removeOpfsDir(page, WATCH_DIR).catch(() => {});
    await clearLibrary(page).catch(() => {});
  });

  test("★ a second release is listed under the grid and plays the file it names", async ({
    page,
  }) => {
    await page.goto("/welcome");
    await clearLibrary(page);
    await seedLibrary(page, {
      series: [
        {
          id: SERIES_ID,
          titleZh: SERIES_TITLE,
          totalEpisodes: 2,
          episodes: [
            {
              number: 1,
              fileRef: { libraryId: LIBRARY_ID, relPath: PRIMARY_FILE, size: FIXTURE_BYTES.length },
              alternates: [
                {
                  libraryId: LIBRARY_ID,
                  relPath: `${OTHER_DIR}/${OTHER_FILE}`,
                  size: FIXTURE_BYTES.length,
                },
              ],
            },
            { number: 2 },
          ],
        },
      ],
    });
    await seedOpfsLibraryRoot(page, {
      dirName: WATCH_DIR,
      libraryId: LIBRARY_ID,
      fileName: PRIMARY_FILE,
      bytes: FIXTURE_BYTES,
      extraFiles: [{ relPath: `${OTHER_DIR}/${OTHER_FILE}`, bytes: FIXTURE_BYTES }],
    });

    await page.goto("/library");
    await openSheet(page, SERIES_TITLE);

    // ── the sheet ────────────────────────────────────────────────────────
    // The version is listed in addition to the episode's own chip, under the
    // folder it came from, and carries the episode's number.
    const lane = page.getByTestId("episode-grid-other-versions");
    await expect(lane).toBeVisible({ timeout: 30_000 });
    await expect(lane).toContainText(OTHER_DIR);
    const versionChip = page.getByTestId(`episode-chip-version-${ALT_ID}`);
    await expect(versionChip).toHaveText("01");
    await expect(page.getByTestId("episode-chip-1")).toBeVisible();

    // ── the hand-off and the player ──────────────────────────────────────
    await versionChip.click();
    await page.waitForURL(new RegExp(`[?&]file=${ALT_ID}(&|$)`), { timeout: 30_000 });
    expect(page.url()).toMatch(/[?&]resumeEpisode=1(&|$)/);

    const playHeader = page.getByTestId("player-header");
    await expect(playHeader).toHaveCount(1, { timeout: 60_000 });
    await expect(
      playHeader,
      "the player must open the version that was picked, not the episode's primary",
    ).toHaveAttribute("data-playing-file", ALT_ID);
    await expect(playHeader).toContainText("EP01");

    // ── the episode's own chip is unchanged ──────────────────────────────
    await page.goto("/library");
    await openSheet(page, SERIES_TITLE);
    await page.getByTestId("episode-chip-1").click();
    await page.waitForURL(/[?&]resumeEpisode=1(&|$)/, { timeout: 30_000 });
    expect(page.url()).not.toContain("file=");
    await expect(page.getByTestId("player-header")).toHaveAttribute(
      "data-playing-file",
      PRIMARY_ID,
      { timeout: 60_000 },
    );
  });

  test("a card with no other versions shows no such lane", async ({ page }) => {
    await page.goto("/welcome");
    await clearLibrary(page);
    await seedLibrary(page, {
      series: [
        {
          id: BARE_SERIES_ID,
          titleZh: BARE_SERIES_TITLE,
          totalEpisodes: 2,
          episodes: [{ number: 1 }, { number: 2 }],
        },
      ],
    });

    await page.goto("/library");
    await openSheet(page, BARE_SERIES_TITLE);
    await expect(page.getByTestId("episode-chip-1")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("episode-grid-other-versions")).toHaveCount(0);
  });
});
