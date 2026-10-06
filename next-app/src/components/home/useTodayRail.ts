"use client";

// The wiring behind 今日更新's rail on a desktop: where it is between its two
// ends (for the ← → buttons), and dragging it with the mouse. The decisions —
// what a drag is, what it does to the click, where a page lands — are in
// lib/home/railScroll.ts; these hooks read the DOM and write scrollLeft.

import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import {
  beginPress,
  movePress,
  railEdges,
  startsDrag,
  suppressesClick,
  type RailEdges,
  type RailGeometry,
  type RailPress,
} from "@/lib/home/railScroll";

export function railGeometry(rail: HTMLElement): RailGeometry {
  return { viewLeft: rail.scrollLeft, viewWidth: rail.clientWidth, contentWidth: rail.scrollWidth };
}

/** Until measured, the rail claims nothing to scroll: the buttons stay hidden. */
const UNMEASURED: RailEdges = { overflow: false, atStart: true, atEnd: true };

function sameEdges(a: RailEdges, b: RailEdges): boolean {
  return a.overflow === b.overflow && a.atStart === b.atStart && a.atEnd === b.atEnd;
}

/**
 * The rail's edges, re-read when it scrolls or changes size — one reading per
 * frame, and a render only when one of the three answers flips.
 */
export function useRailEdges(railRef: RefObject<HTMLElement | null>): RailEdges {
  const [edges, setEdges] = useState<RailEdges>(UNMEASURED);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = railEdges(railGeometry(rail));
      setEdges((prev) => (sameEdges(prev, next) ? prev : next));
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
  }, [railRef]);

  return edges;
}

export interface RailDrag {
  /** A drag is under way: the rail shows the grabbing hand and selects nothing. */
  dragging: boolean;
  handlers: {
    onPointerDown: (e: PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
    onClickCapture: (e: MouseEvent<HTMLElement>) => void;
    onDragStart: (e: DragEvent<HTMLElement>) => void;
  };
}

/**
 * Press-and-drag the rail with the mouse. Touch is left to the browser, which
 * already scrolls the row natively.
 *
 * The pointer is captured only once the press has become a drag: captured
 * from the first pointerdown, a plain click would be delivered to the rail
 * instead of the card under it. A drag's release swallows the one click that
 * follows it, so letting go over a card does not open it.
 */
export function useRailDrag(): RailDrag {
  const [dragging, setDragging] = useState(false);
  const press = useRef<RailPress | null>(null);
  const swallowClick = useRef(false);

  const end = (e: PointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p || p.pointerId !== e.pointerId) return;
    press.current = null;
    if (!p.dragging) return;
    setDragging(false);
    // A cancelled pointer gets no click. A released one gets it in this same
    // task; the timeout makes sure a click that never comes cannot swallow
    // the next real one.
    swallowClick.current = e.type === "pointerup" && suppressesClick(p);
    window.setTimeout(() => {
      swallowClick.current = false;
    }, 0);
  };

  return {
    dragging,
    handlers: {
      onPointerDown: (e) => {
        swallowClick.current = false;
        if (!startsDrag(e.pointerType, e.button)) return;
        press.current = beginPress(e.pointerId, e.clientX, e.currentTarget.scrollLeft);
      },
      onPointerMove: (e) => {
        const p = press.current;
        if (!p || p.pointerId !== e.pointerId) return;
        const move = movePress(p, e.clientX);
        press.current = move.press;
        if (move.started) {
          e.currentTarget.setPointerCapture(e.pointerId);
          // Whatever text the press began to select goes; CSS stops more.
          window.getSelection()?.removeAllRanges();
          setDragging(true);
        }
        if (move.scrollLeft !== null) e.currentTarget.scrollLeft = move.scrollLeft;
      },
      onPointerUp: end,
      onPointerCancel: end,
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
