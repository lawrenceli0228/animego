import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { collectConsoleErrors } from "../_helpers";
import {
  clearLibrary,
  removeOpfsDir,
  seedLibrary,
  seedOpfsLibraryRoot,
} from "../../fixtures/dexie-seed";
import { closePg, ensureAnimeDetail, removeAnimeFixture } from "../../fixtures/pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// What number an episode is called, and whether it can be reached at all.
//
// Three assertions, and only the first two are about the library. They live in
// one file because they are one claim from three sides: the count that sizes a
// grid is never allowed to hide a file, rename it inconsistently, or delete the
// section that would have shown it.
//
//   1. R1 — a merged card shows every episode it holds. Issue #75 shipped this
//      exact harm once (fixed in 5e26b94) and the grid has since been given a
//      declared total to trust, which is the other way to cause it.
//   2. A sequel numbered 13-24 on disk reads 1-12 in the sheet AND in the
//      player. A sheet that says 01 opening a player that says EP13 is only
//      visible end to end — both halves typecheck and both unit-test green.
//   3. A title with no episode count renders a "count pending" section rather
//      than no section, in the SERVER html, which is the only copy a crawler
//      sees.
//
// ─── isolation ──────────────────────────────────────────────────────────────
//
// The sandbox project is `fullyParallel` over one shared seed user, so nothing
// here may collide with a sibling spec. Every test owns its own series ids, its
// own OPFS directory and its own AniList id, and each browser context has its
// own IndexedDB and OPFS. None of these series is bound to AniList
// (`anilistId` is deliberately never set), so watch sync classifies them
// `unbound` and this whole file writes nothing to `subscriptions`.
//
// ─── running it ─────────────────────────────────────────────────────────────
//
// `.github/workflows/e2e-sandbox.yml` on every PR to main; locally, the recipe
// at the top of library-watch-sync.spec.ts, then:
//
//   cd e2e && bun run test:sandbox specs/sandbox/episode-display.spec.ts

// ── 1. the merged card ──────────────────────────────────────────────────────
const MERGE_ROOT_ID = "epdisp-merge-root";
const MERGE_SOURCE_ID = "epdisp-merge-source";
const MERGE_TITLE = "合并卡片测试 · 第一季";
const SEASON_LENGTH = 12;
const MERGED_TOTAL = SEASON_LENGTH * 2;
// dandanplay per-season ids. They have to DIFFER: `buildGroupTotals` folds a
// merged card's members by season identity and sums only the distinct ones, so
// two members sharing an id would be read as the same season imported twice.
const MERGE_ROOT_ANIME_ID = 900811;
const MERGE_SOURCE_ANIME_ID = 900812;

// ── 2. the continuously-numbered sequel ─────────────────────────────────────
const SEQUEL_ID = "epdisp-sequel";
const SEQUEL_TITLE = "连续编号续季测试";
const SEQUEL_FIRST_STORED = 13;
const SEQUEL_LIBRARY_ID = "epdisp-sequel-lib";
const SEQUEL_WATCH_DIR = "epdisp-sequel-watch";
// No "E2E" anywhere in a filename that could reach the episode parser: the
// "E2" inside "[E2E]" parses as episode 2 (library-autorescan.spec.ts:27).
const SEQUEL_FILE_NAME = "Sequel Second Cour - 13.mp4";

// The 144-byte ISO MP4 skeleton player.spec.ts uses. Chromium cannot decode it
// — which is fine here, because reaching the playing state needs a readable
// File and a blob URL, not a decoded stream — and it is comfortably under
// `enumerator.js`'s 1 MiB MIN_VIDEO_SIZE, so the watch-folder rescan that
// mounts alongside it enumerates the directory and imports nothing.
const FIXTURE_MP4 = path.resolve(__dirname, "../../fixtures/black1s.mp4");
const FIXTURE_BYTES: readonly number[] = [...fs.readFileSync(FIXTURE_MP4)];

// ── 3. the airing title with no count ───────────────────────────────────────
const ANI_PENDING = 900901;
const PENDING_TITLE = "集数待定测试";
// Mirrors `detail.episodes` / `detail.episodeCountPending` /
// `detail.episodeCountPendingHint` in next-app/src/locales/zh.ts and
// zh-spa.js. Hard-coded rather than imported because e2e/ has no path alias
// into next-app, and asserting the literal copy is the point: the claim under
// test is what the page SAYS, and a change to it should be a decision somebody
// makes on purpose.
const PENDING_SECTION_HEADING = "集数列表";
const PENDING_COPY = "本季集数待定";
const PENDING_HINT_COPY = "总集数确认后，这里会列出每一集。";

/**
 * Stub every outbound dandanplay call.
 *
 * A guard, not a fixture: no series seeded here is bound, so clicking a card
 * runs `startTracking` → `resolveSeriesBinding`, which is a title search
 * against `/api/dandanplay/search`. An empty `results` array resolves to
 * "unbound" with no subscription written, and pins the spec off the network so
 * a failure is this file's fault rather than somebody's rate limit.
 */
async function stubDandanplay(page: Page): Promise<void> {
  await page.route("**/api/dandanplay/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ matched: false, results: [] }),
    }),
  );
}

/** Every chip the grid rendered, in both lanes. */
function allChips(page: Page) {
  return page.locator('[data-episode-chip="true"]');
}

/**
 * The chips that stand for a file the user actually has.
 *
 * `data-state` is `"missing"` exactly when the cell has no episode behind it
 * (EpisodeGrid.tsx), so this is "every rendered chip backed by a local
 * episode" without naming a container. That independence is the whole point —
 * see the R1 note in the first test.
 */
function reachableChips(page: Page) {
  return page.locator('[data-episode-chip="true"]:not([data-state="missing"])');
}

// Two describes, not one, and the split is a correctness requirement rather
// than a filing decision. `afterAll` runs once per WORKER, and this project is
// `fullyParallel`, so a shared teardown that deletes the detail fixture would
// fire when whichever worker finished the library journeys first — potentially
// deleting the `anime_cache` row out from under the detail test still running
// next door. Scoping the delete to the describe that owns the row means only
// the worker that ran that test can run its teardown.
test.describe("episode display — the library grid", () => {
  test.afterAll(async () => {
    // pg.ts holds a lazy singleton connection; Playwright will not exit while
    // the socket is open. Nothing to delete: neither series here is bound, so
    // this half of the file never writes to Postgres at all.
    await closePg();
  });

  test.beforeEach(async ({ page }) => {
    await stubDandanplay(page);
  });

  test.afterEach(async ({ page }) => {
    // OPFS survives `indexedDB.deleteDatabase`, so it needs its own sweep.
    await removeOpfsDir(page, SEQUEL_WATCH_DIR).catch(() => {});
    await clearLibrary(page).catch(() => {});
  });

  // ───────────────────────────────────────────────────────────────────────
  // R1 — a merged card never hides an episode the user has on disk.
  //
  // Issue #75: `SeriesDetailSheet` read episodes with
  // `.where("seriesId").equals(series.id)`, and `performMerge` is a SOFT merge
  // that leaves every merged-in episode filed under the source id. One merge
  // hid half a card, and the progress query had the same shape, so the half
  // that did show came back looking unwatched.
  //
  // The grid has since been given a declared total to size itself with, which
  // is the same harm from the arithmetic side — hence the fixture below: two
  // 12-episode seasons, BOTH numbered 1-12, merged into one card. That is what
  // MergeDialog merges, and it is the shape where a season-sized grid has
  // nowhere to put the second twelve.
  // ───────────────────────────────────────────────────────────────────────
  test("a merged card reaches every episode of both seasons", async ({ page }) => {
    // Card click → sheet open → 24 episodes + 24 progress rows read out of
    // IndexedDB, against a dev-mode server. The 30s default is not enough.
    test.setTimeout(120_000);
    const errors = collectConsoleErrors(page);

    await page.goto("/welcome");
    await clearLibrary(page);
    const seeded = await seedLibrary(page, {
      series: [
        {
          id: MERGE_ROOT_ID,
          titleZh: MERGE_TITLE,
          totalEpisodes: SEASON_LENGTH,
          seasons: [{ number: 1, animeId: MERGE_ROOT_ANIME_ID }],
          // The merge itself. `useLibrary` hides the source from the grid on
          // the strength of this one array, which is why a card can lose half
          // its episodes without losing the card.
          mergedFrom: [MERGE_SOURCE_ID],
          episodes: Array.from({ length: SEASON_LENGTH }, (_, i) => ({
            number: i + 1,
          })),
        },
        {
          id: MERGE_SOURCE_ID,
          titleZh: "合并卡片测试 · 第二季",
          totalEpisodes: SEASON_LENGTH,
          seasons: [{ number: 2, animeId: MERGE_SOURCE_ANIME_ID }],
          // Watched, and ONLY on this half. The quiet half of #75 was episodes
          // reappearing while their progress did not, which reads as deleted
          // watch history rather than as a query bug — so the merged-in side
          // is the side that carries the progress rows.
          episodes: Array.from({ length: SEASON_LENGTH }, (_, i) => ({
            number: i + 1,
            progress: { completed: true },
          })),
        },
      ],
    });
    expect(seeded.seriesIds).toEqual([MERGE_ROOT_ID, MERGE_SOURCE_ID]);

    await page.goto("/library");
    const grid = page.getByTestId("series-grid");
    await expect(grid).toBeVisible({ timeout: 30_000 });

    // Scoped to the grid rather than the page: `NewAdditionsRow` and
    // `RecentlyPlayedRow` render the same `SeriesCard` (and so the same
    // testid) once the library passes their size threshold, and "the main grid
    // holds one card" is what this line means.
    //
    // One card, not two: the source is merged away.
    const cards = grid.getByTestId("series-card-root");
    await expect(cards).toHaveCount(1, { timeout: 30_000 });

    await cards
      .filter({ hasText: MERGE_TITLE })
      .locator('[data-series-card-button="true"]')
      .click();
    await expect(page.getByTestId("series-detail-sheet")).toBeVisible({
      timeout: 30_000,
    });

    // ── THE R1 ASSERTION ─────────────────────────────────────────────────
    //
    // Count the chips that are backed by a local episode, across BOTH lanes,
    // and require every one of them to be openable.
    //
    // Why it is written this way rather than "24 chips in the grid": the split
    // between the season skeleton and the unclassified lane is a layout
    // decision that has already changed once. On this fixture the current code
    // draws twelve of these in the skeleton and twelve in the lane (both
    // seasons run 1-12, so only twelve display numbers exist and `main` beats
    // `main` on id); a future change could put all 24 in one lane, or resize
    // the skeleton, and none of that would be a regression. What must never
    // change is the count: 24 files on disk, 24 chips a user can click. This
    // selector names neither container, neither grid length, and no testid
    // that encodes a slot number, so it keeps meaning exactly that.
    await expect(
      reachableChips(page),
      "every episode on a merged card must be reachable — regression R1 / issue #75",
    ).toHaveCount(MERGED_TOTAL, { timeout: 30_000 });
    await expect(
      page.locator('[data-episode-chip="true"]:not([data-state="missing"])[disabled]'),
      "a chip that stands for a real file must be clickable, not a dead slot",
    ).toHaveCount(0);

    // The progress half of the same bug, and the half a manual smoke test
    // misses. Only the merged-in season was watched, so twelve completed chips
    // means both the episodes AND their progress rows crossed the merge. A
    // query that reads only the root's rows scores zero here even if some
    // other change kept the episode count right.
    await expect(
      page.locator('[data-episode-chip="true"][data-state="completed"]'),
      "progress must be read across the merge, not just episodes",
    ).toHaveCount(SEASON_LENGTH, { timeout: 30_000 });

    await page.waitForLoadState("networkidle");
    expect(errors, `Unexpected console errors:\n${errors.join("\n")}`).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────
  // A sequel whose files are numbered 13-24 shows 1-12 — in the sheet, and
  // then in the player, which is the half that cannot be unit-tested.
  //
  // `normalizeEpisodeNumbers` is display-only: IndexedDB keeps 13-24, because
  // `persistFileRefsOnly` de-duplicates a re-scan by probing stored numbers
  // with freshly parsed ones. So the hand-off out of the sheet is
  // `?resumeEpisode=13` while the chip that produced it said 01 — and the
  // player has to arrive back at 01 on its own, from the same rule and the
  // same group total. This test walks that whole round trip.
  // ───────────────────────────────────────────────────────────────────────
  test("a continuously-numbered second season reads 1-12, and the player agrees", async ({
    page,
  }) => {
    // Library mount → sheet → SPA navigation → player match → playback start.
    test.setTimeout(180_000);

    // Console is deliberately NOT asserted here. Reaching the playing state
    // means artplayer mounting on a 144-byte skeleton with no tracks, which
    // logs decode failures by design; player.spec.ts already owns the
    // noise-filtered console assertion for that surface, and a second filtered
    // copy here would be a permanently blind assertion rather than a guard.

    await page.goto("/welcome");
    await clearLibrary(page);
    await seedLibrary(page, {
      series: [
        {
          id: SEQUEL_ID,
          titleZh: SEQUEL_TITLE,
          // The season's own length. This is what makes 13 an overshoot:
          // `normalizeEpisodeNumbers` shifts only when the lowest local main
          // number is already past the end of the season it belongs to.
          totalEpisodes: SEASON_LENGTH,
          episodes: Array.from({ length: SEASON_LENGTH }, (_, i) => ({
            number: SEQUEL_FIRST_STORED + i,
            // Only the episode the player will actually open needs a file
            // behind it; the other eleven exist to size the strip.
            ...(i === 0
              ? {
                  fileRef: {
                    libraryId: SEQUEL_LIBRARY_ID,
                    relPath: SEQUEL_FILE_NAME,
                    size: FIXTURE_BYTES.length,
                  },
                }
              : {}),
          })),
        },
      ],
    });
    await seedOpfsLibraryRoot(page, {
      dirName: SEQUEL_WATCH_DIR,
      libraryId: SEQUEL_LIBRARY_ID,
      fileName: SEQUEL_FILE_NAME,
      bytes: FIXTURE_BYTES,
    });

    await page.goto("/library");
    const grid = page.getByTestId("series-grid");
    await expect(grid).toBeVisible({ timeout: 30_000 });

    // Scoped to the grid — see the note in the merged-card test.
    await grid
      .getByTestId("series-card-root")
      .filter({ hasText: SEQUEL_TITLE })
      .locator('[data-series-card-button="true"]')
      .click();
    const sheet = page.getByTestId("series-detail-sheet");
    await expect(sheet).toBeVisible({ timeout: 30_000 });

    // ── the sheet ────────────────────────────────────────────────────────
    // Twelve chips reading 01-12, in order, and not one of them dead. Before
    // the normalisation the same fixture drew a 24-cell grid whose first
    // twelve cells could never be filled — the count and the labels are two
    // different halves of that defect, so both are asserted.
    const chips = allChips(page);
    await expect(chips).toHaveCount(SEASON_LENGTH, { timeout: 30_000 });
    await expect(chips).toHaveText(
      Array.from({ length: SEASON_LENGTH }, (_, i) => String(i + 1).padStart(2, "0")),
    );
    await expect(
      page.locator('[data-episode-chip="true"][data-state="missing"]'),
      "a renumbered season must not leave dead cells behind",
    ).toHaveCount(0);
    await expect(page.locator('[data-episode-chip="true"][disabled]')).toHaveCount(0);
    await expect(page.getByTestId("episode-grid-unclassified")).toHaveCount(0);

    // ── the hand-off ─────────────────────────────────────────────────────
    // Clicking the chip labelled 01 must ask the player for the STORED number.
    // Both halves of this line matter: a URL carrying 1 would open the wrong
    // file (nothing is filed under 1), and a player that then said "EP13"
    // would contradict the chip the user just pressed.
    await page.getByTestId("episode-chip-1").click();
    await page.waitForURL(/[?&]resumeEpisode=13(&|$)/, { timeout: 30_000 });
    expect(page.url()).toContain(`seriesId=${SEQUEL_ID}`);

    // ── the player ───────────────────────────────────────────────────────
    // The playing header carries an untranslated `EPISODE / 集` eyebrow, which
    // is what tells it apart from the site header without a testid.
    const playHeader = page.locator("header").filter({ hasText: "EPISODE / 集" });
    // Resolved first so a second matching <header> fails as a count mismatch
    // rather than as an opaque strict-mode violation on the assertion below.
    await expect(playHeader).toHaveCount(1, { timeout: 60_000 });
    await expect(playHeader).toBeVisible();
    await expect(
      playHeader,
      "the player header must call the episode what the sheet called it",
    ).toContainText("EP01");
    await expect(playHeader).not.toContainText("EP13");

    // The episode strip, the other surface that labels episodes. Both read
    // `buildEpisodeNavNumbers` against the same group total; if either one
    // ever sourced its total elsewhere, these two assertions disagree.
    const navChips = page.getByRole("button", { name: /^EP\d+$/ });
    await expect(navChips).toHaveCount(SEASON_LENGTH, { timeout: 30_000 });
    await expect(navChips).toHaveText(
      Array.from({ length: SEASON_LENGTH }, (_, i) => `EP${String(i + 1).padStart(2, "0")}`),
    );
    await expect(
      page.getByRole("button", { name: `EP${SEQUEL_FIRST_STORED}` }),
      "no stored number may leak into the strip",
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "EP01" }),
      "the strip must mark the episode the player is actually on",
    ).toHaveAttribute("aria-current", "true");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A title with no episode count keeps its episode section.
//
// `EpisodesGrid` used to open with `if (!episodes || episodes <= 0) return
// null`, so a NULL catalogue count deleted the whole section — and an absent
// section does not read as "we do not know yet", it reads as "this show has no
// episodes". The titles that hit it are disproportionately the ones still
// airing, so the readers who lose the section are the ones most likely to be
// mid-watch.
//
// Its own describe so its teardown belongs to the worker that seeded the row —
// see the note above the first describe.
// ───────────────────────────────────────────────────────────────────────────
test.describe("episode display — the detail page", () => {
  test.afterAll(async () => {
    await removeAnimeFixture(ANI_PENDING);
    await closePg();
  });

  test("an airing title with no episode count still renders a pending section", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors = collectConsoleErrors(page);

    // Both counts NULL and no episode titles — the only combination that
    // resolves to `pending`. `episodesBgm` is pinned explicitly rather than
    // left to the column default: it is a second, independently-written count
    // (migration 0023) and a leftover value in it would quietly move this row
    // to the `inferred` arm, where the section renders for a different reason
    // and this test would pass without testing anything.
    await ensureAnimeDetail({
      anilistId: ANI_PENDING,
      titleChinese: PENDING_TITLE,
      titleRomaji: "Pending Count Fixture",
      episodes: null,
      episodesBgm: null,
      status: "RELEASING",
    });

    const url = `/anime/${ANI_PENDING}`;

    // ── the server html ──────────────────────────────────────────────────
    //
    // `page.request.get` runs no JavaScript, so this is the document a crawler
    // is handed. `EpisodesGrid` is a client component rendered from a server
    // component, and that first paint is its ONLY route into this document —
    // asserting on the hydrated DOM instead would pass just as happily if the
    // server had sent nothing at all.
    const res = await page.request.get(url);
    expect(res.status()).toBe(200);
    const markup = stripScripts(await res.text());

    // Scripts are stripped first because the RSC flight payload is also in
    // this response. Matching the raw body would let a string that only ever
    // appeared inside `self.__next_f.push(...)` satisfy the assertion, and the
    // whole question here is whether the section reached the MARKUP.
    expect(
      markup,
      "the episode section must exist in server-rendered markup, not only after hydration",
    ).toContain(PENDING_SECTION_HEADING);
    expect(
      markup,
      "an unknown count must say so — never an empty region, never a missing section",
    ).toContain(PENDING_COPY);
    expect(markup).toContain(PENDING_HINT_COPY);

    // ── and it is actually on screen ─────────────────────────────────────
    await page.goto(url);
    // `.first()` for the same reason anime-detail.spec.ts uses it: the page's
    // own title is the first h1 and nothing here is asserting how many there
    // are.
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("heading", { name: PENDING_SECTION_HEADING }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(PENDING_HINT_COPY)).toBeVisible();

    await page.waitForLoadState("networkidle");
    expect(errors, `Unexpected console errors:\n${errors.join("\n")}`).toEqual([]);
  });
});

/**
 * Drop every `<script>` block, including the RSC flight payload.
 *
 * Deliberately crude: this only has to separate "rendered into the document"
 * from "shipped as data for the client to render later", and a regex over a
 * response body is the cheapest thing that does it.
 */
function stripScripts(html: string): string {
  return html.replace(/<script\b[\s\S]*?<\/script>/gi, "");
}
