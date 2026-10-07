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
  ENTER_ORDER_CAP,
  GLIDE_MIN_SPEED,
  beginPress,
  enterOrder,
  glideStep,
  grabOffset,
  itemsInView,
  maxScrollLeft,
  movePress,
  nearestStop,
  nearestStopIndex,
  pageScrollLeft,
  railEdges,
  railStops,
  releaseVelocity,
  releasedElsewhere,
  scrollForPointer,
  startsDrag,
  stepStop,
  suppressesClick,
  takesOverFling,
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
  /**
   * The reader has taken hold of the row: stop a fling, or a glide of ours,
   * where it is, and say which it was (null: the row was still).
   */
  stop: () => StoppedMotion;
  /** Carry on at `velocity` (px/ms of scroll) until it dies out, then come to rest. */
  fling: (velocity: number) => void;
  /** Come to rest on the nearest stop — a card flush with the gutter, or an end. */
  settle: () => void;
  /** Move the rail to `left`: smoothly when asked, unless the reader prefers less motion. */
  scrollTo: (left: number, smooth: boolean) => void;
  /**
   * Where the rail is — or where a glide of ours is taking it, so that a key
   * pressed again mid-glide steps on from there rather than from halfway.
   */
  position: () => number;
}

/**
 * What a press stopped: a fling (momentum — a tap then means "stop", not "open
 * the card going past"), a glide of ours (a settle, a slider or key move), or
 * nothing.
 */
export type StoppedMotion = "fling" | "glide" | null;

/** A glide counts as over once the rail has not scrolled for this long (Safari has no scrollend). */
const GLIDE_IDLE_MS = 200;

/**
 * What moves the rail on its own after the reader lets go: a fling that dies
 * out frame by frame, then a smooth settle onto the nearest card. A sideways
 * wheel (a trackpad) on the rail takes over from a fling at once; a vertical
 * one scrolls the page and leaves the fling to finish.
 */
export function useRailMotion(railRef: RefObject<HTMLElement | null>): RailMotion {
  const [flinging, setFlinging] = useState(false);
  const frame = useRef(0);
  /** Where a smooth scroll of ours is headed, until it arrives or something else moves the row. */
  const target = useRef<number | null>(null);
  /** How far the row was from the target at the last scroll: a glide only ever closes in. */
  const distance = useRef(Number.POSITIVE_INFINITY);
  const idle = useRef(0);

  const clearTarget = () => {
    target.current = null;
    window.clearTimeout(idle.current);
  };

  /** No scroll for a while: whatever glide there was is over (Safari has no scrollend). */
  const armIdle = () => {
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(clearTarget, GLIDE_IDLE_MS);
  };

  const scrollTo = (left: number, smooth: boolean) => {
    const rail = railRef.current;
    if (!rail) return;
    const glide = smooth && !prefersReducedMotion() && Math.abs(rail.scrollLeft - left) >= 1;
    if (glide) {
      target.current = left;
      distance.current = Math.abs(rail.scrollLeft - left);
      armIdle();
    } else {
      clearTarget();
    }
    rail.scrollTo({ left, behavior: glide ? "smooth" : "instant" });
  };

  const settle = () => {
    const rail = railRef.current;
    if (!rail) return;
    const g = railGeometry(rail);
    const to = nearestStop(g.viewLeft, stopsOf(rail, g));
    if (Math.abs(to - g.viewLeft) >= 1) scrollTo(to, true);
  };

  const cancel = () => {
    if (frame.current !== 0) window.cancelAnimationFrame(frame.current);
    frame.current = 0;
  };

  const stop = (): StoppedMotion => {
    const rail = railRef.current;
    const stopped: StoppedMotion = frame.current !== 0 ? "fling" : target.current !== null ? "glide" : null;
    cancel();
    if (target.current !== null && rail) {
      // Halt a smooth scroll where it has got to.
      rail.scrollTo({ left: rail.scrollLeft, behavior: "instant" });
    }
    clearTarget();
    setFlinging(false);
    return stopped;
  };

  const position = () => target.current ?? railRef.current?.scrollLeft ?? 0;

  const fling = (velocity: number) => {
    cancel();
    clearTarget();
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

  const onWheel = useEffectEvent((e: WheelEvent) => {
    if (frame.current !== 0 && takesOverFling(e.deltaX, e.deltaY)) stop();
  });

  const onScroll = useEffectEvent(() => {
    const rail = railRef.current;
    if (target.current === null || !rail) return;
    const now = Math.abs(rail.scrollLeft - target.current);
    // Arrived — or moved away from the target: something else (a trackpad,
    // a focus scrolling a card into view) has taken the row.
    if (now < 1 || now > distance.current + 1) {
      clearTarget();
      return;
    }
    distance.current = now;
    armIdle();
  });

  const onScrollEnd = useEffectEvent(() => clearTarget());

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const wheel = (e: WheelEvent) => onWheel(e);
    const scroll = () => onScroll();
    const scrollEnd = () => onScrollEnd();
    rail.addEventListener("wheel", wheel, { passive: true });
    rail.addEventListener("scroll", scroll, { passive: true });
    rail.addEventListener("scrollend", scrollEnd);
    return () => {
      rail.removeEventListener("wheel", wheel);
      rail.removeEventListener("scroll", scroll);
      rail.removeEventListener("scrollend", scrollEnd);
      window.clearTimeout(idle.current);
      if (frame.current !== 0) window.cancelAnimationFrame(frame.current);
    };
  }, [railRef]);

  return { flinging, stop, fling, settle, scrollTo, position };
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
  /** A press went down on the row: whatever was moving it stops, and this says what that was. */
  onPress: () => StoppedMotion;
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
  /** What this press stopped, if anything. */
  const stoppedMotion = useRef<StoppedMotion>(null);

  const end = (e: PointerEvent<HTMLElement>) => {
    // Whatever ends, nothing is being dragged any more — including a drag
    // whose release the rail never saw.
    setDragging(false);
    const p = press.current;
    if (!p || p.pointerId !== e.pointerId) return;
    press.current = null;
    // A cancelled pointer gets no click. A released one gets it in this same
    // task; the timeout makes sure a click that never comes cannot swallow
    // the next real one. A press that only stopped a fling is not a click on
    // the card going past either.
    const stopped = stoppedMotion.current;
    stoppedMotion.current = null;
    swallowClick.current = e.type === "pointerup" && suppressesClick(p, stopped === "fling");
    window.setTimeout(() => {
      swallowClick.current = false;
    }, 0);
    if (!p.dragging) {
      // A tap that stopped the row moving: it comes to rest on a card from there.
      if (stopped !== null) onRelease(0);
      return;
    }
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
          stoppedMotion.current = null;
          return;
        }
        stoppedMotion.current = onPress();
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
  /**
   * A finger down on the bare track: where the row glides to if it lifts
   * without moving. Not before — the press may yet turn out to be the start
   * of a vertical page swipe, which the browser takes over with pointercancel.
   */
  readonly tapGlide: number | null;
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
        // Stops, not pixels: a screen reader's increment moves a card.
        const stops = stopsOf(rail, g);
        input.max = String(Math.max(0, stops.length - 1));
        input.value = String(nearestStopIndex(g.viewLeft, stops));
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
    // A finger lifted off the bare track without moving: it was a tap after all.
    else if (h.tapGlide !== null && e.type === "pointerup") motion.scrollTo(h.tapGlide, true);
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
        // On the bare track the row glides there, landing on a card: at once
        // for a mouse; for a finger only once it lifts without having moved.
        const glide = onThumb
          ? null
          : nearestStop(scrollForPointer(g, thumbFor(g), track.width, x, grab), stopsOf(rail, g));
        const mouse = e.pointerType === "mouse";
        hold.current = { pointerId: e.pointerId, grab, startX: e.clientX, moved: false, tapGlide: mouse ? null : glide };
        e.currentTarget.setPointerCapture(e.pointerId);
        // No text selection, and focus stays where it was.
        e.preventDefault();
        if (!mouse) return;
        setDragging(true);
        if (glide !== null) motion.scrollTo(glide, true);
      },
      onPointerMove: (e) => {
        const h = hold.current;
        if (!h || h.pointerId !== e.pointerId) return;
        if (!h.moved && Math.abs(e.clientX - h.startX) < CLICK_SLOP_PX) return;
        // A finger shows the slider held once it is actually sliding it.
        if (!h.moved) setDragging(true);
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
        // From where a glide already under way is headed, so a second press
        // (or a held key) steps on rather than aiming at the same card again.
        const g = { ...railGeometry(rail), viewLeft: motion.position() };
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
      // Assistive technology setting the value outright: a stop's index.
      onChange: (e) => {
        const rail = railRef.current;
        if (!rail) return;
        const stops = stopsOf(rail, railGeometry(rail));
        const index = Math.round(Number(e.currentTarget.value));
        if (!Number.isFinite(index) || stops.length === 0) return;
        motion.stop();
        motion.scrollTo(stops[Math.max(0, Math.min(stops.length - 1, index))], true);
      },
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
    },
  };
}

// ── The entrance ──────────────────────────────────────────────────────────

/** Each item starts this much after the one before it (TodayRail.module.css, `.rail[data-enter]`). */
const ENTER_STEP_MS = 45;
/** One item's rise (same rule). */
const ENTER_RISE_MS = 600;
/** The whole entrance, the last item in the order included, with a margin. */
const ENTRANCE_MS = ENTER_ORDER_CAP * ENTER_STEP_MS + ENTER_RISE_MS + 100;

/**
 * Whether the row's items should rise into place: true from the moment the
 * row first comes into view — and only if it was off screen when the page
 * became interactive (judged against the whole viewport), so a row the reader
 * has already seen is never made to blink out and back. Each item's place in
 * the order goes on it as --enter-order; the animation is CSS (off for readers
 * who prefer less motion) and runs to its end on its own, so nothing is ever
 * left hidden. Once it has run the row drops it: the 现在 marker, re-created
 * in its new place each time a show airs, would otherwise rise in again.
 */
export function useRailEntrance(railRef: RefObject<HTMLElement | null>): boolean {
  const [entering, setEntering] = useState(false);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail || typeof IntersectionObserver === "undefined") return;
    const box = rail.getBoundingClientRect();
    if (box.bottom > 0 && box.top < window.innerHeight) return;
    let finished = 0;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[entries.length - 1]?.isIntersecting) return;
        observer.disconnect();
        const items = Array.from(rail.children) as HTMLElement[];
        const order = enterOrder(railGeometry(rail), items.map(boxOf));
        items.forEach((el, i) => el.style.setProperty("--enter-order", String(order[i])));
        setEntering(true);
        finished = window.setTimeout(() => setEntering(false), ENTRANCE_MS);
      },
      // A little way in, so the rise is seen rather than finished below the fold.
      { rootMargin: "0px 0px -10% 0px" },
    );
    observer.observe(rail);
    return () => {
      observer.disconnect();
      window.clearTimeout(finished);
    };
  }, [railRef]);

  return entering;
}
