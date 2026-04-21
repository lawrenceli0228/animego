/**
 * Parse a hex color (#rrggbb or #rgb) and return "r, g, b" suitable for
 * inlining into rgba() via CSS custom properties.
 *
 * Falls back to the purple brand fallback (#8B5CF6) components when input
 * is null, undefined, or malformed.
 *
 * @param {string | null | undefined} hex
 * @param {string} [fallback='139, 92, 246']
 * @returns {string}
 */
export function hexToRgbCss(hex, fallback = '139, 92, 246') {
  if (!hex || typeof hex !== 'string') return fallback;
  const m = hex.replace(/^#/, '');
  let r, g, b;
  if (m.length === 3) {
    r = parseInt(m[0] + m[0], 16);
    g = parseInt(m[1] + m[1], 16);
    b = parseInt(m[2] + m[2], 16);
  } else if (m.length === 6) {
    r = parseInt(m.slice(0, 2), 16);
    g = parseInt(m.slice(2, 4), 16);
    b = parseInt(m.slice(4, 6), 16);
  } else {
    return fallback;
  }
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return fallback;
  return `${r}, ${g}, ${b}`;
}
