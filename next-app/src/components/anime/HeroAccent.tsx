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
 *  - Renders a wrapper <div> exposing `--poster-accent` and
 *    `--poster-accent-rgb` CSS custom properties so .hero-cover / detail
 *    buttons / relation chips can pick up the per-anime identity color.
 *  - Toggles `data-accent-ready="true"` after one rAF so the halo
 *    `transition: box-shadow ...` fires from the neutral baseline.
 *  - Sets `data-accent-fast="true"` when we already had the accent before
 *    mount (cache hit OR non-fallback server accent), shortening the halo-in
 *    duration so direct links don't feel sluggish.
 *  - Aborts any in-flight cover sample on unmount via AbortController.
 *
 * SSR safety: the wrapper renders neutral (no accent vars, ready=false) on
 * first paint. All localStorage / Image / canvas access is gated behind a
 * useEffect, so the component is safe in Next 16's server-render path.
 */

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { CachedAccent, SampledAccent } from "@/lib/accentTypes";
import { readAccent, writeAccent } from "@/lib/accentCache";
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

  const style: AccentStyle | undefined = effectiveAccent
    ? {
        "--poster-accent": effectiveAccent.accent,
        "--poster-accent-rgb": effectiveAccent.rgb,
      }
    : undefined;

  return (
    <div
      data-accent-ready={accentRevealed ? "true" : "false"}
      data-accent-fast={fastHalo ? "true" : "false"}
      style={style}
    >
      {children}
    </div>
  );
}
