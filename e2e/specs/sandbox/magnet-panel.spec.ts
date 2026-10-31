import { test, expect, type Locator, type Page, type Route } from "@playwright/test";
import { closePg, ensureAnimeDetail, removeAnimeFixture } from "../../fixtures/pg";
import { collectConsoleErrors } from "../_helpers";

// The magnet panel on /anime/[id] — design A: a drawer from the right on a
// desktop, a sheet from the bottom on a phone.
//
// The two torrent endpoints are answered here with page.route, so the spec
// measures the panel and nothing upstream: the real search fans out to six
// trackers and takes seconds. The magnets are obvious fakes (all zeros plus a
// counter); the repository carries no real ones.
//
// Season two of a franchise whose first season ran 28 episodes, 10 of its
// own: one group numbers the finale "[38]", which the panel has to show as
// episode 10 (the episode-offset answer says 28), not hide or print as 38.
//
// The release-group strip is the homepage's sideways rail: with more groups
// than fit, a slider under it moves it (its thumb dragged by a mouse or a
// finger), and a mouse drags the strip itself without the release picking
// the group it lets go over.

test.use({ storageState: { cookies: [], origins: [] } });

// One worker for the file: every test reads the same seeded row, and
// fullyParallel would otherwise seed and drop it from several workers at once
// (see anime-detail.spec.ts for the 404 that produces).
test.describe.configure({ mode: "serial" });

const ANIME = 990_300_001;
/** A second anime whose answer is long enough to need batching. */
const LONG = 990_300_002;
/** A third, with more release groups than the strip shows at once. */
const WIDE = 990_300_003;
const EPISODES = 10;
const OFFSET = 28;
const COVER = "/mascot-wink.png";

interface Release {
  title: string;
  fansub: string | null;
  source: string;
  size?: string;
}

const RELEASES: Release[] = [
  { title: "[甲字幕组] E2E 磁力番 第二季 - 01 [1080P][简繁内封]", fansub: "甲字幕组", source: "dmhy" },
  { title: "[乙字幕组] E2E 磁力番 第二季 - 03 [720P][简日内嵌]", fansub: "乙字幕组", source: "garden" },
  { title: "[甲字幕组] E2E 磁力番 第二季 [38][1080P][简繁内封]", fansub: "甲字幕组", source: "nyaa", size: "568.0 MiB" },
  { title: "[丙字幕组] E2E 磁力番 第二季 - 05 [1080P][CHT]", fansub: "丙字幕组", source: "mikan" },
  { title: "[甲字幕组] E2E 磁力番 第二季 [01-10 合集][1080P][简繁内封]", fansub: "甲字幕组", source: "dmhy" },
  { title: "[乙字幕组] E2E 磁力番 第二季 - 04 [720P][简日内嵌]", fansub: "乙字幕组", source: "garden" },
  { title: "E2E Magnet Show S2 - 06 [1080p]", fansub: null, source: "nyaa" },
  { title: "[甲字幕组] E2E 磁力番 第二季 - 02 [1080P][简繁内封]", fansub: "甲字幕组", source: "dmhy" },
];

const fakeMagnet = (i: number) => `magnet:?xt=urn:btih:${i.toString(16).padStart(40, "0")}`;

function wire(releases: readonly Release[]) {
  return releases.map((r, i) => ({
    title: r.title,
    magnet: fakeMagnet(i + 1),
    size: r.size ?? "1.2 GiB",
    fansub: r.fansub,
    date: "2026-10-20T12:00:00Z",
    source: r.source,
  }));
}

/** 100 releases from one group: more than two batches of 40. */
const MANY: Release[] = Array.from({ length: 100 }, (_, i) => ({
  title: `[丁字幕组] E2E Long Show - ${String((i % 12) + 1).padStart(2, "0")} v${i} [1080P][简体]`,
  fansub: "丁字幕组",
  source: "dmhy",
}));

/** 24 groups of one to three releases each: wider than the drawer, let alone the sheet. */
const GROUP_COUNT = 24;
const WIDE_RELEASES: Release[] = Array.from({ length: GROUP_COUNT }, (_, g) =>
  Array.from({ length: (g % 3) + 1 }, (_, i) => ({
    title: `[E2E 组 ${g + 1}] E2E Wide Show - ${String(i + 1).padStart(2, "0")} [1080P][简体]`,
    fansub: `E2E 组 ${g + 1}`,
    source: "dmhy",
  })),
).flat();

async function answerTorrents(page: Page) {
  await page.route(
    (url) => url.pathname === "/api/anime/torrents",
    (route: Route) => {
      const id = Number(new URL(route.request().url()).searchParams.get("anilistId"));
      const items = wire(id === LONG ? MANY : id === WIDE ? WIDE_RELEASES : RELEASES);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: items }) });
    },
  );
  await page.route(
    (url) => /^\/api\/anime\/\d+\/episode-offset$/.test(url.pathname),
    (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { known: true, offset: OFFSET } }),
      }),
  );
}

/** The detail page's 磁力资源 button, once React owns it. */
async function magnetButton(page: Page, id: number): Promise<Locator> {
  await page.goto(`/anime/${id}`);
  const button = page.getByRole("button", { name: "磁力资源", exact: true });
  await expect(button).toBeVisible();
  await page.waitForFunction(() => {
    const el = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "磁力资源");
    return !!el && Object.keys(el).some((k) => k.startsWith("__react"));
  });
  return button;
}

async function openPanel(page: Page, id = ANIME): Promise<{ button: Locator; dialog: Locator }> {
  const button = await magnetButton(page, id);
  await button.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-row]").first()).toBeVisible();
  // The panel slides in (.42s); measure where it comes to rest.
  await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  return { button, dialog };
}

const rows = (dialog: Locator) => dialog.locator("[data-row]");
const strip = (dialog: Locator) => dialog.getByRole("group", { name: "字幕组" }).getByRole("button");

async function stripLabels(dialog: Locator): Promise<string[]> {
  return strip(dialog).evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""));
}

/** The strip's scrolling row (its role="group"), and the slider under it (aria-hidden: its range input is what assistive technology uses). */
const stripRail = (dialog: Locator) => dialog.getByRole("group", { name: "字幕组" });
const stripSlider = (dialog: Locator) => dialog.locator("[data-overflow]");

const scrollLeftOf = (rail: Locator) => rail.evaluate((el) => el.scrollLeft);

/** Where the strip may come to rest: a cell first, flush with the gutter, or either end. */
const stopsOf = (rail: Locator) =>
  rail.evaluate((el) => {
    const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
    const max = el.scrollWidth - el.clientWidth;
    const cells = Array.from(el.children, (c) => Math.min(max, Math.max(0, (c as HTMLElement).offsetLeft - pad)));
    return [0, max, ...cells];
  });

const AT_REST = "still, at a stop";

/**
 * Waits for the strip to come to rest on a stop, and returns where. Still is
 * not enough on its own: the settle after a release is a short smooth scroll,
 * and a browser can take longer to start it than the gap between two reads,
 * which then both see the spot it is about to leave.
 */
async function restsAtAStop(rail: Locator): Promise<number> {
  let rest = Number.NaN;
  await expect
    .poll(
      async () => {
        const before = await scrollLeftOf(rail);
        await rail.page().waitForTimeout(120);
        rest = await scrollLeftOf(rail);
        const stops = await stopsOf(rail);
        const still = Math.abs(rest - before) < 0.5;
        const onStop = stops.some((stop) => Math.abs(stop - rest) <= 1);
        return still && onStop ? AT_REST : `at ${rest} (${still ? "still" : "moving"}), stops ${stops.join(", ")}`;
      },
      { timeout: 10_000 },
    )
    .toBe(AT_REST);
  return rest;
}

test.beforeAll(async () => {
  for (const [anilistId, title, romaji] of [
    [ANIME, "E2E 磁力番 第二季", "E2E Magnet Show Season 2"],
    [LONG, "E2E 长列表", "E2E Long Show"],
    [WIDE, "E2E 多字幕组", "E2E Wide Show"],
  ] as const) {
    await ensureAnimeDetail({
      anilistId,
      titleRomaji: romaji,
      titleChinese: title,
      episodes: EPISODES,
      status: "FINISHED",
      coverImageUrl: COVER,
    });
  }
});

test.afterAll(async () => {
  await removeAnimeFixture(ANIME);
  await removeAnimeFixture(LONG);
  await removeAnimeFixture(WIDE);
  await closePg();
});

test.beforeEach(async ({ page }) => {
  await answerTorrents(page);
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("opens as a full-height drawer on the right", async ({ page }) => {
    const { dialog } = await openPanel(page);
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.width)).toBe(620);
    expect(Math.round(box!.x + box!.width)).toBe(1440);
    expect(Math.round(box!.y)).toBe(0);
    expect(Math.round(box!.height)).toBe(900);
    await expect(dialog.getByRole("heading", { name: "E2E 磁力番 第二季" })).toBeVisible();
    await expect(dialog).toContainText("磁力资源 8 / 8 条");
  });

  test("the group strip lists every group, most releases first, and filters the list", async ({ page }) => {
    const { dialog } = await openPanel(page);
    expect(await stripLabels(dialog)).toEqual([
      "全部，8 条",
      "甲字幕组，4 条",
      "乙字幕组，2 条",
      "丙字幕组，1 条",
      "未署名，1 条",
    ]);

    await strip(dialog).filter({ hasText: "乙字幕组" }).click();
    await expect(rows(dialog)).toHaveCount(2);
    await expect(rows(dialog).first()).toContainText("乙字幕组");
    await expect(rows(dialog).nth(1)).toContainText("乙字幕组");
    await expect(dialog).toContainText("磁力资源 2 / 8 条");
    await expect(strip(dialog).filter({ hasText: "乙字幕组" })).toHaveAttribute("aria-pressed", "true");

    await strip(dialog).filter({ hasText: "全部" }).click();
    await expect(rows(dialog)).toHaveCount(8);
  });

  test("the subtitle filter: 简体 and 繁体 include 简繁, 简繁 is only 简繁; the strip counts follow", async ({ page }) => {
    const { dialog } = await openPanel(page);
    const chip = (name: string) => dialog.getByRole("group", { name: "字幕语言" }).getByRole("button", { name, exact: true });

    await chip("繁体").click();
    await expect(rows(dialog)).toHaveCount(5);
    expect(await stripLabels(dialog)).toEqual(["全部，5 条", "甲字幕组，4 条", "丙字幕组，1 条"]);

    await chip("简繁").click();
    await expect(rows(dialog)).toHaveCount(4);
    expect(await stripLabels(dialog)).toEqual(["全部，4 条", "甲字幕组，4 条"]);

    await chip("简体").click();
    await expect(rows(dialog)).toHaveCount(6);
    expect(await stripLabels(dialog)).toEqual(["全部，6 条", "甲字幕组，4 条", "乙字幕组，2 条"]);

    await chip("全部字幕").click();
    await expect(rows(dialog)).toHaveCount(8);
  });

  test("a continuously numbered finale shows as this season's episode; a range shows as a batch", async ({ page }) => {
    const { dialog } = await openPanel(page);
    const finale = rows(dialog).filter({ hasText: "[38]" });
    await expect(finale).toHaveCount(1);
    await expect(finale).toContainText("第 10 集");
    await expect(finale).not.toContainText("第 38 集");
    await expect(rows(dialog).filter({ hasText: "[01-10 合集]" })).toContainText("合集");
    await expect(rows(dialog).filter({ hasText: "- 03" })).toContainText("第 3 集");
    // The size is shown in the units every other source uses.
    await expect(finale).toContainText("568.0 MB");
  });

  test("copy puts the magnet on the clipboard and says so for two seconds", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const { dialog } = await openPanel(page);
    const first = rows(dialog).first();
    const copy = first.getByRole("button", { name: "复制磁力" });
    await copy.click();
    await expect(first.getByRole("button", { name: "已复制" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(fakeMagnet(1));
    await expect(first.getByRole("button", { name: "复制磁力" })).toBeVisible({ timeout: 5000 });
  });

  test("Tab stays in the panel; Escape closes it and gives focus back to the button", async ({ page }) => {
    const { button, dialog } = await openPanel(page);
    for (let i = 0; i < 40; i++) await page.keyboard.press("Tab");
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();
  });

  test("the scrim closes the panel", async ({ page }) => {
    const { dialog } = await openPanel(page);
    await page.mouse.click(200, 450);
    await expect(dialog).toBeHidden();
  });

  test("a long answer renders 40 rows, and 40 more only when the reader scrolls", async ({ page }) => {
    const { dialog } = await openPanel(page, LONG);
    await expect(rows(dialog)).toHaveCount(40);
    // Nobody scrolled: the list must not grow by itself.
    await page.waitForTimeout(800);
    await expect(rows(dialog)).toHaveCount(40);

    const body = rows(dialog).first();
    await body.hover();
    for (let i = 0; i < 12 && (await rows(dialog).count()) === 40; i++) {
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(150);
    }
    await expect(rows(dialog)).toHaveCount(80);

    // The way in that needs no wheel at all (a screen reader, a dragged
    // scrollbar): the button at the end of the list, with what is left.
    const more = dialog.getByRole("button", { name: /显示更多/ });
    await expect(more).toContainText("还有 20 条");
    await more.click();
    await expect(rows(dialog)).toHaveCount(100);
    await expect(more).toHaveCount(0);
  });

  test("with more groups than fit, dragging the slider's thumb scrolls the strip, which rests on a cell", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const { dialog } = await openPanel(page, WIDE);
    const rail = stripRail(dialog);
    const slider = stripSlider(dialog);
    await expect(slider).toHaveAttribute("data-overflow", "true");
    // It says which groups are in view, out of how many ("All" is not one).
    await expect(dialog.getByRole("slider", { name: "横向滚动字幕组" })).toHaveAttribute(
      "aria-valuetext",
      new RegExp(`共 ${GROUP_COUNT} 个$`),
    );
    expect(await scrollLeftOf(rail)).toBe(0);

    const thumb = slider.locator(":scope > span").last();
    const t = (await thumb.boundingBox())!;
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
    await page.mouse.down();
    await expect(slider).toHaveAttribute("data-dragging", "true");
    await page.mouse.move(t.x + t.width / 2 + 200, t.y + t.height / 2, { steps: 10 });
    expect(await scrollLeftOf(rail)).toBeGreaterThan(300);
    await page.mouse.up();
    await expect(slider).not.toHaveAttribute("data-dragging", "true");
    await restsAtAStop(rail);
    // Moving the strip picks nothing.
    await expect(strip(dialog).filter({ hasText: "全部" })).toHaveAttribute("aria-pressed", "true");

    expect(errors, `Unexpected console errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("a mouse drag along the strip scrolls it and leaves the selected group alone; a plain click still picks one", async ({ page }) => {
    const { dialog } = await openPanel(page, WIDE);
    const rail = stripRail(dialog);
    const total = `磁力资源 ${WIDE_RELEASES.length} / ${WIDE_RELEASES.length} 条`;
    await expect(dialog).toContainText(total);

    // Pressed on a cell well inside the strip, dragged toward its start, let go over another cell.
    const box = (await rail.boundingBox())!;
    const y = box.y + box.height / 2;
    const x0 = box.x + 420;
    await page.mouse.move(x0, y);
    await page.mouse.down();
    await page.mouse.move(x0 - 300, y, { steps: 12 });
    await expect(rail).toHaveAttribute("data-dragging", "true");
    expect(await scrollLeftOf(rail)).toBeGreaterThan(250);
    await page.mouse.up();
    await expect(rail).not.toHaveAttribute("data-dragging", "true");
    await restsAtAStop(rail);

    await expect(strip(dialog).filter({ hasText: "全部" })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog).toContainText(total);

    // A click with no drag picks the group.
    const cell = strip(dialog).nth(5);
    const label = (await cell.getAttribute("aria-label")) ?? "";
    const count = Number(/(\d+) 条$/.exec(label)?.[1]);
    await cell.click();
    await expect(cell).toHaveAttribute("aria-pressed", "true");
    await expect(rows(dialog)).toHaveCount(count);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("opens as a bottom sheet with 44px buttons and no sideways overflow", async ({ page }) => {
    const { dialog } = await openPanel(page);
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.x)).toBe(0);
    expect(Math.round(box!.width)).toBe(390);
    expect(Math.round(box!.y)).toBe(34);
    expect(Math.round(box!.y + box!.height)).toBe(844);

    const first = rows(dialog).first();
    const copy = await first.getByRole("button", { name: "复制磁力" }).boundingBox();
    const open = await first.getByRole("button", { name: "用下载工具打开" }).boundingBox();
    expect(copy!.height).toBeGreaterThanOrEqual(44);
    expect(open!.height).toBeGreaterThanOrEqual(44);
    expect(open!.width).toBeGreaterThanOrEqual(44);
    expect(copy!.width).toBeGreaterThan(open!.width * 3);

    const overflow = await page.evaluate(() => {
      const panel = document.querySelector('[role="dialog"]') as HTMLElement;
      const rowsRight = Array.from(panel.querySelectorAll("[data-row]")).map((r) => r.getBoundingClientRect().right);
      return {
        page: document.documentElement.scrollWidth - window.innerWidth,
        panel: panel.scrollWidth - panel.clientWidth,
        rows: Math.max(...rowsRight) - window.innerWidth,
      };
    });
    expect(overflow.page).toBeLessThanOrEqual(0);
    expect(overflow.panel).toBeLessThanOrEqual(0);
    expect(overflow.rows).toBeLessThanOrEqual(0);
  });

  test("a finger's swipe loads the next 40 rows", async ({ page }) => {
    const { dialog } = await openPanel(page, LONG);
    await expect(rows(dialog)).toHaveCount(40);
    for (let i = 0; i < 14 && (await rows(dialog).count()) === 40; i++) {
      await swipe(page, { x: 195, y: 760 }, { x: 0, y: -560 });
      await page.waitForTimeout(200);
    }
    await expect(rows(dialog)).toHaveCount(80);
  });

  test("the strip's slider is finger-sized, and a finger sliding its thumb carries the strip all the way", async ({ page }) => {
    const { dialog } = await openPanel(page, WIDE);
    const rail = stripRail(dialog);
    const slider = stripSlider(dialog);
    await expect(slider).toHaveAttribute("data-overflow", "true");
    const s = (await slider.boundingBox())!;
    expect(s.height).toBeGreaterThanOrEqual(44);
    expect(await scrollLeftOf(rail)).toBe(0);

    // The finger lands on the thumb, which the browser hands the press to,
    // and the slider takes it over once the finger slides. The strip must
    // follow to the end of the slide, not let go after its first move.
    const t = (await slider.locator(":scope > span").last().boundingBox())!;
    await swipe(page, { x: t.x + t.width / 2, y: s.y + s.height / 2 }, { x: 120, y: 0 });
    const rest = await restsAtAStop(rail);
    expect(rest, `a 120px slide on a ${Math.round(s.width)}px track left the strip at ${rest}`).toBeGreaterThan(600);
    await expect(strip(dialog).filter({ hasText: "全部" })).toHaveAttribute("aria-pressed", "true");

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

/**
 * A finger put down at `from`, dragged by `by`, and lifted — raw touch events,
 * the way a touchscreen sends them. `Input.synthesizeScrollGesture` with a
 * touch source scrolls nothing in Chromium on Linux (see today-rail.spec.ts).
 */
async function swipe(page: Page, from: { x: number; y: number }, by: { x: number; y: number }) {
  const steps = 12;
  const cdp = await page.context().newCDPSession(page);
  const point = (i: number) => ({
    x: Math.round(from.x + (by.x * i) / steps),
    y: Math.round(from.y + (by.y * i) / steps),
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(0)] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(i)] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}
