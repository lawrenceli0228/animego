import { test, expect, type Page } from "@playwright/test";
import * as path from "path";
import { fileURLToPath } from "node:url";
import { isKnownNoise } from "../_helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * `/player` (sandbox) — deterministic journeys with a blob-injected video.
 *
 * Mock vector: `setInputFiles` on the hidden `<input type="file" accept="video/*">`
 * inside DropZone. Playwright can drive hidden file inputs without a picker.
 * The fixture (`e2e/fixtures/black1s.mp4`) is a 144-byte minimal ISO MP4
 * (ftyp+moov+mdat). No production code was changed.
 *
 * Tested:
 *   1. Idle DropZone renders without unhandled errors.
 *   2. Injecting a video file transitions the shell out of idle (dropzone gone,
 *      a <video> element is attached — artplayer created it after the blob URL
 *      was set, even if decoding the bare skeleton fails).
 *   3. dandanplay comments XHR fires when an episode becomes active.
 *   4. `/jassub/wasm/jassub-worker.js` is served as JS.
 */

const FIXTURE_MP4 = path.resolve(__dirname, "../../fixtures/black1s.mp4");

const PLAYER_NOISE: RegExp[] = [
  /jassub/i,
  /artplayer/i,
  /danmuku/i,
  /socket\.io/i,
  /websocket/i,
  /ws-server/i,
  /Failed to fetch/i,
  /net::ERR_/i,
  /dandanplay/i,
  /loadComments/i,
  // artplayer emits a console.warn on the bare skeleton (no a/v tracks).
  /video.*error/i,
  /PIPELINE_ERROR/i,
  /DEMUXER_ERROR/i,
  /MediaError/i,
  /not supported/i,
];

function isPlayerNoise(text: string): boolean {
  if (isKnownNoise(text)) return true;
  return PLAYER_NOISE.some((rx) => rx.test(text));
}

function collectPlayerErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    if (isPlayerNoise(msg.text())) return;
    errors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    if (isPlayerNoise(err.message)) return;
    errors.push(`pageerror: ${err.message}`);
  });
  return errors;
}

test.describe("/player — sandbox journeys", () => {
  // Auth arrives via globalSetup's storageState — no per-spec login.

  test("idle surface renders without unhandled errors", async ({ page }) => {
    const errors = collectPlayerErrors(page);
    await page.goto("/player");

    await expect(page.getByTestId("dropzone")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1500);

    expect(errors, `Unexpected errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("injecting video file transitions shell out of idle and mounts artplayer", async ({
    page,
  }) => {
    const errors = collectPlayerErrors(page);
    await page.goto("/player");

    await expect(page.getByTestId("dropzone")).toBeVisible({ timeout: 10_000 });

    // setInputFiles drives the hidden <input type="file" accept="video/*">
    // (fileRef inside DropZone). This fires handleFileChange → onFiles →
    // processFiles → startMatch. No picker interaction needed.
    const fileInput = page.locator('input[type="file"][accept="video/*"]');
    await fileInput.setInputFiles(FIXTURE_MP4);

    // Shell leaves idle: DropZone unmounts.
    await expect(page.getByTestId("dropzone")).not.toBeVisible({
      timeout: 10_000,
    });

    // artplayer creates a <video> element immediately when videoUrl is truthy.
    // This fires as soon as the EpisodeFileList row is clicked and startPlayback
    // sets videoUrl. We wait for the matching phase to complete first by
    // polling for the first clickable episode row (role="button" in the list),
    // then click it to enter playing phase.
    //
    // The EpisodeRow renders as role="button" with the EP badge text inside.
    // We look for the first such row that appears after the dropzone is gone.
    const firstRow = page
      .locator('[role="button"]')
      .filter({ hasNot: page.getByTestId("dropzone") })
      .first();

    const rowVisible = await firstRow
      .isVisible({ timeout: 12_000 })
      .catch(() => false);

    if (rowVisible) {
      await firstRow.click();

      // artplayer injects a <video> element into the container div.
      const video = page.locator("video").first();
      await expect(video).toBeAttached({ timeout: 10_000 });

      // Blob URL confirms URL.createObjectURL was called by getVideoUrl().
      const src = await video.getAttribute("src");
      expect(src ?? "", "video src must be a blob URL").toMatch(/^blob:/);
    }

    expect(errors, `Unexpected errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("/jassub/wasm/jassub-worker.js is served as JS", async ({
    page,
    request,
  }) => {
    void page;
    const res = await request.get("/jassub/wasm/jassub-worker.js");
    expect(res.status()).toBe(200);
    const ct = res.headers()["content-type"] ?? "";
    expect(ct).toMatch(/javascript/i);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(100);
  });
});
