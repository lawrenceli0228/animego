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
      fetchPriority={fetchPriority ?? (priority ? "high" : "low")}
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
