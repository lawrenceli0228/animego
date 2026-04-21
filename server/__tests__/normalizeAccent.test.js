const { normalizePosterAccent } = require('../utils/normalizeAccent');

const HEX = /^#[0-9a-f]{6}$/;
const RGB = /^\d{1,3}, \d{1,3}, \d{1,3}$/;
const BRAND = '#8B5CF6';

describe('normalizePosterAccent', () => {
  describe('shape', () => {
    it('returns { raw, accent, accentRgb, accentContrastOnBlack } for valid hex', () => {
      const r = normalizePosterAccent('#f1a143');
      expect(r.raw).toBe('#f1a143');
      expect(r.accent).toMatch(HEX);
      expect(r.accentRgb).toMatch(RGB);
      expect(typeof r.accentContrastOnBlack).toBe('number');
      expect(r.accentContrastOnBlack).toBeGreaterThanOrEqual(1);
      expect(r.accentContrastOnBlack).toBeLessThanOrEqual(21);
    });
  });

  describe('fallbacks to brand violet', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['empty string', ''],
      ['non-string', 42],
      ['malformed hex', '#zzzzzz'],
      ['too short', '#12'],
    ])('on %s input', (_label, input) => {
      const r = normalizePosterAccent(input);
      expect(r.raw).toBeNull();
      expect(r.accent.toLowerCase()).toBe(BRAND.toLowerCase());
    });

    it('on near-grayscale (very low chroma + no meaningful hue) falls back to brand', () => {
      // Pure gray should not produce a tinted result — hue is undefined
      const r = normalizePosterAccent('#808080');
      expect(r.accent.toLowerCase()).toBe(BRAND.toLowerCase());
    });
  });

  describe('chroma clamp (kill pastels)', () => {
    it('boosts chroma on washed peach #f1c9ae', () => {
      // Raw is a low-chroma pastel. After clamp chroma must reach the floor.
      const { accent, raw } = normalizePosterAccent('#f1c9ae');
      expect(raw).toBe('#f1c9ae');
      expect(accent).not.toBe('#f1c9ae'); // Must have been boosted
      // Same hue direction (warm), just more saturated — the hue should survive
      // We check that R > B (warm bias preserved)
      const r = parseInt(accent.slice(1, 3), 16);
      const b = parseInt(accent.slice(5, 7), 16);
      expect(r).toBeGreaterThan(b);
    });

    it('leaves already-saturated color with modest change', () => {
      // #e43543 is a vivid red — chroma already above floor, should change minimally
      const r = normalizePosterAccent('#e43543');
      expect(r.accent).toMatch(HEX);
      // Still clearly red-dominant
      const rr = parseInt(r.accent.slice(1, 3), 16);
      const gg = parseInt(r.accent.slice(3, 5), 16);
      expect(rr).toBeGreaterThan(gg + 50);
    });
  });

  describe('lightness clamp', () => {
    it('lifts very dark color into the band', () => {
      // Near-black hex with some hue — should be lightened to at least L ≈ 0.56
      const r = normalizePosterAccent('#1a0a00');
      expect(r.accent).toMatch(HEX);
      // Luminance should be clearly above near-black
      const rr = parseInt(r.accent.slice(1, 3), 16);
      expect(rr).toBeGreaterThan(80);
    });

    it('drops very light color into the band', () => {
      // Near-white pastel pink — should be darkened to at most L ≈ 0.70
      const r = normalizePosterAccent('#ffeeee');
      expect(r.accent).toMatch(HEX);
      // Should not be as bright as input — one of the channels should have dropped
      const rr = parseInt(r.accent.slice(1, 3), 16);
      expect(rr).toBeLessThan(250);
    });
  });

  describe('contrast on black', () => {
    it('returns a ratio comfortably above 3 for normalized colors (mid lightness)', () => {
      // Normalized accents land in L=[0.56, 0.70] — this is mid-light,
      // contrast against pure black is always well above 3.
      const cases = ['#f1a143', '#e43543', '#e49335', '#f1c9ae', '#8B5CF6'];
      for (const hex of cases) {
        const r = normalizePosterAccent(hex);
        expect(r.accentContrastOnBlack).toBeGreaterThan(3);
      }
    });
  });

  describe('stability', () => {
    it('is idempotent — normalizing a normalized accent yields the same accent', () => {
      const once = normalizePosterAccent('#f1a143');
      const twice = normalizePosterAccent(once.accent);
      expect(twice.accent.toLowerCase()).toBe(once.accent.toLowerCase());
    });

    it('accepts hex without leading #', () => {
      const r = normalizePosterAccent('f1a143');
      expect(r.raw).toBe('#f1a143');
      expect(r.accent).toMatch(HEX);
    });

    it('accepts uppercase hex', () => {
      const r = normalizePosterAccent('#F1A143');
      expect(r.raw.toLowerCase()).toBe('#f1a143');
    });
  });
});
