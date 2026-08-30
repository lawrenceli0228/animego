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
// ## `unoptimized` is REQUIRED when the host is not ours to enumerate
//
// next.config.ts allows exactly one remote host, s4.anilist.co. Anything else
// -- a dandanplay match's imageUrl, a bgm mirror, whatever a future enrichment
// path writes into IndexedDB -- answers 400 from the optimizer, and this
// component has no onError, so the image simply does not appear. It shipped
// that way once: /library rendered 26 empty cards and 115 console 400s, and
// nothing in the build, the type check or the lint said a word.
//
// So: if the src can be any host, pass `unoptimized`. That is the library and
// player surfaces (SeriesCard, SeriesDetailSheet, UnavailableSeriesSection,
// ManualSearch, DanmakuPicker, EpisodeFileList). It is also the safer default
// there -- those URLs come out of IndexedDB, which SeriesCard's own guard
// notes may be attacker-influenced, and they should not become fetches issued
// by our own server.
//
// ...and relying on every call site to REMEMBER that is what `canOptimize`
// below replaces. The rule above is right and it still shipped a bug, because
// "can this src be any host" is a question about data, not about the call
// site: /anime/{id} passes `characters[].voiceActorImageUrl`, which is an
// AniList URL right up until the Bangumi V2 worker (go-api
// internal/queue/bangumi_v2.go) fills it from bgm, and then it is
// `https://lain.bgm.tv/...`. The call site did not change; the row did.
//
// On a client surface that mistake costs a 400 and a blank card. On this one
// it cost the whole page: the detail route renders on the SERVER, where
// next/image validates the URL against remotePatterns while rendering and
// THROWS rather than returning a broken image. 73 of the 366 character rows
// in one database carried a bgm portrait, and every anime holding one of them
// answered 500.
//
// Detecting it here rather than widening remotePatterns is deliberate. Adding
// lain.bgm.tv to the allowlist would mean allowing its query string too (bgm
// cache-busts with `?r=`), and `search: ""` in next.config.ts exists so that a
// crafted query cannot turn our optimizer into a proxy for arbitrary upstream
// responses. Not optimizing a 400x portrait costs a few KB; the allowlist is
// not the place to pay for it.
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

/** The single host `images.remotePatterns` in next.config.ts allows. */
const OPTIMIZER_HOST = "s4.anilist.co";

/**
 * Whether the optimizer will accept this src, matching next.config.ts.
 *
 * Relative and same-origin paths are always fine — remotePatterns gates remote
 * URLs only. An unparseable src is treated as not optimizable, because the
 * alternative is letting next/image decide, and on a server-rendered route its
 * way of deciding is to throw.
 *
 * Duplicating the hostname here is the cost of the check. It is one string,
 * and the failure it prevents (a 500 on a public catalogue page) is not one
 * that shows up in a build, a type check, or a lint.
 */
function canOptimize(src: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(src)) return true;
  try {
    return new URL(src).host === OPTIMIZER_HOST;
  } catch {
    return false;
  }
}

export default function FadeImage({
  priority = false,
  quality = 85,
  src,
  style,
  onLoad,
  unoptimized,
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
      // An explicit `unoptimized` from the caller still wins: the surfaces
      // that already pass it do so because their srcs come out of IndexedDB
      // and should never become fetches our server issues, which is a
      // stronger reason than "the host happens to be allowed today".
      unoptimized={unoptimized ?? !canOptimize(src)}
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
