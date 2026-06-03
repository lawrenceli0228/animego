"use client";

import { useState } from "react";
import type { CSSProperties } from "react";

// FallbackImg — an <img> that swaps to a fallback once on load error, so a
// rotated/404'd external URL (e.g. an AniList cover whose hash changed)
// shows the default instead of a broken-image icon. A client component so
// it works inside RSC trees (server components can't pass onError). The
// `errored` flag makes the swap one-shot (no loop if the fallback also fails).

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
      loading={loading}
      onError={() => {
        if (!errored) setErrored(true);
      }}
    />
  );
}
