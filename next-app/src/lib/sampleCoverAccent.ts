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
 * The OKLCH math lives in lib/oklch.ts. It used to be inlined here, justified
 * by parity tests in the legacy SPA — but that `client/` directory is no
 * longer in the repository, so those tests stopped running when it left, and
 * this file cannot be unit-tested itself (its entry point needs a canvas).
 * The maths is now shared with the detail page's per-anime hue and covered
 * directly by lib/oklch.test.ts.
 */
import type { SampledAccent } from "./accentTypes";
import { oklchToHex, parseHex, rgbToOklch } from "./oklch";

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
