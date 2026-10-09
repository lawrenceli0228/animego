"use client";

// After a tab switch, the tab bar where the reader can see it and keyboard
// focus on the tab they chose.
//
// The tab links keep the scroll position (scroll={false} in DetailTabs): on
// a desktop the hero is the same height on every tab, so the bar stays under
// the pointer. On a phone it is not — the overview's hero is several times
// the height of the one-line header the list tabs fold it to — so the
// position that showed the bar on one tab can be past the filters on the
// next. And every tab is its own page, so the link that had focus is gone
// once the new one mounts, and focus falls back to the document.
//
// Only after a switch made in the bar itself. Arriving any other way — a
// page load, a link in the overview's sections, another page of the site,
// the browser's Back — leaves scroll and focus to the browser and the
// router, as on every other page.

import { useEffect } from "react";

/** When a tab in the bar was chosen, until the page it opens picks it up. */
let switchedAt: number | null = null;

/** A switch no page has picked up within this long was abandoned. */
const SWITCH_WINDOW_MS = 10_000;

export default function TabsInView({ targetId }: { targetId: string }) {
  // This bar's page has just mounted. If a tab in the previous page's bar
  // brought the reader here, bring the bar into view and focus the tab.
  // (StrictMode's second run finds the switch already taken.)
  useEffect(() => {
    const at = switchedAt;
    switchedAt = null;
    if (at === null || Date.now() - at > SWITCH_WINDOW_MS) return;
    const bar = document.getElementById(targetId);
    if (!bar) return;
    if (bar.getBoundingClientRect().top < 0) {
      // Honours html's scroll-padding-top, so the bar lands under the sticky
      // site header rather than behind it.
      bar.scrollIntoView({ block: "start" });
    }
    const focused = document.activeElement;
    if (!focused || focused === document.body) {
      bar.querySelector<HTMLElement>('[aria-current="page"]')?.focus({ preventScroll: true });
    }
  }, [targetId]);

  // A plain activation of another tab arms the switch — a click or Enter,
  // not a modified click, which opens a new tab or window and leaves this
  // page where it is. The listener is on the bar, so it runs before the
  // link's own handler (React's, at the root) takes the navigation over.
  useEffect(() => {
    const bar = document.getElementById(targetId);
    if (!bar) return undefined;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!link || !bar.contains(link) || link.getAttribute("aria-current") === "page") return;
      switchedAt = Date.now();
    };
    bar.addEventListener("click", onClick);
    return () => bar.removeEventListener("click", onClick);
  }, [targetId]);

  return null;
}
