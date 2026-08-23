"use client";

import { useState } from "react";
import type { CSSProperties } from "react";

// FallbackImg — an <img> that swaps to a fallback once on load error, so a
// rotated/404'd external URL (e.g. an AniList cover whose hash changed)
// shows the default instead of a broken-image icon. A client component so
// it works inside RSC trees (server components can't pass onError). The
// `errored` flag makes the swap one-shot (no loop if the fallback also fails).
//
// `loading` defaults to "lazy". Every current call site is an avatar (24-48px,
// in comment threads, watcher rows, notification items) and most of them are
// below the fold. Leaving it unset meant eager, and React 19 turns a non-lazy
// <img> into a hoisted <link rel="preload" as="image"> — so /anime/[id] was
// preloading /card_default/card.jpg, a 1287x1288 / 126 KB file that renders at
// 24x24, onto the critical path of the page Google indexes. Lazy is not a
// deferral for the ones already in the viewport: those still fetch right away.
// Pass loading="eager" explicitly if a call site ever needs it.

interface FallbackImgProps {
  src: string;
  fallback: string;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  loading?: "lazy" | "eager";
}

export default function FallbackImg({
  src,
  fallback,
  alt = "",
  className,
  style,
  loading,
}: FallbackImgProps) {
  const [errored, setErrored] = useState(false);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={errored ? fallback : src}
      alt={alt}
      className={className}
      style={style}
      loading={loading ?? "lazy"}
      onError={() => {
        if (!errored) setErrored(true);
      }}
    />
  );
}
