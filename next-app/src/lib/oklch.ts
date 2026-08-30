/**
 * OKLab / OKLCH colour maths — Björn Ottosson's matrices.
 * https://bottosson.github.io/posts/oklab/
 *
 * Pure functions, no DOM. Safe to import from a server component.
 *
 * This module exists because the maths now has two callers. It used to live
 * inlined in sampleCoverAccent.ts, whose header justified the duplication
 * like this:
 *
 *   "The OKLCH math ... is inlined here rather than imported from a sibling
 *    module — it is a small fixed set of matrices that mirrors
 *    server/utils/normalizeAccent.js and the legacy SPA's
 *    client/src/utils/oklchAccent.js. Parity tests on the legacy side already
 *    pin this math."
 *
 * Both halves of that argument have since expired. The legacy `client/`
 * directory is no longer in the repository, so the parity tests it pointed at
 * do not run anywhere — which left this maths with zero test coverage on the
 * next-app side, in a module whose only entry point needs a canvas and so
 * cannot be unit-tested at all. And the set is no longer used in one place:
 * the detail page derives a per-anime hue from the same pipeline.
 *
 * Extracting it is what makes it testable. See oklch.test.ts.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Oklch {
  /** Perceptual lightness, 0–1. */
  L: number;
  /** Chroma, 0–~0.37 for sRGB. */
  C: number;
  /** Hue in RADIANS, as atan2 returns it (−π…π). */
  h: number;
}

export interface HexAndRgb extends Rgb {
  hex: string;
}

export interface ParsedHex extends Rgb {
  hex: string;
}

/**
 * Below this chroma a colour is grey, and its hue angle is numerical noise —
 * atan2 on a near-zero vector swings wildly on rounding alone. Callers that
 * need a *stable* hue must treat anything under this as "no hue".
 *
 * Matches SATURATION_C_FLOOR in sampleCoverAccent.ts, which drops the same
 * pixels for the same reason.
 */
export const GREY_CHROMA_FLOOR = 0.04;

export function parseHex(input: string | null | undefined): ParsedHex | null {
  if (!input || typeof input !== "string") return null;
  const m = input.replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(m)) return null;
  return {
    hex: `#${m}`,
    r: parseInt(m.slice(0, 2), 16),
    g: parseInt(m.slice(2, 4), 16),
    b: parseInt(m.slice(4, 6), 16),
  };
}

export function srgbToLinear(c: number): number {
  const n = c / 255;
  return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

export function linearToOklab(
  r: number,
  g: number,
  b: number,
): { L: number; a: number; b: number } {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  };
}

export function oklabToLinear(
  L: number,
  a: number,
  b: number,
): { r: number; g: number; b: number } {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  };
}

export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const lin = linearToOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
  const C = Math.sqrt(lin.a * lin.a + lin.b * lin.b);
  const h = Math.atan2(lin.b, lin.a);
  return { L: lin.L, C, h };
}

export function oklchToHex({ L, C, h }: Oklch): HexAndRgb {
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const lin = oklabToLinear(L, a, b);
  const r8 = linearToSrgb(lin.r);
  const g8 = linearToSrgb(lin.g);
  const b8 = linearToSrgb(lin.b);
  const hex = "#" + [r8, g8, b8].map((v) => v.toString(16).padStart(2, "0")).join("");
  return { hex, r: r8, g: g8, b: b8 };
}

/**
 * Convert OKLCH with hue in DEGREES straight to sRGB, the way the `oklch()`
 * CSS function does. Used by the contrast proof in oklch.test.ts so the test
 * reasons about the same numbers the browser will paint.
 */
export function oklchDegToRgb(Lpct: number, C: number, hueDeg: number): Rgb {
  const lin = oklabToLinear(
    Lpct / 100,
    C * Math.cos((hueDeg * Math.PI) / 180),
    C * Math.sin((hueDeg * Math.PI) / 180),
  );
  return { r: linearToSrgb(lin.r), g: linearToSrgb(lin.g), b: linearToSrgb(lin.b) };
}

/** WCAG 2.x relative luminance of an 8-bit sRGB triplet. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG 2.x contrast ratio, 1–21. Order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The OKLCH hue angle of a `#rrggbb` colour, in degrees, normalised to 0–360.
 *
 * Returns null for a malformed hex and for any colour too grey to have a
 * meaningful hue (see GREY_CHROMA_FLOOR) — a caller that substituted 0° there
 * would be picking "red" out of rounding error.
 *
 * This is the seed for the detail page's per-anime palette. Only the ANGLE is
 * taken from the artwork; lightness and chroma are fixed by the design system,
 * which is what keeps the derived colours legible no matter what the cover
 * looks like. Using the sampled colour directly — as the relation chip hover
 * in globals.css still does — spreads contrast-against-page from 4.96:1 to
 * 8.17:1 across the catalogue, because cover art is 51.8% warm and 80.8%
 * highly saturated.
 */
export function hueFromHex(hex: string | null | undefined): number | null {
  const parsed = parseHex(hex);
  if (!parsed) return null;
  const { C, h } = rgbToOklch(parsed);
  if (C < GREY_CHROMA_FLOOR) return null;
  const deg = (h * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}
