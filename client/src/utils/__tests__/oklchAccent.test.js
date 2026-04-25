import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { normalizePosterAccent, rgbToOklch, BRAND_FALLBACK } from '../oklchAccent.js'

// Load the server CJS module from this ESM test so parity tests reference the
// real server implementation — drift breaks CI instead of the browser.
const requireCjs = createRequire(import.meta.url)
let serverNormalize
try {
  serverNormalize = requireCjs('../../../../server/utils/normalizeAccent.js').normalizePosterAccent
} catch (e) {
  throw new Error(
    'Server normalizeAccent.js not found. Run tests from the monorepo (server/ must be present alongside client/).\n' + e.message,
  )
}

const FIXTURES = [
  '#e53935', // saturated red
  '#1e88e5', // saturated blue
  '#43a047', // saturated green
  '#c19902', // real AniList k-means from Witch from Mercury
  '#f4c2c2', // pastel pink (chroma floor should kick)
  '#2a1810', // near-black dark brown
  '#8b5cf6', // brand violet (identity passthrough)
  '#ffffff', // pure white
  '#000000', // pure black
  '#808080', // pure gray → fallback
]

describe('oklchAccent (client) — parity with server normalizeAccent', () => {
  for (const hex of FIXTURES) {
    it(`matches server output for ${hex}`, () => {
      const client = normalizePosterAccent(hex)
      const server = serverNormalize(hex)
      expect(client.accent.toLowerCase()).toBe(server.accent.toLowerCase())
      expect(client.accentRgb).toBe(server.accentRgb)
    })
  }

  it('falls back on null, empty, invalid, non-hex-like input', () => {
    for (const bad of [null, undefined, '', '#xyz', 'red', '#ff', '#1234567']) {
      const r = normalizePosterAccent(bad)
      expect(r.accent).toBe(BRAND_FALLBACK)
      expect(r.accentRgb).toBe('139, 92, 246')
    }
  })

  it('falls back on grayscale input', () => {
    const r = normalizePosterAccent('#808080')
    expect(r.accent).toBe(BRAND_FALLBACK)
  })

  it('is idempotent — normalizing a normalized value yields the same value', () => {
    const once = normalizePosterAccent('#e53935')
    const twice = normalizePosterAccent(once.accent)
    expect(twice.accent).toBe(once.accent)
    expect(twice.accentRgb).toBe(once.accentRgb)
  })

  it('accepts input without leading # and normalizes case', () => {
    const a = normalizePosterAccent('E53935')
    const b = normalizePosterAccent('#e53935')
    expect(a.accent).toBe(b.accent)
  })
})

describe('rgbToOklch — sanity', () => {
  it('returns near-zero chroma for grayscale', () => {
    const { C } = rgbToOklch({ r: 128, g: 128, b: 128 })
    expect(C).toBeLessThan(0.005)
  })

  it('returns nonzero chroma for saturated color', () => {
    const { C } = rgbToOklch({ r: 229, g: 57, b: 53 })
    expect(C).toBeGreaterThan(0.15)
  })
})
