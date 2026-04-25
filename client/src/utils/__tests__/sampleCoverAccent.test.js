import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { sampleCoverAccent } from '../sampleCoverAccent.js'

const SAMPLE_W = 32
const SAMPLE_H = 48

function makeSolidPixels(r, g, b, a = 255) {
  const px = new Uint8ClampedArray(SAMPLE_W * SAMPLE_H * 4)
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a
  }
  return px
}

function makeSplitPixels(primary, primaryShare, secondary) {
  const px = new Uint8ClampedArray(SAMPLE_W * SAMPLE_H * 4)
  const total = SAMPLE_W * SAMPLE_H
  const cutoff = Math.floor(total * primaryShare)
  for (let i = 0; i < total; i++) {
    const [r, g, b] = i < cutoff ? primary : secondary
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255
  }
  return px
}

// Install mocks on the jsdom globals. pixelSource mutates between tests.
let pixelSource = null
let shouldThrowSecurity = false
let shouldFailLoad = false

const OriginalImage = globalThis.Image

beforeEach(() => {
  pixelSource = null
  shouldThrowSecurity = false
  shouldFailLoad = false

  // Minimal Image mock: fires onload/onerror synchronously via microtask.
  class MockImage {
    constructor() {
      this.crossOrigin = null
      this.referrerPolicy = null
      this.decoding = null
      this.onload = null
      this.onerror = null
      this._src = ''
    }
    set src(value) {
      this._src = value
      if (!value) return
      queueMicrotask(() => {
        if (shouldFailLoad) this.onerror?.(new Event('error'))
        else this.onload?.(new Event('load'))
      })
    }
    get src() { return this._src }
  }
  globalThis.Image = MockImage

  // Canvas mock: getImageData returns pixelSource or throws SecurityError.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    drawImage: vi.fn(),
    getImageData: vi.fn(() => {
      if (shouldThrowSecurity) {
        throw new DOMException('Tainted canvas', 'SecurityError')
      }
      return { data: pixelSource ?? new Uint8ClampedArray(SAMPLE_W * SAMPLE_H * 4) }
    }),
  }))
})

afterEach(() => {
  globalThis.Image = OriginalImage
  vi.restoreAllMocks()
})

describe('sampleCoverAccent', () => {
  it('returns null when URL is missing', async () => {
    expect(await sampleCoverAccent('')).toBeNull()
    expect(await sampleCoverAccent(null)).toBeNull()
  })

  it('returns a normalized accent for a solid saturated red cover', async () => {
    pixelSource = makeSolidPixels(229, 57, 53)
    const result = await sampleCoverAccent('http://cdn.test/red.png')
    expect(result).not.toBeNull()
    expect(result.accent).toMatch(/^#[0-9a-f]{6}$/)
    expect(result.accentRgb).toMatch(/^\d{1,3}, \d{1,3}, \d{1,3}$/)
  })

  it('returns null for a fully grayscale cover', async () => {
    pixelSource = makeSolidPixels(128, 128, 128)
    expect(await sampleCoverAccent('http://cdn.test/gray.png')).toBeNull()
  })

  it('returns null for pure black', async () => {
    pixelSource = makeSolidPixels(0, 0, 0)
    expect(await sampleCoverAccent('http://cdn.test/black.png')).toBeNull()
  })

  it('returns null for pure white', async () => {
    pixelSource = makeSolidPixels(255, 255, 255)
    expect(await sampleCoverAccent('http://cdn.test/white.png')).toBeNull()
  })

  it('picks the dominant chromatic bucket on a split image', async () => {
    // 70% blue, 30% red → expect blue-ish hue
    pixelSource = makeSplitPixels([30, 136, 229], 0.7, [229, 57, 53])
    const result = await sampleCoverAccent('http://cdn.test/blueish.png')
    expect(result).not.toBeNull()
    // Rough sanity: blue channel higher than red in the normalized output.
    const [r, , b] = result.accentRgb.split(', ').map(Number)
    expect(b).toBeGreaterThan(r)
  })

  it('returns null when getImageData throws SecurityError (CORS taint)', async () => {
    pixelSource = makeSolidPixels(229, 57, 53)
    shouldThrowSecurity = true
    expect(await sampleCoverAccent('http://cdn.test/tainted.png')).toBeNull()
  })

  it('returns null when image fails to load', async () => {
    shouldFailLoad = true
    expect(await sampleCoverAccent('http://cdn.test/404.png')).toBeNull()
  })

  it('returns null when aborted before resolution', async () => {
    // Not actually a race: loadImage runs synchronously up to img.src=...,
    // which schedules a microtask for onload. abort() runs synchronously
    // *before* the microtask, fires the abort listener, rejects the promise,
    // and the later onload resolve becomes a no-op on a settled promise.
    pixelSource = makeSolidPixels(229, 57, 53)
    const controller = new AbortController()
    const promise = sampleCoverAccent('http://cdn.test/red.png', { signal: controller.signal })
    controller.abort()
    expect(await promise).toBeNull()
  })

  it('returns null when aborted before start', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await sampleCoverAccent('http://cdn.test/red.png', { signal: controller.signal })
    expect(result).toBeNull()
  })
})
