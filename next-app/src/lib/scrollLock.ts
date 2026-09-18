import { useEffect } from "react";

/** The part of an element a lock touches. `document.documentElement` in the browser; a stub in tests. */
export interface ScrollRoot {
  style: { overflow: string; paddingRight: string };
  clientWidth: number;
}

interface SavedStyle {
  overflow: string;
  paddingRight: string;
}

// One page, one lock. The count is what lets two dialogs overlap: the page
// is released when the LAST one closes, not the first, and the style that
// gets put back is the one from before ANY of them opened.
let depth = 0;
let saved: SavedStyle | null = null;

/**
 * Stops the page scrolling under a modal. Returns the release.
 *
 * The lock goes on `<html>`, not `<body>`. globals.css gives the root element
 * `overflow-x: hidden`, and once the root's overflow is anything other than
 * `visible` the body's overflow no longer propagates to the viewport. So
 * `document.body.style.overflow = "hidden"` — which the four dialogs that
 * locked at all (torrent, play guide, trailer, photo crop) used to set —
 * clipped nothing, and the wheel kept scrolling the page behind the torrent
 * list.
 *
 * With classic scrollbars, hiding overflow also removes the bar and the page
 * shifts sideways by its width; the padding fills that gutter. Overlay
 * scrollbars (macOS default) measure 0 and get no padding.
 *
 * Known gap, not a regression: iOS Safari has historically let touch scrolling
 * through `overflow: hidden` on the root (the `position: fixed` body trick
 * exists for it). Not verified on a device here; the body lock it replaces
 * held nowhere.
 */
export function lockScroll(
  root: ScrollRoot = document.documentElement,
  viewportWidth: number = window.innerWidth,
): () => void {
  if (depth === 0) {
    saved = {
      overflow: root.style.overflow,
      paddingRight: root.style.paddingRight,
    };
    const gutter = viewportWidth - root.clientWidth;
    root.style.overflow = "hidden";
    if (gutter > 0) root.style.paddingRight = `${gutter}px`;
  }
  depth += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    depth -= 1;
    if (depth > 0 || !saved) return;
    root.style.overflow = saved.overflow;
    root.style.paddingRight = saved.paddingRight;
    saved = null;
  };
}

/** Holds the page scroll lock for as long as `active` is true. */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return lockScroll();
  }, [active]);
}
