import { hexToRgbCss } from '../color';

describe('hexToRgbCss', () => {
  it('parses 6-digit hex with leading #', () => {
    expect(hexToRgbCss('#ffe1b8')).toBe('255, 225, 184');
  });

  it('parses 6-digit hex without leading #', () => {
    expect(hexToRgbCss('ffe1b8')).toBe('255, 225, 184');
  });

  it('parses uppercase hex', () => {
    expect(hexToRgbCss('#FFE1B8')).toBe('255, 225, 184');
  });

  it('parses 3-digit shorthand hex', () => {
    expect(hexToRgbCss('#fab')).toBe('255, 170, 187');
  });

  it('falls back to #8B5CF6 components on null', () => {
    expect(hexToRgbCss(null)).toBe('139, 92, 246');
  });

  it('falls back on undefined', () => {
    expect(hexToRgbCss(undefined)).toBe('139, 92, 246');
  });

  it('falls back on empty string', () => {
    expect(hexToRgbCss('')).toBe('139, 92, 246');
  });

  it('falls back on invalid length (4 chars)', () => {
    expect(hexToRgbCss('#abcd')).toBe('139, 92, 246');
  });

  it('falls back on invalid length (5 chars)', () => {
    expect(hexToRgbCss('#12345')).toBe('139, 92, 246');
  });

  it('falls back on non-hex characters', () => {
    expect(hexToRgbCss('#zzzzzz')).toBe('139, 92, 246');
  });

  it('falls back on non-string input', () => {
    expect(hexToRgbCss(42)).toBe('139, 92, 246');
  });

  it('accepts custom fallback', () => {
    expect(hexToRgbCss(null, '10, 20, 30')).toBe('10, 20, 30');
  });
});
