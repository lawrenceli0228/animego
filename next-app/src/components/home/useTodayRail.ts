"use client";

// The wiring behind 今日更新's rail: dragging it with the mouse (and the fling
// a quick drag ends in), coming to rest on a card, the slider under it, and the
// cards rising the first time the row comes into view. The decisions — what a
// drag is, where the thumb sits, where the rail comes to rest — are in
// lib/home/railScroll.ts; these hooks read the DOM and write scrollLeft.

import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import {
  GLIDE_MIN_SPEED,
  beginPress,
  enterOrder,
  glideStep,
  grabOffset,
  itemsInView,
  maxScrollLeft,
  movePress,
  nearestStop,
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
  type ItemBox,
  type PointerSample,
  type RailGeometry,
  type RailPress,
} from "@/lib/home/railScroll";

export function railGeometry(rail: HTMLElement): RailGeometry {
  return { viewLeft: rail.scrollLeft, viewWidth: rail.clientWidth, contentWidth: rail.scrollWidth };
}

/** The rail's inline padding: the page gutter, where a card lines up. */
export function gutterOf(rail: HTMLElement): number {
  return parseFloat(getComputedStyle(rail).paddingLeft) || 0;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Where each item in the rail (cards, the 现在 marker, the end of the day) starts. */
function itemStarts(rail: HTMLElement): number[] {
  return Array.from(rail.children, (el) => (el as HTMLElement).offsetLeft);
}

function boxOf(el: HTMLElement): ItemBox {
  return { start: el.offsetLeft, width: el.offsetWidth };
}

/** The show cards only — the ones a reader counts. */
function cardBoxes(rail: HTMLElement): ItemBox[] {
  return Array.from(rail.querySelectorAll<HTMLElement>(":scope > [data-state]"), boxOf);
}

function stopsOf(rail: HTMLElement, g: RailGeometry): number[] {
  return railStops(g, itemStarts(rail), gutterOf(rail));
}

// ── Coming to rest, and the fling ─────────────────────────────────────────

export interface RailMotion {
  /** A fling is under way. */
  flinging: boolean;
  /** Stop a fling: the reader has taken hold of the row again. */
  stop: () => void;
  /** Carry on at `velocity` (px/ms of scroll) until it dies out, then come to rest. */
  fling: (velocity: number) => void;
  /** Come to rest on the nearest stop — a card flush with the gutter, or an end. */
  settle: () => void;
  /** Move the rail to `left`: smoothly when asked, unless the reader prefers less motion. */
  scrollTo: (left: number, smooth: boolean) => void;
}

/**
 * What moves the rail on its own after the reader lets go: a fling that dies
 * out frame by frame, then a smooth settle onto the nearest card. A wheel or a
 * trackpad on the rail takes over from a fling at once.
 */
export function useRailMotion(railRef: RefObject<HTMLElement | null>): RailMotion {
  const [flinging, setFlinging] = useState(false);
  const frame = useRef(0);

  const scrollTo = (left: number, smooth: boolean) => {
    railRef.current?.scrollTo({ left, behavior: smooth && !prefersReducedMotion() ? "smooth" : "instant" });
  };

  const settle = () => {
    const rail = railRef.current;
    if (!rail) return;
    const g = railGeometry(rail);
    const target = nearestStop(g.viewLeft, stopsOf(rail, g));
    if (Math.abs(target - g.viewLeft) >= 1) scrollTo(target, true);
  };

  const cancel = () => {
    if (frame.current !== 0) window.cancelAnimationFrame(frame.current);
    frame.current = 0;
  };

  const stop = () => {
    cancel();
    setFlinging(false);
  };

  const fling = (velocity: number) => {
    cancel();
    const rail = railRef.current;
    if (!rail) return;
    if (prefersReducedMotion() || Math.abs(velocity) < GLIDE_MIN_SPEED) {
      setFlinging(false);
      settle();
      return;
    }
    setFlinging(true);
    let speed = velocity;
    let last = 0;
    const step = (now: number) => {
      const dt = last === 0 ? 16 : Math.min(32, Math.max(1, now - last));
      last = now;
      const before = rail.scrollLeft;
      const next = glideStep(speed, dt);
      rail.scrollLeft = before + next.dx;
      speed = next.velocity;
      // Stopped by an end of the row before the speed ran out.
      const blocked = Math.abs(next.dx) >= 1 && Math.abs(rail.scrollLeft - before) < 0.5;
      if (Math.abs(speed) < GLIDE_MIN_SPEED || blocked) {
        frame.current = 0;
        setFlinging(false);
        settle();
        return;
      }
      frame.current = window.requestAnimationFrame(step);
    };
    frame.current = window.requestAnimationFrame(step);
  };

  const takeOver = useEffectEvent(() => {
    if (frame.current !== 0) stop();
  });

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const onWheel = () => takeOver();
    rail.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      rail.removeEventListener("wheel", onWheel);
      if (frame.current !== 0) window.cancelAnimationFrame(frame.current);
    };
  }, [railRef]);

  return { flinging, stop, fling, settle, scrollTo };
}

// ── Dragging the row with the mouse ───────────────────────────────────────

export interface RailDrag {
  /** A drag is under way: the rail shows the grabbing hand and selects nothing. */
  dragging: boolean;
  handlers: {
    onPointerDown: (e: PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
    onLostPointerCapture: (e: PointerEvent<HTMLElement>) => void;
    onClickCapture: (e: MouseEvent<HTMLElement>) => void;
    onDragStart: (e: DragEvent<HTMLElement>) => void;
  };
}

interface DragCallbacks {
  /** A press went down on the row: whatever was moving it stops. */
  onPress: () => void;
  /** A drag was let go, the row's speed at that moment in px/ms of scroll (0 if it had rested). */
  onRelease: (velocity: number) => void;
}

/** Moves kept for reading the release speed; the speed only looks at the last 120 ms. */
const SAMPLE_COUNT = 8;

/**
 * Press-and-drag the rail with the mouse. Touch is left to the browser, which
 * already scrolls the row natively.
 *
 * The pointer is captured only once the press has become a drag: captured
 * from the first pointerdown, a plain click would be delivered to the rail
 * instead of the card under it. A drag's release swallows the one click that
 * follows it, so letting go over a card does not open it — and hands its speed
 * to `onRelease`, so a quick drag flings on.
 */
export function useRailDrag({ onPress, onRelease }: DragCallbacks): RailDrag {
  const [dragging, setDragging] = useState(false);
  const press = useRef<RailPress | null>(null);
  const samples = useRef<readonly PointerSample[]>([]);
  const swallowClick = useRef(false);

  const end = (e: PointerEvent<HTMLElement>) => {
    // Whatever ends, nothing is being dragged any more — including a drag
    // whose release the rail never saw.
    setDragging(false);
    const p = press.current;
    if (!p || p.pointerId !== e.pointerId) return;
    press.current = null;
    if (!p.dragging) return;
    // A cancelled pointer gets no click. A released one gets it in this same
    // task; the timeout makes sure a click that never comes cannot swallow
    // the next real one.
    swallowClick.current = e.type === "pointerup" && suppressesClick(p);
    window.setTimeout(() => {
      swallowClick.current = false;
    }, 0);
    // The rail moves the other way from the pointer.
    onRelease(e.type === "pointerup" ? -releaseVelocity(samples.current, e.timeStamp) : 0);
  };

  return {
    dragging,
    handlers: {
      onPointerDown: (e) => {
        swallowClick.current = false;
        setDragging(false);
        if (!startsDrag(e.pointerType, e.button)) {
          press.current = null;
          return;
        }
        onPress();
        press.current = beginPress(e.pointerId, e.clientX, e.currentTarget.scrollLeft);
        samples.current = [{ t: e.timeStamp, x: e.clientX }];
      },
      onPointerMove: (e) => {
        const p = press.current;
        if (!p || p.pointerId !== e.pointerId) return;
        // Released somewhere else before the drag began (and the capture with
        // it): this is a hover now, not a press.
        if (releasedElsewhere(e.buttons)) {
          press.current = null;
          setDragging(false);
          return;
        }
        const move = movePress(p, e.clientX);
        press.current = move.press;
        if (move.started) {
          e.currentTarget.setPointerCapture(e.pointerId);
          // Whatever text the press began to select goes; CSS stops more.
          window.getSelection()?.removeAllRanges();
          setDragging(true);
        }
        if (move.scrollLeft !== null) {
          e.currentTarget.scrollLeft = move.scrollLeft;
          samples.current = [...samples.current, { t: e.timeStamp, x: e.clientX }].slice(-SAMPLE_COUNT);
        }
      },
      onPointerUp: end,
      onPointerCancel: end,
      // Capture taken away (the row unmounted, the browser stepped in): the
      // press is over too. After a normal release this finds no press left.
      onLostPointerCapture: end,
      onClickCapture: (e) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      },
      // A link or an image would otherwise start the browser's own drag (a
      // ghost of the card), which cancels the pointer and ends ours.
      onDragStart: (e) => e.preventDefault(),
    },
  };
}

// ── The slider ────────────────────────────────────────────────────────────

/** The two elements the slider writes to: the thumb and the range input in front of it. */
export interface RailSliderParts {
  thumbRef: RefObject<HTMLSpanElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
}

export interface RailSlider {
  /** The row is wider than the screen: there is somewhere to slide to. */
  overflow: boolean;
  /** The thumb is held. */
  dragging: boolean;
  /** Pointed at, held or focused: the slider shows itself at full size. */
  active: boolean;
  sliderHandlers: {
    onPointerDown: (e: PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
    onLostPointerCapture: (e: PointerEvent<HTMLElement>) => void;
    onPointerEnter: (e: PointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
  };
  inputHandlers: {
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
    onChange: (e: ChangeEvent<HTMLInputElement>) => void;
    onFocus: () => void;
    onBlur: () => void;
  };
}

interface Hold {
  readonly pointerId: number;
  /** Where on the thumb it was taken hold of, px from its left edge. */
  readonly grab: number;
  readonly startX: number;
  /** The pointer has moved the thumb (a click on the track only glides). */
  readonly moved: boolean;
}

/** A press on the slider that wanders less than this is a click on the track. */
const CLICK_SLOP_PX = 4;

/**
 * The slider under the rail. The thumb is dragged (the spot taken hold of
 * stays under the pointer), the bare track is clicked (the row glides there,
 * landing on a card), and the hidden range input in front of it carries the
 * keyboard and assistive technology: ← → a card at a time, Page Up / Page
 * Down a screen, Home / End the ends.
 *
 * The thumb's size and place and the input's value are written straight onto
 * the elements once a frame while the rail moves: re-rendering every card on
 * each scroll frame to move one bar would be waste. React only hears about
 * the answers that change what is drawn — whether there is anything to scroll.
 */
export function useRailSlider(
  railRef: RefObject<HTMLElement | null>,
  { thumbRef, inputRef }: RailSliderParts,
  motion: RailMotion,
  valueText: (first: number, last: number, total: number) => string,
): RailSlider {
  const hold = useRef<Hold | null>(null);
  const [overflow, setOverflow] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  const describe = useEffectEvent((first: number, last: number, total: number) => valueText(first, last, total));

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const g = railGeometry(rail);
      const thumb = thumbFor(g);
      const bar = thumbRef.current;
      if (bar) {
        bar.style.width = `${thumb.widthPct}%`;
        bar.style.left = `${thumb.leftPct}%`;
      }
      const input = inputRef.current;
      if (input) {
        input.max = String(Math.round(maxScrollLeft(g)));
        input.value = String(Math.round(g.viewLeft));
        const cards = cardBoxes(rail);
        const seen = itemsInView(g, cards, gutterOf(rail));
        input.setAttribute("aria-valuetext", seen ? describe(seen.first, seen.last, cards.length) : "");
      }
      const next = railEdges(g).overflow;
      setOverflow((prev) => (prev === next ? prev : next));
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    rail.addEventListener("scroll", schedule, { passive: true });
    // Also fires once on observe(), which is the first measurement.
    const resize = new ResizeObserver(schedule);
    resize.observe(rail);
    return () => {
      rail.removeEventListener("scroll", schedule);
      resize.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [railRef, thumbRef, inputRef]);

  const pointerScroll = (e: PointerEvent<HTMLElement>, grab: number): number | null => {
    const rail = railRef.current;
    if (!rail) return null;
    const track = e.currentTarget.getBoundingClientRect();
    const g = railGeometry(rail);
    return scrollForPointer(g, thumbFor(g), track.width, e.clientX - track.left, grab);
  };

  const release = (e: PointerEvent<HTMLElement>) => {
    const h = hold.current;
    if (!h || h.pointerId !== e.pointerId) return;
    hold.current = null;
    setDragging(false);
    if (h.moved) motion.settle();
  };

  return {
    overflow,
    dragging,
    active: hovered || dragging || focused,
    sliderHandlers: {
      onPointerDown: (e) => {
        const rail = railRef.current;
        if (!rail || (e.pointerType === "mouse" && e.button !== 0)) return;
        motion.stop();
        const track = e.currentTarget.getBoundingClientRect();
        const g = railGeometry(rail);
        const x = e.clientX - track.left;
        const { onThumb, grab } = grabOffset(thumbFor(g), track.width, x);
        hold.current = { pointerId: e.pointerId, grab, startX: e.clientX, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
        // No text selection, and focus stays where it was.
        e.preventDefault();
        setDragging(true);
        // On the bare track: glide there, landing on a card.
        if (!onThumb) {
          const target = scrollForPointer(g, thumbFor(g), track.width, x, grab);
          motion.scrollTo(nearestStop(target, stopsOf(rail, g)), true);
        }
      },
      onPointerMove: (e) => {
        const h = hold.current;
        if (!h || h.pointerId !== e.pointerId) return;
        if (!h.moved && Math.abs(e.clientX - h.startX) < CLICK_SLOP_PX) return;
        hold.current = { ...h, moved: true };
        const left = pointerScroll(e, h.grab);
        if (left !== null && railRef.current) railRef.current.scrollLeft = left;
      },
      onPointerUp: release,
      onPointerCancel: release,
      onLostPointerCapture: release,
      onPointerEnter: (e) => {
        if (e.pointerType === "mouse") setHovered(true);
      },
      onPointerLeave: () => setHovered(false),
    },
    inputHandlers: {
      onKeyDown: (e) => {
        const rail = railRef.current;
        if (!rail) return;
        const g = railGeometry(rail);
        const target =
          e.key === "ArrowRight" || e.key === "ArrowUp"
            ? stepStop(g, stopsOf(rail, g), 1)
            : e.key === "ArrowLeft" || e.key === "ArrowDown"
              ? stepStop(g, stopsOf(rail, g), -1)
              : e.key === "PageDown"
                ? pageScrollLeft(g, itemStarts(rail), gutterOf(rail), 1)
                : e.key === "PageUp"
                  ? pageScrollLeft(g, itemStarts(rail), gutterOf(rail), -1)
                  : e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? maxScrollLeft(g)
                      : null;
        if (target === null) return;
        e.preventDefault();
        motion.stop();
        motion.scrollTo(target, true);
      },
      // Assistive technology setting the value outright.
      onChange: (e) => {
        const left = Number(e.currentTarget.value);
        if (Number.isFinite(left)) motion.scrollTo(left, false);
      },
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
    },
  };
}

// ── The entrance ──────────────────────────────────────────────────────────

/**
 * Whether the cards should rise into place: true from the moment the row
 * first comes into view — and only if it was off screen when the page became
 * interactive, so a row already on screen is never made to blink out and back.
 * Each item's place in the order goes on it as --enter-order; the animation
 * is CSS (off for readers who prefer less motion) and runs to its end on its
 * own, so nothing is ever left hidden.
 */
export function useRailEntrance(railRef: RefObject<HTMLElement | null>): boolean {
  const [entering, setEntering] = useState(false);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail || typeof IntersectionObserver === "undefined") return;
    let first = true;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        const wasFirst = first;
        first = false;
        if (wasFirst && entry.isIntersecting) {
          observer.disconnect();
          return;
        }
        if (!entry.isIntersecting) return;
        observer.disconnect();
        const items = Array.from(rail.children) as HTMLElement[];
        const order = enterOrder(railGeometry(rail), items.map(boxOf));
        items.forEach((el, i) => el.style.setProperty("--enter-order", String(order[i])));
        setEntering(true);
      },
      // A little way in, so the rise is seen rather than finished below the fold.
      { rootMargin: "0px 0px -10% 0px" },
    );
    observer.observe(rail);
    return () => observer.disconnect();
  }, [railRef]);

  return entering;
}
