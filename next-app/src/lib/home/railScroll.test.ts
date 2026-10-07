import { describe, expect, test } from "bun:test";
import {
  DRAG_THRESHOLD_PX,
  ENTER_ORDER_CAP,
  FLING_REST_MS,
  GLIDE_FRICTION,
  GLIDE_MIN_SPEED,
  THUMB_MIN_PCT,
  beginPress,
  enterOrder,
  glideStep,
  grabOffset,
  itemsInView,
  maxScrollLeft,
  movePress,
  nearestStop,
  nowScrollLeft,
  pageScrollLeft,
  railEdges,
  railStops,
  releaseVelocity,
  releasedElsewhere,
  scrollForPointer,
  startsDrag,
  stepStop,
  suppressesClick,
  thumbFor,
} from "./railScroll";

// 今日更新's rail: dragged with the mouse (a press past the threshold is a
// drag and must not open the card it started on; a fling carries on and
// comes to rest on a card), moved with the slider under it (dragged, clicked,
// or from the keyboard a card or a page at a time), and opened scrolled to 现在.

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

describe("releasedElsewhere", () => {
  test("a move with the primary button up belongs to no press", () => {
    expect(releasedElsewhere(0)).toBe(true);
    // Only the secondary or the middle button held: still not our press.
    expect(releasedElsewhere(2)).toBe(true);
    expect(releasedElsewhere(4)).toBe(true);
  });

  test("the primary button still down, alone or with others: the press goes on", () => {
    expect(releasedElsewhere(1)).toBe(false);
    expect(releasedElsewhere(3)).toBe(false);
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

describe("thumbFor — the slider's thumb", () => {
  test("as wide as the share of the row in view, at the start when the rail is", () => {
    const g = desk(0);
    const thumb = thumbFor(g);
    expect(thumb.widthPct).toBeCloseTo((1440 / g.contentWidth) * 100, 6);
    expect(thumb.leftPct).toBe(0);
  });

  test("at the far end of the track when the rail is at its end", () => {
    const g = desk(0);
    const end = thumbFor({ ...g, viewLeft: maxScrollLeft(g) });
    expect(end.leftPct + end.widthPct).toBeCloseTo(100, 6);
  });

  test("halfway along the rail, halfway along the room the track has", () => {
    const g = desk(0);
    const half = thumbFor({ ...g, viewLeft: maxScrollLeft(g) / 2 });
    expect(half.leftPct).toBeCloseTo((100 - half.widthPct) / 2, 6);
  });

  test("never thinner than the minimum, so a very long day stays grabbable", () => {
    const long = { viewLeft: 0, viewWidth: 390, contentWidth: 390 * 100 };
    expect(thumbFor(long).widthPct).toBe(THUMB_MIN_PCT);
    expect(thumbFor(long, 10).widthPct).toBe(10);
  });

  test("a row that fits fills the track and has nowhere to go", () => {
    expect(thumbFor({ viewLeft: 0, viewWidth: 1440, contentWidth: 900 })).toEqual({ widthPct: 100, leftPct: 0 });
  });

  test("a fractional position past either end stays on the track", () => {
    const g = desk(0);
    expect(thumbFor({ ...g, viewLeft: -3 }).leftPct).toBe(0);
    const over = thumbFor({ ...g, viewLeft: maxScrollLeft(g) + 3 });
    expect(over.leftPct + over.widthPct).toBeCloseTo(100, 6);
  });
});

describe("dragging the thumb", () => {
  const TRACK = 1280;
  const thumb = { widthPct: 25, leftPct: 30 };

  test("pressed on the thumb, the spot taken hold of stays under the pointer", () => {
    // The thumb covers 384–704 on a 1280px track.
    expect(grabOffset(thumb, TRACK, 400)).toEqual({ onThumb: true, grab: 16 });
    expect(grabOffset(thumb, TRACK, 704)).toEqual({ onThumb: true, grab: 320 });
  });

  test("pressed on the bare track, the thumb is taken by its middle", () => {
    expect(grabOffset(thumb, TRACK, 100)).toEqual({ onThumb: false, grab: 160 });
    expect(grabOffset(thumb, TRACK, 1200)).toEqual({ onThumb: false, grab: 160 });
  });

  test("moving the pointer moves the rail in proportion, and back again", () => {
    const g = desk(0);
    const t = thumbFor(g);
    const room = TRACK * (1 - t.widthPct / 100);
    const grab = 10;
    expect(scrollForPointer(g, t, TRACK, grab, grab)).toBe(0);
    expect(scrollForPointer(g, t, TRACK, grab + room / 2, grab)).toBeCloseTo(maxScrollLeft(g) / 2, 6);
    expect(scrollForPointer(g, t, TRACK, grab + room, grab)).toBeCloseTo(maxScrollLeft(g), 6);
  });

  test("past either end of the track the rail stops at its own end", () => {
    const g = desk(0);
    const t = thumbFor(g);
    expect(scrollForPointer(g, t, TRACK, -500, 10)).toBe(0);
    expect(scrollForPointer(g, t, TRACK, 5000, 10)).toBe(maxScrollLeft(g));
  });

  test("a thumb that fills the track moves nothing", () => {
    const fits = { viewLeft: 0, viewWidth: 1440, contentWidth: 900 };
    expect(scrollForPointer(fits, thumbFor(fits), TRACK, 600, 10)).toBe(0);
  });
});

describe("where the rail comes to rest", () => {
  test("its stops are every item flush with the gutter, and both ends", () => {
    const g = desk(0, 20);
    const stops = railStops(g, cards(20), PAD);
    expect(stops[0]).toBe(0);
    expect(stops[stops.length - 1]).toBe(maxScrollLeft(g));
    expect(stops).toContain(cards(20)[3] - PAD);
    // Sorted, each once, nothing past the end.
    expect([...stops].sort((a, b) => a - b)).toEqual(stops);
    expect(new Set(stops).size).toBe(stops.length);
    expect(Math.max(...stops)).toBe(maxScrollLeft(g));
  });

  test("a release between two cards settles on the nearer one", () => {
    const stops = railStops(desk(0, 20), cards(20), PAD);
    expect(nearestStop(3 * STEP + 40, stops)).toBe(3 * STEP);
    expect(nearestStop(3 * STEP + 120, stops)).toBe(4 * STEP);
  });

  test("a release past the last card's stop settles at the end", () => {
    const g = desk(0, 20);
    const stops = railStops(g, cards(20), PAD);
    expect(nearestStop(maxScrollLeft(g) - 2, stops)).toBe(maxScrollLeft(g));
  });

  test("the slider's arrow keys go a stop at a time, and stay at an end", () => {
    const g = desk(0, 20);
    const stops = railStops(g, cards(20), PAD);
    expect(stepStop(g, stops, 1)).toBe(STEP);
    expect(stepStop({ ...g, viewLeft: STEP }, stops, 1)).toBe(2 * STEP);
    expect(stepStop({ ...g, viewLeft: STEP + 30 }, stops, -1)).toBe(STEP);
    expect(stepStop(g, stops, -1)).toBe(0);
    const end = { ...g, viewLeft: maxScrollLeft(g) };
    expect(stepStop(end, stops, 1)).toBe(maxScrollLeft(g));
  });
});

describe("a fling", () => {
  const samples = [
    { t: 1000, x: 900 },
    { t: 1016, x: 860 },
    { t: 1032, x: 820 },
    { t: 1048, x: 780 },
  ];

  test("the speed at release is read off the last moves, in px per ms", () => {
    expect(releaseVelocity(samples, 1050)).toBeCloseTo(-120 / 48, 6);
  });

  test("a pointer that came to rest before letting go has no fling", () => {
    expect(releaseVelocity(samples, 1048 + FLING_REST_MS + 1)).toBe(0);
  });

  test("one sample, or none, is no speed at all", () => {
    expect(releaseVelocity([], 0)).toBe(0);
    expect(releaseVelocity([{ t: 5, x: 5 }], 6)).toBe(0);
  });

  test("only the recent moves count: an old slow start does not water the speed down", () => {
    const late = [{ t: 0, x: 1000 }, ...samples];
    expect(releaseVelocity(late, 1050)).toBeCloseTo(-120 / 48, 6);
  });

  test("each frame moves the rail by the speed and loses some of it, more over a longer frame", () => {
    const one = glideStep(2, 16);
    expect(one.dx).toBe(32);
    expect(one.velocity).toBeCloseTo(2 * GLIDE_FRICTION, 9);
    const two = glideStep(2, 32);
    expect(two.velocity).toBeCloseTo(2 * GLIDE_FRICTION * GLIDE_FRICTION, 9);
  });

  test("a fling dies out in a sensible time and distance", () => {
    let v = 3; // a quick flick
    let travelled = 0;
    let frames = 0;
    while (Math.abs(v) >= GLIDE_MIN_SPEED && frames < 1000) {
      const step = glideStep(v, 16);
      travelled += step.dx;
      v = step.velocity;
      frames += 1;
    }
    expect(frames).toBeLessThan(90); // under 1.5 s
    expect(travelled).toBeGreaterThan(400);
    expect(travelled).toBeLessThan(1200);
  });
});

describe("itemsInView — what the slider says the reader is looking at", () => {
  const boxes = (n: number) => cards(n).map((start) => ({ start, width: 148 }));

  test("at the start of a desktop row: the cards whose middle is between the gutters", () => {
    // Card 7 runs 1228–1376: its middle (1302) is short of the right gutter (1360); card 8's is not.
    expect(itemsInView(desk(0), boxes(20), PAD)).toEqual({ first: 1, last: 8 });
  });

  test("scrolled along: a card whose middle has gone into the left gutter no longer counts", () => {
    expect(itemsInView(desk(STEP * 3 + 120), boxes(20), PAD)).toEqual({ first: 5, last: 12 });
  });

  test("an empty row shows nothing", () => {
    expect(itemsInView(desk(0), [], PAD)).toBeNull();
  });
});

describe("enterOrder — the order the cards rise in", () => {
  const boxes = (n: number) => cards(n).map((start) => ({ start, width: 148 }));

  test("the cards on screen rise left to right; the rest wait at the back", () => {
    const order = enterOrder(desk(STEP * 4), boxes(20));
    expect(order.slice(4, 12)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(order[0]).toBe(ENTER_ORDER_CAP);
    expect(order[19]).toBe(ENTER_ORDER_CAP);
  });

  test("never past the cap, however many are on screen", () => {
    const wide = { viewLeft: 0, viewWidth: 5000, contentWidth: 5000 };
    expect(Math.max(...enterOrder(wide, boxes(30)))).toBe(ENTER_ORDER_CAP);
  });
});
