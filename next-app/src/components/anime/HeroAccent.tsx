"use client";

/**
 * Per-anime poster-accent wrapper for the detail page hero.
 *
 * Ports the host pattern from client/src/components/anime/AnimeDetailHero.jsx
 * (lines 105–189) into a self-contained Next.js `'use client'` component.
 *
 * Public API (consumed by app/anime/[id]/page.tsx):
 *
 *   <HeroAccent
 *     anilistId={anime.anilistId}
 *     coverImageUrl={anime.coverImageUrl}
 *     posterAccent={anime.posterAccent}          // server-provided hex or null
 *     posterAccentRgb={anime.posterAccentRgb}    // "R, G, B" or null
 *   >
 *     ...hero markup including <img className="hero-cover" />...
 *   </HeroAccent>
 *
 * Behavior:
 *  - Server accent counts only when not the brand-violet fallback (#8b5cf6).
 *  - Otherwise, on mount: read localStorage cache; if miss, sample the cover
 *    via canvas k-means in OKLCH space. Cache successful samples.
 *  - Renders a wrapper <div> exposing `--poster-accent`, `--poster-accent-rgb`
 *    and `--poster-hue` CSS custom properties so .hero-cover / detail buttons
 *    / relation chips can pick up the per-anime identity color.
 *
 *    `--poster-hue` is the OKLCH hue ANGLE, and it is the one the derived
 *    palette in page.module.css builds on. The first two are the raw sampled
 *    colour, which is not contrast-managed — see the note by `const hue`.
 *  - Toggles `data-accent-ready="true"` after one rAF so the halo
 *    `transition: box-shadow ...` fires from the neutral baseline.
 *  - Sets `data-accent-fast="true"` when we already had the accent before
 *    mount (cache hit OR non-fallback server accent), shortening the halo-in
 *    duration so direct links don't feel sluggish.
 *  - Aborts any in-flight cover sample on unmount via AbortController.
 *
 * SSR safety: all localStorage / Image / canvas access is gated behind a
 * useEffect, so the component is safe in Next 16's server-render path.
 *
 * What that does NOT mean — this line used to read "the wrapper renders
 * neutral (no accent vars) on first paint", and that is only true of the
 * sampled path. `serverAccent` is a useMemo over props, so it evaluates
 * during the server render: when the row has a real accent the custom
 * properties ARE in the initial HTML. Verified against production, where the
 * detail document ships `style="--poster-accent:#7caf62;..."` with scripts
 * disabled. Only `data-accent-ready` starts false, because it gates the halo
 * transition — that is the part that is neutral on first paint.
 */

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { CachedAccent, SampledAccent } from "@/lib/accentTypes";
import { readAccent, writeAccent } from "@/lib/accentCache";
import { hueFromHex } from "@/lib/oklch";
import { sampleCoverAccent } from "@/lib/sampleCoverAccent";

const FALLBACK_ACCENT = "#8b5cf6";

interface HeroAccentProps {
  anilistId: number;
  coverImageUrl: string | null;
  posterAccent: string | null;
  posterAccentRgb: string | null;
  children: ReactNode;
}

interface ActiveAccent {
  accent: string;
  rgb: string;
}

// Style typed to allow CSS custom-property keys without `as any`.
type AccentStyle = CSSProperties & {
  "--poster-accent"?: string;
  "--poster-accent-rgb"?: string;
  "--poster-hue"?: string;
};

function normalizeServerAccent(
  posterAccent: string | null,
  posterAccentRgb: string | null,
): ActiveAccent | null {
  if (!posterAccent || !posterAccentRgb) return null;
  if (posterAccent.toLowerCase() === FALLBACK_ACCENT) return null;
  return { accent: posterAccent, rgb: posterAccentRgb };
}

export default function HeroAccent({
  anilistId,
  coverImageUrl,
  posterAccent,
  posterAccentRgb,
  children,
}: HeroAccentProps) {
  const serverAccent = useMemo(
    () => normalizeServerAccent(posterAccent, posterAccentRgb),
    [posterAccent, posterAccentRgb],
  );

  // Cache lookup runs synchronously inside an effect, but we want fastHalo
  // to reflect "was this accent known before the user saw the page" — that
  // includes both server-provided and previously-cached-client accents.
  // The cache check itself is in the effect below; we mirror the result here.
  const [sampledAccent, setSampledAccent] = useState<SampledAccent | null>(null);
  const [primedFromCache, setPrimedFromCache] = useState(false);

  useEffect(() => {
    // When the server already gave us a real accent, no sampling is needed.
    if (serverAccent || !coverImageUrl) {
      setSampledAccent(null);
      setPrimedFromCache(false);
      return;
    }

    // Revisit short-circuit: if we sampled this cover before, restore from cache.
    const cached: CachedAccent | null = anilistId ? readAccent(anilistId) : null;
    if (cached?.source === "client") {
      setSampledAccent({ accent: cached.accent, accentRgb: cached.rgb });
      setPrimedFromCache(true);
      return;
    }

    setSampledAccent(null);
    setPrimedFromCache(false);

    const controller = new AbortController();
    sampleCoverAccent(coverImageUrl, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted || !result) return;
        setSampledAccent(result);
        if (anilistId) writeAccent(anilistId, result.accent, result.accentRgb, "client");
      })
      .catch(() => {
        // sampleCoverAccent already swallows failures; this catch is belt-and-braces.
      });

    return () => controller.abort();
  }, [serverAccent, coverImageUrl, anilistId]);

  const effectiveAccent: ActiveAccent | null = serverAccent
    ? serverAccent
    : sampledAccent
      ? { accent: sampledAccent.accent, rgb: sampledAccent.accentRgb }
      : null;

  // Reveal on next frame so CSS transitions fire even on first paint.
  const [accentRevealed, setAccentRevealed] = useState(false);
  useEffect(() => {
    if (!effectiveAccent) {
      setAccentRevealed(false);
      return;
    }
    const id = requestAnimationFrame(() => setAccentRevealed(true));
    return () => cancelAnimationFrame(id);
  }, [effectiveAccent?.accent]);

  // `fastHalo` shortens the transition when the accent was already known —
  // direct links / refreshes shouldn't pay the long appear delay.
  const fastHalo = !!serverAccent || primedFromCache;

  // The hue angle, as a bare number for `oklch(L C var(--poster-hue))`.
  //
  // This is the seed for the detail page's derived palette, and it is
  // deliberately the ONLY thing the artwork gets to decide — lightness and
  // chroma are fixed by page.module.css. Handing the sampled colour itself to
  // `color:` (as .hero-relation-chip in globals.css still does) spreads
  // contrast-against-black from 3.58:1 to 8.84:1 across real cover accents,
  // i.e. some anime render the chip below the WCAG floor and some do not,
  // with nothing in the system bounding which. Re-deriving from the angle
  // keeps the anime's identity and drops the swing; lib/oklch.test.ts proves
  // the floor holds at all 360 hues.
  //
  // Omitted, not zeroed, when the accent is too grey to have a stable hue:
  // 0 is red, and `oklch(76% .085 0)` on a monochrome poster would be a
  // colour the artwork never contained. The `:root` fallback covers it.
  const hue = effectiveAccent ? hueFromHex(effectiveAccent.accent) : null;

  const style: AccentStyle | undefined = effectiveAccent
    ? {
        "--poster-accent": effectiveAccent.accent,
        "--poster-accent-rgb": effectiveAccent.rgb,
        ...(hue === null ? {} : { "--poster-hue": hue.toFixed(1) }),
      }
    : undefined;

  // `poster-scope` (globals.css) rebuilds --poster-tone* from the hue set on
  // THIS element. It cannot be left to :root: a custom property's var()
  // substitution runs on the element that declares it, so the :root copies
  // resolve against the fallback hue and inherit down already finished. The
  // class and the inline hue therefore have to land together — splitting them
  // gives every anime the same violet while the stylesheet still reads right.
  return (
    <div
      className="poster-scope"
      data-accent-ready={accentRevealed ? "true" : "false"}
      data-accent-fast={fastHalo ? "true" : "false"}
      style={style}
    >
      {children}
    </div>
  );
}
