"use client";

// Site-wide image fade-in. Drop-in replacement for <img>: covers start at
// opacity 0 and transition to 1 on load, so any grid/list of images fills
// in as one smooth reveal instead of each image popping abruptly at its
// own decode time, over whatever placeholder bg the parent sets.
//
// State-driven (not imperative el.style) so a parent re-render can't reset
// a loaded image back to opacity 0. A ref callback flips `loaded` for
// images that finished decoding from cache before React bound onLoad —
// otherwise those stick invisible.
//
// `priority`: above-the-fold / LCP image — render at full opacity
// immediately (no fade) and load eagerly so its paint isn't delayed.
//
// Non-priority images deliberately do NOT get fetchPriority="low". They used
// to, and it was actively harmful: `low` is not "after the priority ones", it
// is a hard demotion that applies even once the image is in the viewport. On
// a grid page (/seasonal, /library) the LCP element IS the first card, and no
// card is marked priority there — so the site was demoting its own LCP. The
// `loading="lazy"` below already keeps off-screen covers out of the way, which
// is the part we actually wanted; leaving fetchPriority unset lets the browser
// promote whatever it discovers in the viewport. Pass it explicitly at a call
// site if some image genuinely deserves the demotion.

import { useState } from "react";
import type { ImgHTMLAttributes, SyntheticEvent } from "react";

interface FadeImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  priority?: boolean;
}

export default function FadeImage({
  priority = false,
  style,
  loading,
  fetchPriority,
  decoding,
  onLoad,
  ...rest
}: FadeImageProps) {
  const [loaded, setLoaded] = useState(false);
  const visible = priority || loaded;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...rest}
      loading={loading ?? (priority ? "eager" : "lazy")}
      fetchPriority={fetchPriority ?? (priority ? "high" : undefined)}
      decoding={decoding ?? (priority ? "sync" : "async")}
      ref={(el) => {
        if (el && el.complete && el.naturalWidth > 0 && !loaded) setLoaded(true);
      }}
      onLoad={(e: SyntheticEvent<HTMLImageElement>) => {
        setLoaded(true);
        onLoad?.(e);
      }}
      style={{
        ...style,
        opacity: visible ? 1 : 0,
        transition: priority ? style?.transition : "opacity 0.4s ease",
      }}
    />
  );
}
