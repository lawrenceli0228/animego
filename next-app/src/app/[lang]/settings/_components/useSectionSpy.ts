"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isScrolledToEnd, pickSection } from "./sectionSpy";

// The band a section has to reach to be marked: below the site header and
// the phone's chip row (a section a link jumped to lands just under them,
// while the one above it ends above this line), down to 45% of the viewport.
const BAND = "-96px 0px -55% 0px";

// Input that means the reader is scrolling by hand. A link press holds its
// own mark until one of these: after the jump the section it chose may sit
// lower than one still in the band (the last ones are short), and the mark
// should say what was asked for, not what the band happens to see.
const HAND_INPUT = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/**
 * Scroll-spy for the settings index: which of `ids` (element ids, in page
 * order) is being read. `select` marks a section straight away, for a click
 * on its link.
 *
 * Starts on the first section, on the server and in the first client render
 * alike, so hydration matches; the observer takes over after mount.
 * `ids` must keep its identity between renders (a module constant).
 */
export function useSectionSpy<T extends string>(ids: readonly T[]): {
  current: T;
  select: (id: T) => void;
} {
  const [current, setCurrent] = useState<T>(ids[0]);
  const held = useRef(false);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const inBand = new Set<string>();
    let frame = 0;

    const update = () => {
      frame = 0;
      if (held.current) return;
      const atEnd = isScrolledToEnd(
        window.scrollY,
        window.innerHeight,
        document.documentElement.scrollHeight,
      );
      const next = pickSection(ids, inBand, atEnd);
      if (next) setCurrent(next);
    };
    // One decision per frame: scroll events can outnumber frames.
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) inBand.add(entry.target.id);
          else inBand.delete(entry.target.id);
        }
        schedule();
      },
      { rootMargin: BAND },
    );
    for (const id of ids) {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    }

    const release = () => {
      held.current = false;
    };
    // The band alone cannot see the page's last pixels: the end-of-page rule
    // needs the scroll position itself.
    window.addEventListener("scroll", schedule, { passive: true });
    for (const type of HAND_INPUT) window.addEventListener(type, release, { passive: true });

    return () => {
      observer.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      for (const type of HAND_INPUT) window.removeEventListener(type, release);
    };
  }, [ids]);

  const select = useCallback((id: T) => {
    held.current = true;
    setCurrent(id);
  }, []);

  return { current, select };
}
