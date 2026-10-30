// The title buttons above the magnet list, and the panel's accent colours.
//
// Pure: no React, no DOM.

import { oklchCss } from "@/lib/home/tone";

export type TitleVariantKind = "chinese" | "romaji" | "english" | "native";

export interface TitleVariant {
  kind: TitleVariantKind;
  value: string;
}

interface Titles {
  titleChinese: string | null;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
}

/**
 * One button per title the anime has, in the order 中文 / Romaji / English /
 * 日本語. A title equal to one already listed (English is often the romaji)
 * gets no second button.
 *
 * The Chinese button searches the Simplified title in every language: it is
 * the one the trackers index.
 */
export function titleVariants(titles: Titles): TitleVariant[] {
  const candidates: [TitleVariantKind, string | null][] = [
    ["chinese", titles.titleChinese],
    ["romaji", titles.titleRomaji],
    ["english", titles.titleEnglish],
    ["native", titles.titleNative],
  ];
  const seen = new Set<string>();
  const out: TitleVariant[] = [];
  for (const [kind, raw] of candidates) {
    const value = raw?.trim() ?? "";
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, value });
  }
  return out;
}

/**
 * The hue the detail page is painted in, from its computed `--poster-hue`
 * ("225.4"), or null when there is none to read.
 */
export function parseHue(raw: string | null | undefined): number | null {
  const text = raw?.trim() ?? "";
  if (!text) return null;
  const hue = Number.parseFloat(text);
  return Number.isFinite(hue) ? hue : null;
}

/**
 * The panel's accent tokens for one hue: the detail page's 76% / .085 step
 * as text and fills, a lighter step for the solid button's hover, and the
 * dark step that sits on the solid button. A null hue is a neutral grey at
 * the same lightness (see oklchCss).
 */
export function magnetToneVars(hue: number | null): Record<string, string> {
  return {
    "--tone": oklchCss(76, 0.085, hue),
    "--tone-dim": oklchCss(76, 0.085, hue, 0.15),
    "--tone-line": oklchCss(76, 0.085, hue, 0.35),
    "--tone-hover": oklchCss(82, 0.085, hue),
    "--on": oklchCss(18, 0.04, hue),
  };
}
