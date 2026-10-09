"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import { anilistImageSrc } from "@/lib/images/anilistImg";

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
//
// An AniList src is the chosen anime's cover standing in for a member with no
// photo. It is sent through the optimizer with our mirror as its source, at
// twice `width` (lib/images/anilistImg.ts), rather than fetched full size from
// AniList by the browser; this is in the navbar on every page. Any other src
// -- a member's own photo, the default card -- is used as given.

interface FallbackImgProps {
  src: string;
  fallback: string;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  loading?: "lazy" | "eager";
  /** The width it is drawn at, in CSS pixels; sizes an AniList src. Avatars: 48. */
  width?: number;
}

const AVATAR_WIDTH = 48;

export default function FallbackImg({
  src,
  fallback,
  alt = "",
  className,
  style,
  loading,
  width = AVATAR_WIDTH,
}: FallbackImgProps) {
  const [errored, setErrored] = useState(false);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={errored ? fallback : anilistImageSrc(src, width)}
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
