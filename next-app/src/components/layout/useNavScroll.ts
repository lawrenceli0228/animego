"use client";

// Wires window scroll into lib/nav/navScroll's state machine.
//
// The machine's state lives in the effect's closure, not in React: it changes
// on every scroll event and nothing renders from it. React state holds only
// the two booleans the header paints from, and is set only when one of them
// actually flips — a scroll event that changes nothing visible costs nothing.

import { useEffect, useState, type RefObject } from "react";
import { INITIAL_NAV_SCROLL, stepNavScroll, type NavScrollState } from "@/lib/nav/navScroll";

export interface NavScrollView {
  readonly hidden: boolean;
  readonly glass: boolean;
}

const AT_TOP: NavScrollView = { hidden: false, glass: false };

/**
 * Something in the header is in use and must not slide away: any open popup
 * (every trigger in the bar carries aria-expanded — the genre menu, the search
 * box, the account and notification menus, the language menu, the drawer's
 * ☰), or keyboard focus inside it.
 *
 * `:focus-visible` rather than plain focus, because a mouse click on a link
 * leaves it focused after a client-side navigation and the header persists
 * across routes — with plain focus the bar would never hide again after the
 * first click. A focused text field always matches :focus-visible, so typing
 * in the search box pins it too.
 */
function isPinned(header: HTMLElement): boolean {
  if (header.querySelector('[aria-expanded="true"]')) return true;
  try {
    return header.querySelector(":focus-visible") !== null;
  } catch {
    // Browsers that cannot parse :focus-visible in a selector (Safari < 15.4).
    return header.contains(document.activeElement);
  }
}

export function useNavScroll(headerRef: RefObject<HTMLElement | null>): NavScrollView {
  const [view, setView] = useState<NavScrollView>(AT_TOP);

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;

    let state: NavScrollState = INITIAL_NAV_SCROLL;
    let frame = 0;

    const update = () => {
      frame = 0;
      state = stepNavScroll(state, {
        y: window.scrollY,
        maxY: document.documentElement.scrollHeight - window.innerHeight,
        barHeight: header.offsetHeight,
        pinned: isPinned(header),
      });
      const { hidden, glass } = state;
      setView((prev) => (prev.hidden === hidden && prev.glass === glass ? prev : { hidden, glass }));
    };

    // Coalesced to one decision per frame: scroll events can outnumber frames.
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update);
    };

    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    // Tabbing into a hidden bar brings it back at once, not on the next scroll.
    header.addEventListener("focusin", schedule);
    // The page may already be scrolled when this mounts (a reload restores the
    // position), so the first decision does not wait for a scroll event.
    schedule();

    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      header.removeEventListener("focusin", schedule);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [headerRef]);

  return view;
}
