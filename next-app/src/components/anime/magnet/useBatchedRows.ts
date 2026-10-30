"use client";

// How many rows the list renders: 40, then 40 more each time the reader
// brings the end of the list near — by their own hand — or presses the
// "show more" button at its end (the way in for a screen reader, a dragged
// scrollbar, or anything else that scrolls without a wheel, finger or key).
//
// A popular show answers with over a thousand rows (1.4 MB for Re:Zero), and
// laying all of them out at once stalls a phone. The extra rows come only on
// the reader's own scrolling — a wheel, a finger, a scrolling key — or when
// keyboard focus reaches the last few rows. A browser moving the list by
// itself (WebKit holding the viewport against the end of a growing list) is
// no reader asking for more, and loading on it would run batch after batch
// in a row; the genre grid learnt that the hard way (GridResults.tsx).

import { useCallback, useEffect, useState, type RefObject } from "react";

export const BATCH_SIZE = 40;

/** How far (px) below the visible part of the list its end may be when a batch loads. */
const NEAR_END_PX = 600;

/** Focus this close to the last rendered row loads the next batch for a keyboard reader. */
const FOCUS_TAIL_ROWS = 3;

/** The keys that scroll a list down. */
const SCROLL_KEYS = new Set([" ", "PageDown", "ArrowDown", "End"]);

function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}

/**
 * @param total     rows the list could show
 * @param resetKey  changes whenever the list it counts changes (new answer,
 *                  new filter); the count starts over at one batch
 * @param scrollRef the scrolling element the list lives in
 * @param endRef    an element right after the last rendered row
 */
export function useBatchedRows(
  total: number,
  resetKey: string,
  scrollRef: RefObject<HTMLElement | null>,
  endRef: RefObject<HTMLElement | null>,
): { limit: number; more: () => void } {
  const [state, setState] = useState({ key: resetKey, limit: BATCH_SIZE });
  const limit = state.key === resetKey ? state.limit : BATCH_SIZE;

  const more = useCallback(() => {
    setState((prev) => ({
      key: resetKey,
      limit: (prev.key === resetKey ? prev.limit : BATCH_SIZE) + BATCH_SIZE,
    }));
  }, [resetKey]);

  useEffect(() => {
    const root = scrollRef.current;
    const end = endRef.current;
    if (!root || !end || limit >= total || typeof IntersectionObserver === "undefined") return;
    let near = false;
    let byHand = false;
    let fired = false;
    const load = () => {
      if (fired) return;
      fired = true;
      more();
    };
    const maybeLoad = () => {
      if (near && byHand) load();
    };
    const onHand = () => {
      byHand = true;
      maybeLoad();
    };
    const onKey = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key) && !isTextEntry(e.target)) onHand();
    };
    const onFocus = (e: FocusEvent) => {
      const row = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-row]") : null;
      if (row && Number(row.dataset.row) >= limit - FOCUS_TAIL_ROWS) load();
    };
    const observer = new IntersectionObserver(
      (entries) => {
        near = entries[entries.length - 1]?.isIntersecting ?? false;
        maybeLoad();
      },
      { root, rootMargin: `0px 0px ${NEAR_END_PX}px 0px` },
    );
    observer.observe(end);
    root.addEventListener("scroll", maybeLoad, { passive: true });
    root.addEventListener("wheel", onHand, { passive: true });
    root.addEventListener("touchmove", onHand, { passive: true });
    root.addEventListener("keydown", onKey);
    root.addEventListener("focusin", onFocus);
    return () => {
      observer.disconnect();
      root.removeEventListener("scroll", maybeLoad);
      root.removeEventListener("wheel", onHand);
      root.removeEventListener("touchmove", onHand);
      root.removeEventListener("keydown", onKey);
      root.removeEventListener("focusin", onFocus);
    };
  }, [limit, total, more, scrollRef, endRef]);

  return { limit: Math.min(limit, total), more };
}
