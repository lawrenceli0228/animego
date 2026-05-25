// @ts-check
// Pure sync check — safe for SSR (returns false if window is undefined).

/**
 * Returns true when the browser supports the File System Access API
 * (window.showDirectoryPicker exists as a function).
 *
 * Safe to call in SSR contexts — returns false if `window` is not defined.
 *
 * @returns {boolean}
 */
export function isFsaSupported() {
  if (typeof window === 'undefined') return false;
  return typeof window.showDirectoryPicker === 'function';
}
