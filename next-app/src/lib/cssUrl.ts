// cssUrl builds a safe CSS `url("...")` value for an inline backgroundImage.
//
// User-settable URLs (the avatar photo) are already locked server-side to our
// own /api/avatars/ paths, and backdrops resolve from an anilist id, so none
// of the URLs reaching a background are attacker-controlled free text. This is
// defense-in-depth: only same-origin, http(s), or image data URLs are allowed,
// and any value carrying a quote / paren / backslash / newline (which could
// break out of the url("...") wrapper) falls back instead of being injected.

const SAFE_SCHEME = /^(https?:\/\/|\/|data:image\/)/i;
const BREAKOUT_CHARS = /["'()\\\n\r]/;

export function cssUrl(url: string | null | undefined, fallback: string): string {
  const safe = url && SAFE_SCHEME.test(url) && !BREAKOUT_CHARS.test(url) ? url : fallback;
  return `url("${safe}")`;
}
