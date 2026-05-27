/**
 * Client-side cover-image accent sampler (Next.js port of
 * client/src/utils/sampleCoverAccent.js + client/src/utils/oklchAccent.js).
 *
 * Fallback for when AniList's `coverImage.color` is missing and the server
 * returned the brand-violet placeholder. Loads the cover off-DOM with
 * `crossOrigin="anonymous"`, downscales to a hidden canvas, picks the
 * dominant chromatic hue bucket, and normalizes through the shared OKLCH
 * pipeline so the result sits in the same visual band as server accents.
 *
 * Public API:
 *   sampleCoverAccent(coverUrl, { signal? })
 *     → { accent: '#rrggbb', accentRgb: 'R, G, B' } | null
 *
 * Returns `null` on any failure (CORS blocked, 404, decode error, fully
 * grayscale poster, abort). The caller treats `null` as "no halo" — identical
 * UX to the existing fallback path. Never throws.
 *
 * The OKLCH math (rgbToOklch / oklchToHex / normalizePosterAccent) is inlined
 * here rather than imported from a sibling module — it is a small fixed set of
 * matrices that mirrors server/utils/normalizeAccent.js and the legacy SPA's
 * client/src/utils/oklchAccent.js. Parity tests on the legacy side already
 * pin this math; this port is byte-for-byte equivalent for the same inputs.
 */
import type { SampledAccent } from "./accentTypes";

const SAMPLE_W = 32;
const SAMPLE_H = 48;
const ALPHA_MIN = 250;
const SATURATION_C_FLOOR = 0.04;
const LIGHTNESS_MIN_RAW = 0.20;
const LIGHTNESS_MAX_RAW = 0.92;
const HUE_BUCKETS = 24;
const MIN_BUCKET_SHARE = 0.12;
const TAU = Math.PI * 2;

const BRAND_FALLBACK = "#8B5CF6";
const CHROMA_FLOOR = 0.11;
const LIGHTNESS_MIN = 0.56;
const LIGHTNESS_MAX = 0.70;
const GRAYSCALE_THRESHOLD = 0.005;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Oklch {
  L: number;
  C: number;
  h: number;
}

interface HexAndRgb extends Rgb {
  hex: string;
}

interface ParsedHex extends Rgb {
  hex: string;
}

// ─── OKLCH math (inlined from client/src/utils/oklchAccent.js) ───────────────

function parseHex(input: string | null | undefined): ParsedHex | null {
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

function srgbToLinear(c: number): number {
  const n = c / 255;
  return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

// Björn Ottosson's OKLab matrices (https://bottosson.github.io/posts/oklab/)
function linearToOklab(r: number, g: number, b: number): { L: number; a: number; b: number } {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  };
}

function oklabToLinear(L: number, a: number, b: number): { r: number; g: number; b: number } {
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

function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const lin = linearToOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
  const C = Math.sqrt(lin.a * lin.a + lin.b * lin.b);
  const h = Math.atan2(lin.b, lin.a);
  return { L: lin.L, C, h };
}

function oklchToHex({ L, C, h }: Oklch): HexAndRgb {
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const lin = oklabToLinear(L, a, b);
  const r8 = linearToSrgb(lin.r);
  const g8 = linearToSrgb(lin.g);
  const b8 = linearToSrgb(lin.b);
  const hex = "#" + [r8, g8, b8].map((v) => v.toString(16).padStart(2, "0")).join("");
  return { hex, r: r8, g: g8, b: b8 };
}

function brandFallback(): SampledAccent {
  const parsed = parseHex(BRAND_FALLBACK);
  if (!parsed) {
    return { accent: BRAND_FALLBACK, accentRgb: "139, 92, 246" };
  }
  return {
    accent: BRAND_FALLBACK,
    accentRgb: `${parsed.r}, ${parsed.g}, ${parsed.b}`,
  };
}

function normalizePosterAccent(input: string): SampledAccent {
  const parsed = parseHex(input);
  if (!parsed) return brandFallback();

  const { L, C, h } = rgbToOklch(parsed);
  if (C < GRAYSCALE_THRESHOLD) return brandFallback();

  const clampedC = Math.max(C, CHROMA_FLOOR);
  const clampedL = Math.min(Math.max(L, LIGHTNESS_MIN), LIGHTNESS_MAX);

  const result = oklchToHex({ L: clampedL, C: clampedC, h });
  return {
    accent: result.hex,
    accentRgb: `${result.r}, ${result.g}, ${result.b}`,
  };
}

// ─── Sampler (ported from client/src/utils/sampleCoverAccent.js) ────────────

// Cache-busting suffix so the CORS request lands on a different cache entry
// than the page's plain `<img src>`. Without this, Chromium reuses the prior
// no-CORS response (which lacks `Access-Control-Allow-Origin`) and the
// crossOrigin request fails before reaching the CDN. AniList ignores unknown
// query params, so the returned bytes are identical.
function corsCacheBust(url: string): string {
  try {
    const base = typeof location !== "undefined" ? location.href : "http://localhost";
    const u = new URL(url, base);
    u.searchParams.set("accent", "1");
    return u.toString();
  } catch {
    return url + (url.includes("?") ? "&" : "?") + "accent=1";
  }
}

function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.decoding = "async";
    const onAbort = () => {
      img.src = "";
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    img.onload = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve(img);
    };
    img.onerror = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Cover image failed to load"));
    };
    img.src = corsCacheBust(url);
  });
}

function readPixels(img: HTMLImageElement): Uint8ClampedArray | null {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_W;
  canvas.height = SAMPLE_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, SAMPLE_W, SAMPLE_H);
  try {
    return ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
  } catch {
    // SecurityError when the canvas is tainted (CORS preflight failed) — give up.
    return null;
  }
}

interface Bucket {
  count: number;
  sumL: number;
  sumA: number;
  sumB: number;
}

function pickDominantAccent(pixels: Uint8ClampedArray): SampledAccent | null {
  const buckets: Bucket[] = Array.from({ length: HUE_BUCKETS }, () => ({
    count: 0,
    sumL: 0,
    sumA: 0,
    sumB: 0,
  }));
  let validCount = 0;

  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (a < ALPHA_MIN) continue;

    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const { L, C, h } = rgbToOklch({ r, g, b });

    if (C < SATURATION_C_FLOOR) continue;
    if (L < LIGHTNESS_MIN_RAW || L > LIGHTNESS_MAX_RAW) continue;

    const hNorm = ((h % TAU) + TAU) % TAU;
    const idx = Math.min(HUE_BUCKETS - 1, Math.floor(hNorm / (TAU / HUE_BUCKETS)));
    const bucket = buckets[idx];
    bucket.count++;
    bucket.sumL += L;
    // Accumulate a/b in cartesian form to avoid hue-wraparound averaging bugs.
    // cos/sin are 2π-periodic, so raw `h` (in (-π, π] from atan2) and `hNorm`
    // give identical results here — using `h` skips the modulo.
    bucket.sumA += C * Math.cos(h);
    bucket.sumB += C * Math.sin(h);
    validCount++;
  }

  if (validCount === 0) return null;

  let best = buckets[0];
  for (let i = 1; i < buckets.length; i++) {
    if (buckets[i].count > best.count) best = buckets[i];
  }
  if (best.count / validCount < MIN_BUCKET_SHARE) return null;

  const meanL = best.sumL / best.count;
  const meanA = best.sumA / best.count;
  const meanB = best.sumB / best.count;
  const meanC = Math.sqrt(meanA * meanA + meanB * meanB);
  const meanH = Math.atan2(meanB, meanA);

  if (meanC < SATURATION_C_FLOOR) return null;

  const { hex } = oklchToHex({ L: meanL, C: meanC, h: meanH });
  return normalizePosterAccent(hex);
}

export async function sampleCoverAccent(
  coverUrl: string | null | undefined,
  { signal }: { signal?: AbortSignal } = {},
): Promise<SampledAccent | null> {
  if (!coverUrl) return null;
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  try {
    const img = await loadImage(coverUrl, signal);
    if (signal?.aborted) return null;
    const pixels = readPixels(img);
    if (!pixels) return null;
    if (signal?.aborted) return null;
    const result = pickDominantAccent(pixels);
    if (!result) return null;
    // Reject the brand-fallback hex to avoid round-tripping it back in.
    if (result.accent.toLowerCase() === "#8b5cf6") return null;
    return result;
  } catch {
    return null;
  }
}
