/**
 * Client-side OKLCH accent normalization.
 *
 * MIRROR OF server/utils/normalizeAccent.js — matrices, clamp constants, and
 * normalization logic are kept in sync. The client omits `raw` and
 * `accentContrastOnBlack` (not needed in the browser); parity tests in
 * __tests__/oklchAccent.test.js cover `accent` and `accentRgb` only and
 * break CI on either side if the math drifts.
 *
 * Used by sampleCoverAccent.js so a client-sampled color lands in the same
 * OKLCH band (L 0.56–0.70, C ≥ 0.11) as server-provided accents.
 */

const BRAND_FALLBACK = '#8B5CF6'
const CHROMA_FLOOR = 0.11
const LIGHTNESS_MIN = 0.56
const LIGHTNESS_MAX = 0.70
const GRAYSCALE_THRESHOLD = 0.005

function parseHex(input) {
  if (!input || typeof input !== 'string') return null
  const m = input.replace(/^#/, '').toLowerCase()
  if (!/^[0-9a-f]{6}$/.test(m)) return null
  return {
    hex: `#${m}`,
    r: parseInt(m.slice(0, 2), 16),
    g: parseInt(m.slice(2, 4), 16),
    b: parseInt(m.slice(4, 6), 16),
  }
}

function srgbToLinear(c) {
  const n = c / 255
  return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4)
}

function linearToSrgb(c) {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(v * 255)))
}

// Björn Ottosson's OKLab matrices (https://bottosson.github.io/posts/oklab/)
function linearToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  }
}

function oklabToLinear(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  }
}

function rgbToOklch({ r, g, b }) {
  const lin = linearToOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b))
  const C = Math.sqrt(lin.a * lin.a + lin.b * lin.b)
  const h = Math.atan2(lin.b, lin.a)
  return { L: lin.L, C, h }
}

function oklchToHex({ L, C, h }) {
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const lin = oklabToLinear(L, a, b)
  const r8 = linearToSrgb(lin.r)
  const g8 = linearToSrgb(lin.g)
  const b8 = linearToSrgb(lin.b)
  const hex = '#' + [r8, g8, b8].map(v => v.toString(16).padStart(2, '0')).join('')
  return { hex, r: r8, g: g8, b: b8 }
}

function brandFallback() {
  const parsed = parseHex(BRAND_FALLBACK)
  return {
    accent: BRAND_FALLBACK,
    accentRgb: `${parsed.r}, ${parsed.g}, ${parsed.b}`,
  }
}

export function normalizePosterAccent(input) {
  const parsed = parseHex(input)
  if (!parsed) return brandFallback()

  const { L, C, h } = rgbToOklch(parsed)
  if (C < GRAYSCALE_THRESHOLD) return brandFallback()

  const clampedC = Math.max(C, CHROMA_FLOOR)
  const clampedL = Math.min(Math.max(L, LIGHTNESS_MIN), LIGHTNESS_MAX)

  const result = oklchToHex({ L: clampedL, C: clampedC, h })
  return {
    accent: result.hex,
    accentRgb: `${result.r}, ${result.g}, ${result.b}`,
  }
}

export { rgbToOklch, oklchToHex, BRAND_FALLBACK }
