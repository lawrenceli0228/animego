import { test, expect, type Locator, type Page } from "@playwright/test";
import { waitForHydration } from "../../fixtures/hydration";
import { collectConsoleErrors } from "../_helpers";

/**
 * 今日更新 — the homepage's rail of today's episodes.
 *
 * What is pinned:
 *   - on a desktop the row is dragged with the mouse: it scrolls, and letting
 *     go over a card does not open that card — while a plain click still does;
 *     a quick drag flings on after the button is up and comes to rest with a
 *     card flush with the gutter;
 *   - the slider under the row moves it: the thumb dragged, the bare track
 *     clicked, and from the keyboard on its range input (a card at a time —
 *     two quick presses two cards — and the ends), counting stops and saying
 *     which shows are in view; it stays drawn and focusable in forced colours;
 *   - a click that stops a fling opens nothing; a vertical wheel lets it finish;
 *   - the row rises in the first time it scrolls into view, then lets go;
 *   - on a phone a swipe up that starts on the slider scrolls the page, while
 *     a tap on its bare track glides the row;
 *   - the row ends by saying the day is over, with a link to the schedule;
 *   - on a phone every show of the day is its own card (the aired half used
 *     to fold into one tile), the row swipes, and the slider is finger-sized;
 *   - a show that airs while the page is open stays in the row and turns
 *     aired. It used to drop into the phone's fold at its airing minute — the
 *     reported "today's shows suddenly disappear". That case runs on
 *     Playwright's fake clock, set just before a real airing on the page.
 *
 * The rail shows whatever the stack's schedule has for today, so cases that
 * need a row longer than the screen skip when there is none.
 */

const RAIL = "#home-today-rail";

/** The count beside 今日更新 is the number of shows today. */
const headerCount = (page: Page) => page.locator("#home-today + span");

const scrollLeftOf = (rail: Locator) => rail.evaluate((el) => el.scrollLeft);
const maxScrollOf = (rail: Locator) => rail.evaluate((el) => el.scrollWidth - el.clientWidth);

/** Wait until a (possibly smooth) scroll has come to rest, and return where. */
async function settled(rail: Locator): Promise<number> {
  let last = await scrollLeftOf(rail);
  for (let i = 0; i < 40; i++) {
    await rail.page().waitForTimeout(80);
    const now = await scrollLeftOf(rail);
    if (Math.abs(now - last) < 0.5) return now;
    last = now;
  }
  return last;
}

/** The slider under the row (aria-hidden: its range input is what assistive technology uses). */
const sliderOf = (page: Page) => page.locator('section[aria-labelledby="home-today"] [data-overflow]');

/** Where the rail may come to rest: an item flush with the gutter, or either end. */
const stopsOf = (rail: Locator) =>
  rail.evaluate((el) => {
    const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
    const max = el.scrollWidth - el.clientWidth;
    const items = Array.from(el.children, (c) => Math.min(max, Math.max(0, (c as HTMLElement).offsetLeft - pad)));
    return [0, max, ...items];
  });

async function expectAtAStop(rail: Locator, at: number) {
  const stops = await stopsOf(rail);
  expect(stops.some((stop) => Math.abs(stop - at) <= 1), `rest at ${at}, stops ${stops.join(", ")}`).toBe(true);
}

/**
 * Hydrated is not the same as settled in: the rail's effects — where it opens,
 * the slider's first measurement, whether it will rise in — run after React has
 * attached to the DOM, and on a dev server noticeably after. Acting before them
 * means the opening scroll lands in the middle of the test. The slider's spoken
 * value is written by that first measurement.
 */
async function railSettledIn(page: Page) {
  await waitForHydration(page, `${RAIL} a`);
  await expect(page.getByRole("slider", { name: "横向滚动今日更新" })).toHaveAttribute("aria-valuetext", /\S/);
}

async function openRail(page: Page): Promise<Locator | null> {
  await page.goto("/");
  const rail = page.locator(RAIL);
  if ((await rail.count()) === 0) return null;
  await railSettledIn(page);
  return rail;
}

test.describe("今日更新 on a desktop", () => {
  test("dragging the row scrolls it, and letting go over a card does not open the card", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const rail = await openRail(page);
    test.skip(rail === null, "nothing airs today in this stack");
    const max = await maxScrollOf(rail!);
    // The 260px drag below needs the farther end to be more than 200px away.
    test.skip(max < 450, "today's row is too short to drag along here");

    await rail!.scrollIntoViewIfNeeded();
    const before = await scrollLeftOf(rail!);
    const url = page.url();
    // Toward whichever end has room.
    const direction = before < max / 2 ? -1 : 1;
    const box = (await rail!.boundingBox())!;
    const y = box.y + 100; // over a card's cover
    const x0 = box.x + box.width / 2;

    await page.mouse.move(x0, y);
    await page.mouse.down();
    await page.mouse.move(x0 + direction * 260, y, { steps: 12 });
    await expect(rail!).toHaveAttribute("data-dragging", "true");
    await page.mouse.up();

    const after = await scrollLeftOf(rail!);
    expect(Math.abs(after - before)).toBeGreaterThan(200);
    expect(Math.sign(after - before)).toBe(-direction);
    await expect(rail!).not.toHaveAttribute("data-dragging", "true");
    // Released over a card: still on the homepage. (Whatever fling followed
    // the drag has come to rest before the row is moved again.)
    await page.waitForTimeout(600);
    expect(page.url()).toBe(url);
    await settled(rail!);

    // A short drag that starts and ends on the same card — the case where a
    // click would land on that card's link — moves the row and opens nothing.
    // From the start of the row, so there is room to move toward the end
    // (the drag above may have left it there).
    await rail!.evaluate((el) => el.scrollTo({ left: 0, behavior: "instant" }));
    const card0 = rail!.locator('a[href*="/anime/"]').nth(1);
    await card0.scrollIntoViewIfNeeded();
    const c = (await card0.boundingBox())!;
    const start = await scrollLeftOf(rail!);
    await page.mouse.move(c.x + c.width / 2 + 20, c.y + 80);
    await page.mouse.down();
    await page.mouse.move(c.x + c.width / 2 - 20, c.y + 80, { steps: 6 });
    await page.mouse.up();
    expect(Math.abs((await scrollLeftOf(rail!)) - start)).toBeGreaterThan(20);
    await page.waitForTimeout(600);
    expect(page.url()).toBe(url);
    await settled(rail!);

    // Checked before leaving: what the detail page logs is not this test's.
    expect(errors, `Unexpected console errors:\n${errors.join("\n")}`).toEqual([]);

    // A plain click on a card still opens it.
    const card = rail!.locator('a[href*="/anime/"]').first();
    await card.scrollIntoViewIfNeeded();
    const href = await card.getAttribute("href");
    await card.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
  });

  test("a quick drag flings on after the button is up, and comes to rest on a card", async ({ page }) => {
    const rail = await openRail(page);
    test.skip(rail === null, "nothing airs today in this stack");
    const max = await maxScrollOf(rail!);
    test.skip(max < 600, "today's row is too short to fling along here");

    await rail!.scrollIntoViewIfNeeded();
    const box = (await rail!.boundingBox())!;
    const y = box.y + 100;
    const x0 = box.x + box.width * 0.7;

    // Playwright sends the moves back to back: a flick. Its speed is read off
    // the moves' timestamps, and on a loaded machine they can arrive spread
    // out enough to read as a pointer that came to rest (no fling, by design).
    // So a few tries, of which one must carry on — and every one, fling or
    // not, must come to rest on a stop.
    let flung = false;
    for (let attempt = 0; attempt < 3 && !flung; attempt++) {
      await rail!.evaluate((el) => el.scrollTo({ left: 0, behavior: "instant" }));
      await settled(rail!);
      await page.mouse.move(x0, y);
      await page.mouse.down();
      await page.mouse.move(x0 - 240, y, { steps: 6 });
      await page.mouse.up();
      const atRelease = await scrollLeftOf(rail!);
      const rest = await settled(rail!);
      await expectAtAStop(rail!, rest);
      // Carried on past where the button came up (a settle alone moves at most half a card).
      flung = rest > atRelease + 90;
    }
    expect(flung, "none of three flicks carried on after the button was up").toBe(true);
    await expect(rail!).not.toHaveAttribute("data-moving", "true");
  });

  test("the slider moves the row: the thumb dragged, the track clicked, and from the keyboard", async ({ page }) => {
    const rail = await openRail(page);
    test.skip(rail === null, "nothing airs today in this stack");
    const max = await maxScrollOf(rail!);
    // A short day's thumb fills most of the track: too little bare track to click.
    test.skip(max < 450, "today's row is too short for the slider steps here");

    const slider = sliderOf(page);
    await expect(slider).toHaveAttribute("data-overflow", "true");
    const thumb = slider.locator(":scope > span").last();
    await rail!.evaluate((el) => el.scrollTo({ left: 0, behavior: "instant" }));
    await settled(rail!);
    await slider.scrollIntoViewIfNeeded();

    // The thumb, dragged: the row follows, then rests on a card.
    const t = (await thumb.boundingBox())!;
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
    await page.mouse.down();
    await expect(slider).toHaveAttribute("data-active", "true");
    await page.mouse.move(t.x + t.width / 2 + 200, t.y + t.height / 2, { steps: 10 });
    const dragged = await scrollLeftOf(rail!);
    expect(dragged).toBeGreaterThan(150);
    await page.mouse.up();
    const rested = await settled(rail!);
    await expectAtAStop(rail!, rested);

    // The bare track beside the thumb, clicked near that end: the row glides
    // that way and rests at a stop.
    const s = (await slider.boundingBox())!;
    const th = (await thumb.boundingBox())!;
    const roomAfter = s.x + s.width - (th.x + th.width);
    const forward = roomAfter > th.x - s.x;
    await page.mouse.click(forward ? s.x + s.width - 4 : s.x + 4, s.y + s.height / 2);
    if (forward) await expect.poll(() => scrollLeftOf(rail!)).toBeGreaterThan(rested);
    else await expect.poll(() => scrollLeftOf(rail!)).toBeLessThan(rested);
    const glided = await settled(rail!);
    if (forward) expect(glided).toBeGreaterThan(max * 0.75);
    else expect(glided).toBeLessThan(max * 0.25);
    await expectAtAStop(rail!, glided);

    // The keyboard, on the range input in front of the slider. It counts
    // stops, not pixels, so a screen reader's increment moves a card.
    const input = page.getByRole("slider", { name: "横向滚动今日更新" });
    const stops = [...new Set(await stopsOf(rail!))].sort((a, b) => a - b);
    await input.focus();
    await expect(slider).toHaveAttribute("data-active", "true");
    await page.keyboard.press("Home");
    await expect.poll(() => scrollLeftOf(rail!)).toBeLessThanOrEqual(1);
    await settled(rail!);
    await expect(input).toHaveValue("0");
    await expect(input).toHaveAttribute("max", String(stops.length - 1));
    // Two quick presses go two cards on: the second steps from where the
    // first is already gliding to, not from halfway there.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const twoOn = await settled(rail!);
    expect(Math.abs(twoOn - (stops[2] ?? Number.NaN))).toBeLessThanOrEqual(1);
    await expect(input).toHaveValue("2");
    await page.keyboard.press("End");
    await expect.poll(() => scrollLeftOf(rail!)).toBeGreaterThanOrEqual(max - 1);
    await expect(input).toHaveValue(String(stops.length - 1));
    // It says which shows are in view, out of how many.
    const total = await headerCount(page).textContent();
    await expect(input).toHaveAttribute("aria-valuetext", new RegExp(`共 ${total} 部$`));
  });

  test("a click that stops a flinging row opens nothing; a vertical wheel lets a fling finish", async ({ page }) => {
    const rail = await openRail(page);
    test.skip(rail === null, "nothing airs today in this stack");
    const max = await maxScrollOf(rail!);
    test.skip(max < 600, "today's row is too short to fling along here");

    await rail!.scrollIntoViewIfNeeded();
    const url = page.url();
    const box = (await rail!.boundingBox())!;
    const y = box.y + 100;
    const x0 = box.x + box.width * 0.7;
    /**
     * Flick from the start; true when a fling is under way just after. Moving
     * is not enough to tell: a flick read as no fling settles back onto a card,
     * which moves the row too. Only a fling (or a hand on the row) sets
     * data-moving once the button is up.
     */
    const flick = async () => {
      await rail!.evaluate((el) => el.scrollTo({ left: 0, behavior: "instant" }));
      await settled(rail!);
      await page.mouse.move(x0, y);
      await page.mouse.down();
      await page.mouse.move(x0 - 240, y, { steps: 6 });
      await page.mouse.up();
      return (await rail!.getAttribute("data-moving")) === "true";
    };
    const flickTillItFlings = async () => {
      for (let i = 0; i < 3; i++) if (await flick()) return true;
      return false;
    };

    // A vertical wheel over the row scrolls the page; the fling carries on and rests on a stop.
    test.skip(!(await flickTillItFlings()), "no flick carried on (loaded machine)");
    await page.mouse.wheel(0, 120);
    const afterWheel = await scrollLeftOf(rail!);
    await expect.poll(() => scrollLeftOf(rail!)).not.toBe(afterWheel);
    await expectAtAStop(rail!, await settled(rail!));
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(200);

    // A click while it flings stops it — like native momentum, that click is
    // "stop", not "open the card going past" — and the row rests on a stop.
    test.skip(!(await flickTillItFlings()), "no flick carried on (loaded machine)");
    await page.mouse.click(box.x + box.width * 0.5, y);
    const rest = await settled(rail!);
    await page.waitForTimeout(300);
    expect(page.url()).toBe(url);
    await expectAtAStop(rail!, rest);
  });

  test("in forced colours the slider is still drawn and still shows focus", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    const rail = await openRail(page);
    test.skip(rail === null, "nothing airs today in this stack");
    const max = await maxScrollOf(rail!);
    test.skip(max < 120, "today's row fits on one screen here");

    const slider = sliderOf(page);
    const [track, thumb] = [slider.locator(":scope > span").first(), slider.locator(":scope > span").last()];
    // The track keeps a border; the thumb keeps a system colour of its own.
    expect(await track.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("solid");
    const thumbColour = await thumb.evaluate((el) => getComputedStyle(el).backgroundColor);
    const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(thumbColour).not.toBe(ground);
    expect(thumbColour).not.toBe("rgba(0, 0, 0, 0)");
    // Keyboard focus on the range input shows as an outline on the slider.
    // (Script focus alone is not keyboard focus for a range input: a key
    // press makes it so, as Tab would.)
    await page.getByRole("slider", { name: "横向滚动今日更新" }).focus();
    await page.keyboard.press("Shift");
    expect(await slider.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
  });

  test("the row rises in the first time it comes into view, then lets go of the animation", async ({ page }) => {
    await page.goto("/");
    const rail = page.locator(RAIL);
    test.skip((await rail.count()) === 0, "nothing airs today in this stack");
    await railSettledIn(page);
    const onScreen = await rail.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight;
    });
    test.skip(onScreen, "the row is on screen at load here, so it does not rise");
    await expect(rail).not.toHaveAttribute("data-enter", "run");
    await rail.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await expect(rail).toHaveAttribute("data-enter", "run");
    // Dropped once the last item is in, so nothing re-created later rises again.
    await expect(rail).not.toHaveAttribute("data-enter", "run", { timeout: 4000 });
    for (const item of await rail.locator(":scope > *").all()) await expect(item).toHaveCSS("opacity", "1");
  });

  test("the row ends by saying the day is over, with the way to the full schedule", async ({ page }) => {
    const rail = await openRail(page);
    test.skip(rail === null, "nothing airs today in this stack");

    await rail!.scrollIntoViewIfNeeded();
    await rail!.evaluate((el) => el.scrollTo({ left: el.scrollWidth, behavior: "instant" }));
    await expect(rail!.getByText("今天的番就这些")).toBeVisible();
    await expect(rail!.getByRole("link", { name: "看完整放送表" })).toHaveAttribute("href", /\/calendar$/);
    // Not a show: the cards still number what the header says.
    const total = Number(await headerCount(page).textContent());
    await expect(rail!.locator('a[href*="/anime/"]')).toHaveCount(total);
  });
});

test.describe("今日更新 on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("every show of the day is its own card, and the row swipes", async ({ page }) => {
    const rail = await openRail(page);
    test.skip(rail === null, "nothing airs today in this stack");

    const total = Number(await headerCount(page).textContent());
    const cards = rail!.locator('a[href*="/anime/"]');
    await expect(cards).toHaveCount(total);
    for (let i = 0; i < total; i++) await expect(cards.nth(i)).toBeVisible();
    // No fold, no tile standing in for the aired half.
    await expect(rail!.locator("[aria-expanded]")).toHaveCount(0);

    const max = await maxScrollOf(rail!);
    test.skip(max < 120, "today's row fits on one phone screen here");
    // The slider is there, tall enough for a finger.
    const slider = sliderOf(page);
    await expect(slider).toHaveAttribute("data-overflow", "true");
    expect((await slider.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await rail!.scrollIntoViewIfNeeded();
    const before = await settled(rail!);
    const box = (await rail!.boundingBox())!;
    const direction = before < max / 2 ? -1 : 1;
    // A real touch swipe, not a scrollTo: Chromium synthesises the gesture.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.synthesizeScrollGesture", {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + 100),
      xDistance: direction * 240,
      yDistance: 0,
      gestureSourceType: "touch",
      speed: 1200,
    });
    const after = await settled(rail!);
    expect(Math.abs(after - before), `row at ${before} before the swipe, ${after} after`).toBeGreaterThan(60);
  });

  test("on the slider a vertical swipe scrolls the page, and a tap on the bare track glides the row", async ({ page }) => {
    const rail = await openRail(page);
    test.skip(rail === null, "nothing airs today in this stack");
    const max = await maxScrollOf(rail!);
    test.skip(max < 450, "today's row is too short for the slider steps here");

    const slider = sliderOf(page);
    await rail!.evaluate((el) => el.scrollTo({ left: 0, behavior: "instant" }));
    await slider.evaluate((el) => el.scrollIntoView({ block: "center" }));
    expect(await settled(rail!)).toBeLessThanOrEqual(1);
    // The thumb is at the start, so the far end of the track is bare.
    const s = (await slider.boundingBox())!;
    const x = Math.round(s.x + s.width - 6);
    const y = Math.round(s.y + s.height / 2);

    // A swipe up that starts on the slider: the page scrolls and the row stays put.
    // What the slider receives is kept, so a failure says what the browser did.
    await slider.evaluate((el) => {
      const log: string[] = [];
      (window as unknown as { __sliderLog: string[] }).__sliderLog = log;
      for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
        el.addEventListener(type, (e) => log.push(`${type}:${(e as PointerEvent).pointerType}`), true);
      }
    });
    const pageBefore = await page.evaluate(() => window.scrollY);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.synthesizeScrollGesture", {
      x,
      y,
      xDistance: 0,
      yDistance: -200,
      gestureSourceType: "touch",
      speed: 800,
    });
    try {
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(pageBefore + 40);
    } catch (err) {
      const seen = await page.evaluate(() => (window as unknown as { __sliderLog: string[] }).__sliderLog.join(" "));
      throw new Error(`the page did not scroll (scrollY ${pageBefore}); the slider saw: ${seen || "nothing"}\n${String(err)}`);
    }
    expect(await settled(rail!)).toBeLessThanOrEqual(1);

    // A tap on the bare track: the row glides that way and rests on a stop.
    await slider.evaluate((el) => el.scrollIntoView({ block: "center" }));
    const t = (await slider.boundingBox())!;
    await page.touchscreen.tap(t.x + t.width - 6, t.y + t.height / 2);
    await expect.poll(() => scrollLeftOf(rail!)).toBeGreaterThan(1);
    await expectAtAStop(rail!, await settled(rail!));
  });

  test("a show that airs while the page is open stays in the row, marked aired", async ({ page }) => {
    // Pick a real airing from the row as served…
    const served = await openRail(page);
    test.skip(served === null, "nothing airs today in this stack");
    const times = await served!
      .locator("time[datetime]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("datetime") as string));
    test.skip(times.length === 0, "no airing times on the cards");
    const target = times[Math.floor(times.length / 2)] ?? "";
    const airsAt = Date.parse(target);

    // …and come back two minutes before it.
    await page.clock.install({ time: airsAt - 2 * 60_000 });
    const rail = await openRail(page);
    const card = rail!.locator(`a:has(time[datetime="${target}"])`).first();
    await expect(card).toHaveAttribute("data-state", "soon");
    const total = await rail!.locator('a[href*="/anime/"]').count();

    // Three minutes on, it has aired — and it is still a card in the row.
    await page.clock.fastForward("03:00");
    await expect(card).toHaveAttribute("data-state", "aired");
    await expect(card).toBeVisible();
    await expect(card).toContainText("已播");
    await expect(rail!.locator('a[href*="/anime/"]')).toHaveCount(total);

    // In view in the row, too, not merely laid out somewhere off to the side.
    await card.evaluate((el) => {
      const row = el.parentElement as HTMLElement;
      row.scrollLeft = (el as HTMLElement).offsetLeft - 20;
    });
    const rowBox = (await rail!.boundingBox())!;
    const cardBox = (await card.boundingBox())!;
    expect(cardBox.x).toBeGreaterThanOrEqual(rowBox.x - 1);
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
  });
});
