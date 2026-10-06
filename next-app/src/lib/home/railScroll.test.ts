import { describe, expect, test } from "bun:test";
import {
  DRAG_THRESHOLD_PX,
  beginPress,
  maxScrollLeft,
  movePress,
  nowScrollLeft,
  pageScrollLeft,
  railEdges,
  startsDrag,
  suppressesClick,
} from "./railScroll";

// 今日更新's rail on a desktop: dragged with the mouse (a press past the
// threshold is a drag and must not open the card it started on), paged by
// the ← → buttons a card-aligned view at a time, and opened scrolled to 现在.

describe("startsDrag", () => {
  test("only the primary mouse button drags", () => {
    expect(startsDrag("mouse", 0)).toBe(true);
    expect(startsDrag("mouse", 1)).toBe(false);
    expect(startsDrag("mouse", 2)).toBe(false);
  });

  test("touch and pen scroll the row natively, not through the drag", () => {
    expect(startsDrag("touch", 0)).toBe(false);
    expect(startsDrag("pen", 0)).toBe(false);
  });
});

describe("a press on the rail", () => {
  const press = beginPress(7, 500, 120);

  test("small wobbles stay a click", () => {
    const moved = movePress(press, 500 + DRAG_THRESHOLD_PX);
    expect(moved.press.dragging).toBe(false);
    expect(moved.started).toBe(false);
    expect(moved.scrollLeft).toBeNull();
    expect(suppressesClick(moved.press)).toBe(false);
  });

  test("past the threshold it becomes a drag, once, and the rail follows the pointer", () => {
    const first = movePress(press, 500 - (DRAG_THRESHOLD_PX + 1));
    expect(first.started).toBe(true);
    expect(first.press.dragging).toBe(true);
    // Dragging left by 7 scrolls toward the end by 7.
    expect(first.scrollLeft).toBe(127);

    const second = movePress(first.press, 300);
    expect(second.started).toBe(false);
    expect(second.scrollLeft).toBe(320);
  });

  test("dragging right scrolls back toward the start", () => {
    expect(movePress(press, 600).scrollLeft).toBe(20);
  });

  test("a drag suppresses the click on release — even one that came back to where it began", () => {
    const out = movePress(press, 400).press;
    const back = movePress(out, 500).press;
    expect(back.travel).toBe(100);
    expect(suppressesClick(back)).toBe(true);
    // And the rail follows it back.
    expect(movePress(out, 500).scrollLeft).toBe(120);
  });

  test("a press that never left the threshold lets the click through", () => {
    let p = press;
    for (const x of [502, 497, 503, 499]) p = movePress(p, x).press;
    expect(suppressesClick(p)).toBe(false);
  });
});

describe("railEdges", () => {
  test("at the start of an overflowing rail", () => {
    expect(railEdges({ viewLeft: 0, viewWidth: 1000, contentWidth: 2600 })).toEqual({
      overflow: true,
      atStart: true,
      atEnd: false,
    });
  });

  test("in the middle", () => {
    expect(railEdges({ viewLeft: 800, viewWidth: 1000, contentWidth: 2600 })).toEqual({
      overflow: true,
      atStart: false,
      atEnd: false,
    });
  });

  test("at the end, allowing for a fractional scroll position", () => {
    expect(railEdges({ viewLeft: 1599.5, viewWidth: 1000, contentWidth: 2600 })).toEqual({
      overflow: true,
      atStart: false,
      atEnd: true,
    });
  });

  test("a rail that fits has nothing to page", () => {
    const edges = railEdges({ viewLeft: 0, viewWidth: 1440, contentWidth: 1440 });
    expect(edges.overflow).toBe(false);
    expect(maxScrollLeft({ viewLeft: 0, viewWidth: 1440, contentWidth: 900 })).toBe(0);
  });
});

// A 1440px desktop: an 80px gutter, 148px cards 16px apart.
const PAD = 80;
const STEP = 164;
const cards = (n: number) => Array.from({ length: n }, (_, k) => PAD + k * STEP);
const desk = (viewLeft: number, n = 20) => ({
  viewLeft,
  viewWidth: 1440,
  // Last card's end plus the right-hand gutter.
  contentWidth: PAD + (n - 1) * STEP + 148 + PAD,
});

describe("pageScrollLeft", () => {
  test("forward: the card the right edge cuts becomes the first one shown", () => {
    // Cards 0–6 fit (card 6 ends at 1212 ≤ 1360); card 7 (1228–1376) is cut.
    const target = pageScrollLeft(desk(0), cards(20), PAD, 1);
    expect(target).toBe(cards(20)[7] - PAD);
  });

  test("backward from there comes back to the start", () => {
    expect(pageScrollLeft(desk(1148), cards(20), PAD, -1)).toBe(0);
  });

  test("forward and back again from the middle are mirror images", () => {
    const forward = pageScrollLeft(desk(1148, 30), cards(30), PAD, 1);
    expect(forward).toBe(cards(30)[14] - PAD);
    expect(pageScrollLeft(desk(forward, 30), cards(30), PAD, -1)).toBe(1148);
  });

  test("never pages past either end", () => {
    const g = desk(2000);
    expect(pageScrollLeft(g, cards(20), PAD, 1)).toBe(maxScrollLeft(g));
    expect(pageScrollLeft(desk(100), cards(20), PAD, -1)).toBe(0);
  });

  test("the 现在 marker, narrower than a card, is a stop like any other", () => {
    // Five cards, the 44px marker, then cards again.
    const starts = [...cards(5), PAD + 5 * STEP, ...cards(10).map((s) => s + 5 * STEP + 60)];
    const target = pageScrollLeft(desk(0), starts, PAD, 1);
    expect(starts.map((s) => s - PAD)).toContain(target);
    expect(target).toBeGreaterThan(0);
    expect(target).toBeLessThanOrEqual(1440 - 2 * PAD);
  });

  test("an item wider than the view still moves the rail by a page", () => {
    expect(pageScrollLeft({ viewLeft: 0, viewWidth: 400, contentWidth: 3000 }, [20, 2020], 20, 1)).toBe(360);
  });
});

describe("nowScrollLeft — where the rail opens", () => {
  test("morning: the marker and the next show are in view already, so it does not scroll", () => {
    // Two aired, marker, the rest to come.
    const now = { markerStart: PAD + 2 * STEP, prevStart: PAD + STEP, nextEnd: PAD + 2 * STEP + 60 + 148 };
    expect(nowScrollLeft(desk(0), now, PAD)).toBeNull();
  });

  test("evening on a desktop: the last aired card sits on the gutter, then 现在 and what is next", () => {
    const prevStart = PAD + 9 * STEP;
    const markerStart = prevStart + STEP;
    const now = { markerStart, prevStart, nextEnd: markerStart + 60 + 148 };
    expect(nowScrollLeft(desk(0), now, PAD)).toBe(prevStart - PAD);
  });

  test("on a phone too narrow for all three, the marker goes on the gutter so the next show fits", () => {
    // 390px, 20px gutter, 148px cards 12px apart; three aired.
    const phone = { viewLeft: 0, viewWidth: 390, contentWidth: 20 + 12 * 160 + 20 };
    const prevStart = 20 + 2 * 160;
    const markerStart = prevStart + 160;
    const now = { markerStart, prevStart, nextEnd: markerStart + 56 + 148 };
    expect(nowScrollLeft(phone, now, 20)).toBe(markerStart - 20);
  });

  test("everything aired: it scrolls to the end, where the marker is", () => {
    const n = 15;
    const g = desk(0, n);
    const prevStart = PAD + (n - 1) * STEP;
    const now = { markerStart: prevStart + STEP, prevStart, nextEnd: prevStart + STEP + 44 };
    expect(nowScrollLeft(g, now, PAD)).toBe(Math.min(prevStart - PAD, maxScrollLeft(g)));
  });

  test("nothing aired yet: the marker leads and nothing scrolls", () => {
    expect(nowScrollLeft(desk(0), { markerStart: PAD, prevStart: null, nextEnd: PAD + 60 + 148 }, PAD)).toBeNull();
  });
});
