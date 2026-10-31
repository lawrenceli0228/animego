// The magnet panel's release-group strip, mounted in a real DOM: the slider
// under it is there only while the groups do not all fit (including when they
// arrive after the strip is already on screen, as the list landing does), a
// mouse drag along the strip scrolls it without picking the group it was let
// go over, a plain click still picks, and the slider's range input moves the
// strip from the keyboard. Runs in its own bun process (domSuites.test.ts).
//
// jsdom lays nothing out, so the geometry is set by hand: every cell is CELL
// px wide, STEP px after the one before it (from 0: no gutter), and the rail
// is VIEW px wide with room for all of them. The layout APIs the rail hooks
// reach for — ResizeObserver, matchMedia, pointer capture, element scrolling —
// are stood in for below, before the component loads. Reduced motion is on,
// so every scroll the hooks ask for lands at once.

import { mount, press, settle, unmountAll } from "@/lib/test-utils/domHarness";

import { afterEach, describe, expect, test } from "bun:test";
import { act, useEffect, useState } from "react";
import type { FansubCell } from "@/lib/magnet/list";

const CELL = 112;
const STEP = 116;
const VIEW = 600;
/** More than a frame: the slider measures on the next animation frame. */
const FRAME_MS = 40;

// ─── What jsdom does not have ───────────────────────────────────────────

const observers = new Set<FakeResizeObserver>();

class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    observers.add(this);
    // A real one reports once on observe(), which is the slider's first measurement.
    this.report();
  }
  unobserve() {}
  disconnect() {
    observers.delete(this);
  }
  report() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

window.matchMedia = (query: string) =>
  ({
    matches: query.includes("prefers-reduced-motion: reduce"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

const indexInParent = (el: Element) => (el.parentElement ? Array.from(el.parentElement.children).indexOf(el) : 0);

Object.assign(window.HTMLElement.prototype, {
  setPointerCapture() {},
  releasePointerCapture() {},
  hasPointerCapture: () => false,
  scrollIntoView() {},
  scrollTo(this: HTMLElement, options?: ScrollToOptions) {
    if (typeof options?.left === "number") this.scrollLeft = options.left;
  },
});

// The cells: where each one sits in the rail.
Object.defineProperties(window.HTMLButtonElement.prototype, {
  offsetLeft: { configurable: true, get: (function (this: HTMLElement) { return indexInParent(this) * STEP; }) },
  offsetWidth: { configurable: true, get: () => CELL },
});

/** The rail: VIEW wide, as wide inside as its cells, scrolled to wherever it was last put (within its ends). */
function layOut(rail: HTMLElement) {
  let left = 0;
  const content = () => rail.children.length * STEP;
  Object.defineProperties(rail, {
    clientWidth: { configurable: true, get: () => VIEW },
    scrollWidth: { configurable: true, get: () => Math.max(VIEW, content()) },
    scrollLeft: {
      configurable: true,
      get: () => left,
      set: (value: number) => {
        left = Math.max(0, Math.min(Math.max(0, content() - VIEW), value));
      },
    },
  });
}

const { default: FansubStrip } = await import("./FansubStrip");
const { default: zh } = await import("@/locales/zh-spa.js");

// ─── The strip, with the panel's part played by the test ─────────────────

/** Every group the strip was asked to pick, in order. */
const picks: Array<string | null> = [];

const SWAP = "test:cells";

function Harness({ initial }: { initial: FansubCell[] }) {
  const [cells, setCells] = useState(initial);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const swap = (e: Event) => setCells((e as CustomEvent<FansubCell[]>).detail);
    window.addEventListener(SWAP, swap);
    return () => window.removeEventListener(SWAP, swap);
  }, []);
  return (
    <FansubStrip
      cells={cells}
      selected={selected}
      pending={false}
      onPick={(key) => {
        picks.push(key);
        setSelected(key);
      }}
    />
  );
}

/** "All" and `groups` groups, most releases first. */
function cellsOf(groups: number): FansubCell[] {
  const named = Array.from({ length: groups }, (_, i) => ({ key: `字幕组${i + 1}`, count: groups - i }));
  return [{ key: null, count: named.reduce((n, c) => n + c.count, 0) }, ...named];
}

interface Strip {
  rail: HTMLElement;
  input: HTMLInputElement;
  slider: HTMLElement;
  cell: (name: string) => HTMLButtonElement;
  pressed: () => string | null;
}

async function mountStrip(groups: number): Promise<Strip> {
  const host = await mount(<Harness initial={cellsOf(groups)} />);
  const rail = host.querySelector<HTMLElement>(`[role="group"][aria-label="${zh.torrent.fansubsAria}"]`);
  const input = host.querySelector<HTMLInputElement>('input[type="range"]');
  const slider = host.querySelector<HTMLElement>("[data-overflow]");
  if (!rail || !input || !slider) throw new Error("the strip, its range input and its slider should all render");
  layOut(rail);
  // The rail has just been "laid out": it reports its size.
  for (const o of observers) o.report();
  await settle(FRAME_MS);
  const cell = (name: string) => {
    const found = Array.from(rail.querySelectorAll("button")).find((b) => b.querySelector("b")?.textContent === name);
    if (!found) throw new Error(`no cell named "${name}"`);
    return found;
  };
  const pressed = () => rail.querySelector('[aria-pressed="true"] b')?.textContent ?? null;
  return { rail, input, slider, cell, pressed };
}

/** A pointer event, sent the way a browser sends it: to the element under the pointer, bubbling. */
function pointer(target: Element, type: string, clientX: number, buttons: number, pointerType = "mouse"): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType,
      isPrimary: true,
      button: 0,
      buttons,
      clientX,
      clientY: 20,
    }),
  );
}

/** The click a browser sends after a press and release on the same element, in the same task as the release. */
async function pressAndRelease(target: HTMLElement, path: readonly number[]): Promise<void> {
  const [start = 0, ...moves] = path;
  await act(async () => {
    pointer(target, "pointerdown", start, 1);
  });
  for (const x of moves) {
    await act(async () => {
      pointer(target, "pointermove", x, 1);
    });
  }
  await act(async () => {
    pointer(target, "pointerup", path[path.length - 1] ?? start, 0);
    target.click();
  });
}

afterEach(async () => {
  await unmountAll();
  observers.clear();
  picks.length = 0;
});

// ─── The cases ──────────────────────────────────────────────────────────

describe("the release-group strip", () => {
  test("the slider is not there while every group fits", async () => {
    const strip = await mountStrip(3);

    expect(strip.slider.getAttribute("data-overflow")).toBe("false");
    // Not a stop for Tab and not announced either: there is nowhere to slide to.
    expect(strip.input.hidden).toBe(true);
    expect(strip.input.disabled).toBe(true);
  });

  test("the slider appears once there are more groups than fit, including when they arrive later", async () => {
    // Loading: only "All" is in the strip.
    const strip = await mountStrip(0);
    expect(strip.slider.getAttribute("data-overflow")).toBe("false");

    // The list lands with 19 groups. The rail keeps its size, so nothing but
    // the strip itself can tell the slider to measure again.
    await act(async () => {
      window.dispatchEvent(new CustomEvent(SWAP, { detail: cellsOf(19) }));
    });
    await settle(FRAME_MS);

    expect(strip.slider.getAttribute("data-overflow")).toBe("true");
    expect(strip.input.hidden).toBe(false);
    expect(strip.input.disabled).toBe(false);
    expect(strip.input.getAttribute("aria-label")).toBe(zh.torrent.fansubScroll);
    expect(strip.input.getAttribute("aria-controls")).toBe(strip.rail.id);
    // It says which groups are in view, out of how many ("All" is not one of them).
    expect(strip.input.getAttribute("aria-valuetext")).toBe("第 1–4 个，共 19 个");

    // A subtitle filter leaves two groups: it fits again.
    await act(async () => {
      window.dispatchEvent(new CustomEvent(SWAP, { detail: cellsOf(2) }));
    });
    await settle(FRAME_MS);
    expect(strip.slider.getAttribute("data-overflow")).toBe("false");
  });

  test("a mouse drag along the strip scrolls it, and letting go over a cell does not pick that cell", async () => {
    const strip = await mountStrip(19);
    const over = strip.cell("字幕组2");

    await act(async () => {
      pointer(over, "pointerdown", 300, 1);
    });
    for (const x of [295, 280, 250, 220]) {
      await act(async () => {
        pointer(over, "pointermove", x, 1);
      });
    }
    // The strip follows the mouse: dragged 80px left, it has scrolled 80px on.
    expect(strip.rail.scrollLeft).toBe(80);
    expect(strip.rail.getAttribute("data-dragging")).toBe("true");

    await act(async () => {
      pointer(over, "pointerup", 220, 0);
      over.click();
    });

    expect(picks).toEqual([]);
    expect(strip.pressed()).toBe("全部");
    expect(strip.rail.getAttribute("data-dragging")).toBeNull();
    // Let go, it comes to rest with a cell first rather than mid-cell.
    expect(strip.rail.scrollLeft % STEP).toBe(0);

    // The click after it is a click again.
    await pressAndRelease(over, [220]);
    expect(picks).toEqual(["字幕组2"]);
  });

  test("a plain click picks the group, even with a little wobble under the drag threshold", async () => {
    const strip = await mountStrip(19);

    await pressAndRelease(strip.cell("字幕组3"), [300]);
    expect(picks).toEqual(["字幕组3"]);
    expect(strip.pressed()).toBe("字幕组3");

    await pressAndRelease(strip.cell("字幕组1"), [300, 302, 297]);
    expect(picks).toEqual(["字幕组3", "字幕组1"]);
    expect(strip.pressed()).toBe("字幕组1");
    expect(strip.rail.scrollLeft).toBe(0);
  });

  test("a finger sliding the thumb keeps hold of it when the press passes from the thumb to the slider", async () => {
    const strip = await mountStrip(19);
    // The track spans the rail's width; the thumb, a quarter of it, starts at its left end.
    strip.slider.getBoundingClientRect = () => new DOMRect(0, 0, VIEW, 44);
    const thumb = strip.slider.lastElementChild;
    if (!thumb) throw new Error("the slider should hold a thumb");
    const finger = (type: string, x: number, buttons = 1) =>
      act(async () => {
        pointer(thumb, type, x, buttons, "touch");
      });

    await finger("pointerdown", 40);
    await finger("pointermove", 60);
    const first = strip.rail.scrollLeft;
    expect(first).toBeGreaterThan(0);
    // The browser moves the capture from the thumb (taken when the finger
    // landed) to the slider (taken on that first slide): the thumb hears it lost.
    await finger("lostpointercapture", 60);
    await finger("pointermove", 260);

    expect(strip.slider.getAttribute("data-dragging")).toBe("true");
    expect(strip.rail.scrollLeft).toBeGreaterThan(first + 500);

    await finger("pointerup", 260, 0);
    expect(strip.slider.getAttribute("data-dragging")).toBeNull();
    // Let go, it comes to rest with a cell first.
    expect(strip.rail.scrollLeft % STEP).toBe(0);
    expect(picks).toEqual([]);
  });

  test("the range input moves the strip from the keyboard, a cell at a time and to either end", async () => {
    const strip = await mountStrip(19);
    // Focus shows the slider at full size: a state update of its own.
    await act(async () => {
      strip.input.focus();
    });
    expect(strip.slider.getAttribute("data-active")).toBe("true");

    await press("ArrowRight");
    expect(strip.rail.scrollLeft).toBe(STEP);
    await press("ArrowRight");
    expect(strip.rail.scrollLeft).toBe(2 * STEP);
    await press("End");
    expect(strip.rail.scrollLeft).toBe(20 * STEP - VIEW);
    await press("Home");
    expect(strip.rail.scrollLeft).toBe(0);
  });
});
