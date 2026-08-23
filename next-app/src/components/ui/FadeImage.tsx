"use client";

// Site-wide image fade-in, on top of next/image.
//
// Behaviour it owns: covers start at opacity 0 and transition to 1 on load, so
// a grid fills in as one smooth reveal instead of each image popping at its own
// decode time, over whatever placeholder bg the parent sets.
//
// `priority`: above-the-fold / LCP image — render at full opacity immediately
// (no fade) and load eagerly so its paint isn't delayed.
//
// ## Why this wraps next/image rather than <img>
//
// AniList serves one size for everything: a 460x650 cover, often PNG, often
// ~370 KB, rendered into a 230px card. Routing it through the optimizer gets
// AVIF at the width actually rendered — measured on a typical PNG cover at
// 384w, 371,697 B -> 22,218 B, a 94% cut with SSIM 0.986+.
//
// ## quality defaults to 85 here, and that is not a style preference
//
// Next does not forward `quality` to the AVIF encoder. It forwards
// `quality - 20`:
//
//   image-optimizer.js: transformer.avif({ quality: Math.max(quality - 20, 1), effort: 3 })
//
// So next/image's own default of 75 means AVIF q55, which on flat cel-shaded
// artwork is past the knee — skies and skin start to band. 85 lands on AVIF
// q65, which measures clean. The failure mode is a slightly worse-looking
// image, never an error, so per-call-site discipline would not survive; the
// default lives here instead. `qualities: [75, 85]` in next.config.ts is the
// matching allowlist — Next 16 requires one, and an unlisted value is clamped
// by the component (and 400s if the optimizer URL is hit directly).
//
// ## Non-priority images deliberately do NOT get fetchPriority="low"
//
// They used to, and it was actively harmful: `low` is not "after the priority
// ones", it is a hard demotion that applies even once the image is in the
// viewport. On a grid page (/seasonal, /library) the LCP element IS the first
// card, and no card is marked priority there — so the site was demoting its own
// LCP. `loading="lazy"` (next/image's default) already keeps off-screen covers
// out of the way, which is the part we actually wanted.
//
// ## What we do NOT use: next/image's `preload` prop
//
// `priority` is deprecated in Next 16 in favour of `preload`, but the docs
// steer you off it: "In most cases, you should use loading='eager' or
// fetchPriority='high' instead", and explicitly "do not use it when the
// loading property is used" — which is exactly what we set. React 19 hoists a
// <link rel="preload" as="image"> off fetchPriority="high" on its own, so the
// preload we want happens without the prop.

import { useState } from "react";
import Image from "next/image";
import type { ImageProps } from "next/image";
import type { CSSProperties, SyntheticEvent } from "react";

// next/image's own ImageProps leaves `width`/`height` optional, because `fill`
// is the alternative. That makes a call site that forgets both compile clean
// and throw at RUNTIME ("missing required width property") — inside a client
// component, i.e. a blank section rather than a build failure. This repo runs
// `strict: false`, so there is no help coming from elsewhere either.
//
// Splitting the two modes into a union moves that to compile time: every call
// site must say which one it is, and the 16 that used to pass neither become
// build errors instead of production surprises.
type Sizing =
  | {
      fill?: false;
      width: number | `${number}`;
      height: number | `${number}`;
      /**
       * Omit for fixed-size images. Supplying it makes Next emit the FULL
       * candidate list (15 entries, ~2 KB of srcset per image) instead of the
       * 1x/2x pair derived from `width` — which on a 207-cover homepage is
       * hundreds of KB of extra HTML. Only worth it when the rendered width
       * genuinely tracks the viewport.
       */
      sizes?: string;
    }
  | {
      fill: true;
      /** Required with `fill`: there is no `width` for Next to reason from. */
      sizes: string;
      width?: never;
      height?: never;
    };

type FadeImageProps = Omit<
  ImageProps,
  | "priority"
  | "preload"
  | "loading"
  | "fetchPriority"
  | "decoding"
  | "src"
  | "width"
  | "height"
  | "fill"
  | "sizes"
> &
  Sizing & {
    /**
     * Above-the-fold / LCP image. Loads eagerly at high priority and skips the
     * fade — a fade on the LCP element is a fade on the metric.
     */
    priority?: boolean;
    /**
     * Nullable on purpose: most callers pass a cover URL straight off the API,
     * where it is `string | null`. An empty src renders the placeholder box
     * instead of a broken image.
     */
    src: string | null | undefined;
  };

export default function FadeImage({
  priority = false,
  quality = 85,
  src,
  style,
  onLoad,
  ...rest
}: FadeImageProps) {
  const [loaded, setLoaded] = useState(false);
  const visible = priority || loaded;

  // No source: render the same box the caller styled, so the grid keeps its
  // shape. Callers that want a themed placeholder already pass a background in
  // `style`; this matches what several of them do by hand around a null cover.
  if (!src) {
    return <span aria-hidden style={{ ...style, display: "block" }} className={rest.className} />;
  }

  return (
    <Image
      {...rest}
      src={src}
      quality={quality}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : undefined}
      decoding={priority ? "sync" : "async"}
      onLoad={(e: SyntheticEvent<HTMLImageElement>) => {
        setLoaded(true);
        onLoad?.(e);
      }}
      style={
        {
          ...style,
          opacity: visible ? 1 : 0,
          transition: priority ? style?.transition : "opacity 0.4s ease",
        } as CSSProperties
      }
    />
  );
}
