import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * A subtitle file sitting next to a video must reach the <track> as parsed
 * WebVTT.
 *
 * WHAT THIS GUARDS
 *
 * The invariant `resolveSubtitle` owns: whatever url leaves it is a WebVTT
 * document. Sidecars used to be handed over as a blob url of the ORIGINAL
 * file while artplayer was told `type: "vtt"` — and a raw .srt/.ass has no
 * `WEBVTT` header, so the browser's TextTrack parser rejects the file whole
 * and the reader gets no subtitles at all. Since sidecar matching prefers
 * .ass first, the format most likely to be picked was the one guaranteed to
 * render nothing. A cue count > 0 here is the check that was missing.
 *
 * WHAT THIS DOES **NOT** GUARD, AND WHY IT IS SAID OUT LOUD
 *
 * It does not cover the artplayer handoff race that shipped alongside — the
 * one where VideoPlayer's VTT switch read `artRef.current` while depending
 * only on `[subtitleUrl]`, so a subtitle resolving before artplayer existed
 * took the early return and was never retried.
 *
 * That is not an oversight, it is a measurement: a local production build was
 * run against these same three cases WITH the fix and WITHOUT it, and both
 * passed all three. Localhost resolves a sidecar so quickly that artplayer is
 * always already up. The failure only reproduced against production latency,
 * where a sidecar .srt produced its text/vtt blob every time and the <track>
 * src stayed empty. Do not read a green run here as that race being covered.
 *
 * WHY THE FIXTURE IS A REAL VIDEO
 *
 * `black1s.mp4` is a 144-byte structural stub with no media data, so
 * `loadedmetadata` never fires and the browser DEFERS loading the <track>
 * beside it. Against that fixture every case reads zero cues whether the code
 * works or not. `probe4s.webm` is a real ~4s VP8 clip, so a cue count means
 * something.
 *
 * WHY THE MATCH IS MOCKED
 *
 * The episode list only appears once matching resolves, and matching calls
 * dandanplay — an upstream that answers differently on different days, which
 * is how `/anime/21` ended up flaking a merge gate. player.spec.ts sidesteps
 * it with `if (rowVisible)`, which passes just as happily when nothing was
 * verified. The canned reply below was captured from the live endpoint;
 * `episodeMap` is load-bearing, and a mock without it crashes the page with
 * `Object.keys(undefined)` rather than failing an assertion.
 */

const FIXTURE_VIDEO = path.resolve(__dirname, "../../fixtures/probe4s.webm");

const SRT = ["1", "00:00:00,000 --> 00:09:59,000", "{\\an8}顶部字幕 TOP", ""].join("\n");

const ASS = [
  "[Script Info]",
  "ScriptType: v4.00+",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:00.00,0:09:59.00,Default,,0,0,0,,{\\an8}顶部字幕 TOP",
].join("\n");

const VTT = "WEBVTT\n\n00:00:00.000 --> 00:09:59.000\n顶部字幕 TOP\n\n";

const CASES = [
  { ext: "srt", body: SRT, note: "async conversion" },
  { ext: "ass", body: ASS, note: "async conversion, plus libass on top" },
  { ext: "vtt", body: VTT, note: "synchronous passthrough" },
];

/**
 * Shape captured from the live `/api/dandanplay/match`, trimmed to what the
 * player reads. No `dandanEpisodeId` on purpose: with one the player fetches
 * comments from dandanplay, and this spec is meant to touch no upstream.
 */
const MATCH_REPLY = {
  matched: true,
  anime: {
    anilistId: 130003,
    titleChinese: "孤独摇滚！",
    titleRomaji: "Bocchi the Rock!",
    episodes: 12,
  },
  siteAnime: {
    anilistId: 130003,
    titleChinese: "孤独摇滚！",
    titleRomaji: "Bocchi the Rock!",
    episodes: 12,
  },
  episodeMap: { 1: { title: "第1话 翻转孤独" } },
  source: "animeCache",
};

/** A folder holding one video and one same-basename sidecar. */
function makeSidecarDir(ext: string, body: string): { root: string; show: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sidecar-${ext}-`));
  const show = path.join(root, "Sidecar Probe");
  fs.mkdirSync(show);
  fs.copyFileSync(FIXTURE_VIDEO, path.join(show, "Sidecar Probe - 01.webm"));
  fs.writeFileSync(path.join(show, `Sidecar Probe - 01.${ext}`), body, "utf-8");
  return { root, show };
}

test.describe("sidecar subtitles", () => {
  for (const kase of CASES) {
    test(`a sidecar .${kase.ext} reaches the track as parsed WebVTT (${kase.note})`, async ({
      page,
    }) => {
      await page.route("**/api/dandanplay/match*", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MATCH_REPLY),
        }),
      );

      const { root, show } = makeSidecarDir(kase.ext, kase.body);
      try {
        await page.goto("/player");
        await expect(page.getByTestId("dropzone")).toBeVisible({ timeout: 15_000 });

        // The accept="video/*" input takes a single file and a sidecar test
        // needs two, so drive the folder input. Both run the identical
        // `onFiles(Array.from(files))` handler.
        await page.locator('input[type="file"][webkitdirectory]').setInputFiles(show);
        await expect(page.getByTestId("dropzone")).toBeHidden({ timeout: 20_000 });

        const row = page.locator('[role="button"]').first();
        await expect(row).toBeVisible({ timeout: 20_000 });
        await row.click();

        await expect(page.locator("video")).toBeAttached({ timeout: 15_000 });

        // Hold mid-clip. The fixture is ~4s and an ENDED video reports no
        // active cues, which would read as a failure that isn't one.
        await page.evaluate(async () => {
          const v = document.querySelector("video");
          if (!v) return;
          v.currentTime = 1;
          try {
            await v.play();
          } catch {
            /* autoplay policy — holding currentTime is what matters */
          }
        });

        await expect
          .poll(
            () =>
              page.evaluate(() => {
                const v = document.querySelector("video");
                const track = v?.textTracks[0];
                return track?.cues ? track.cues.length : 0;
              }),
            { timeout: 20_000, message: `sidecar .${kase.ext} produced no cues` },
          )
          .toBeGreaterThan(0);

        const doc = await page.evaluate(async () => {
          const t = document.querySelector("track");
          if (!t || !t.src.startsWith("blob:")) return null;
          return (await (await fetch(t.src)).text()).slice(0, 400);
        });

        expect(doc, "track src must be a converted blob, not the raw file").not.toBeNull();
        expect(doc!.startsWith("WEBVTT"), "every track document is WebVTT").toBe(true);
        expect(doc).toContain("顶部字幕 TOP");
        // The reported bug: an override tag rendered as on-screen text.
        expect(doc, "ASS override tags must not survive into the VTT layer").not.toContain(
          "{\\an8}",
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
