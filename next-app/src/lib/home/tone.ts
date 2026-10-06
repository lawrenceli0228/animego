// The homepage's per-anime colour, as CSS strings.
//
// Same idea as the detail page's --poster-tone ladder (DESIGN.md "派生色阶"):
// only the HUE ANGLE comes from the artwork; lightness and chroma are fixed
// here, which is what keeps every tint legible whatever the poster looks like.
//
// The difference is where the strings get built. The detail page assembles
// them in CSS on `.poster-scope`, because one element owns one hue. The
// homepage paints dozens of hues at once, and assembling `--poster-tone` from a
// `--poster-hue` declared on a different element is the silent-failure trap
// DESIGN.md warns about (every card renders the same violet). Building the
// final strings in TS and writing them onto the element that uses them makes
// that mistake impossible rather than merely documented.
//
// Pure: no React, no DOM. Safe on both sides of the server/client line.

import { hueFromHex } from "@/lib/oklch";

/**
 * What go-api stores in `poster_accent` when AniList gave no usable cover
 * colour (colorx.NormalizePosterAccent's brand fallback). It is a placeholder,
 * not the anime's colour.
 */
export const BRAND_FALLBACK_ACCENT = "#8b5cf6";

/**
 * The OKLCH hue angle an anime's colours are derived from, or null.
 *
 * Null for the brand fallback as well as for missing, malformed and grey
 * accents: ~7% of the catalogue carries the fallback, and painting those as
 * violet would group unrelated shows under one colour. Null renders neutral.
 */
export function animeHue(posterAccent: string | null | undefined): number | null {
  if (!posterAccent) return null;
  if (posterAccent.trim().toLowerCase() === BRAND_FALLBACK_ACCENT) return null;
  const hue = hueFromHex(posterAccent.trim());
  return hue === null ? null : Math.round(hue * 10) / 10;
}

/**
 * `oklch(L% C h)`, with chroma forced to 0 when there is no hue.
 *
 * 0° is red, so "no hue" must not mean "hue 0" — it means a neutral grey at
 * the same lightness, which keeps every contrast guarantee of the ladder.
 */
export function oklchCss(lightness: number, chroma: number, hue: number | null, alpha?: number): string {
  const body = hue === null ? `${lightness}% 0 0` : `${lightness}% ${chroma} ${hue}`;
  return alpha === undefined ? `oklch(${body})` : `oklch(${body} / ${alpha})`;
}

export interface ToneLadder {
  /** 76% — the anime's colour as text, icons, accents. */
  text: string;
  /** 68% — still text, one step quieter. The last step that may carry words. */
  quiet: string;
  /** 52% — lines and rules only (3.6:1, not text). */
  line: string;
  /** 24% — fills and pill backgrounds only. */
  fill: string;
  /** 15% — text sitting ON a `text`-coloured solid (the one solid button). */
  onSolid: string;
}

export function toneLadder(hue: number | null): ToneLadder {
  return {
    text: oklchCss(76, 0.085, hue),
    quiet: oklchCss(68, 0.07, hue),
    line: oklchCss(52, 0.07, hue),
    fill: oklchCss(24, 0.045, hue),
    onSolid: oklchCss(15, 0.03, hue),
  };
}

/** Written onto a card's own element; its descendants read `var(--tone)` etc. */
export interface CardToneVars {
  "--tone": string;
  "--tone-quiet": string;
  "--tone-line": string;
  "--tone-fill": string;
}

export function cardToneVars(hue: number | null): CardToneVars {
  const t = toneLadder(hue);
  return {
    "--tone": t.text,
    "--tone-quiet": t.quiet,
    "--tone-line": t.line,
    "--tone-fill": t.fill,
  };
}

/**
 * The page-level colours, driven by whichever hero is in focus.
 *
 * The ground/surface/popover layers are near-black with a trace of the hue —
 * chroma ≤ 0.016 — so the page reads as "this anime's night", not as a
 * coloured background. tone.test.ts proves text on all three clears 4.5:1 at
 * every hue.
 */
export interface PageToneVars {
  "--home-ground": string;
  "--home-surface": string;
  "--home-pop": string;
  "--home-tone": string;
  "--home-tone-line": string;
  "--home-tone-fill": string;
  "--home-on-solid": string;
}

export function pageToneVars(hue: number | null): PageToneVars {
  const t = toneLadder(hue);
  return {
    "--home-ground": oklchCss(13, 0.012, hue),
    "--home-surface": oklchCss(18, 0.014, hue),
    "--home-pop": oklchCss(20, 0.016, hue),
    "--home-tone": t.text,
    "--home-tone-line": t.line,
    "--home-tone-fill": t.fill,
    "--home-on-solid": t.onSolid,
  };
}
