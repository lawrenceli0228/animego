// @ts-check
// Pure function — no React, no IDB, no DOM, no async.

/**
 * Noise tokens to strip after lowercasing.
 * Covers resolution, codec, source, audio, subtitle markers.
 */
const NOISE_SET = new Set([
  '1080p', '720p', '480p', '2160p', '4k',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'avc1',
  'bluray', 'blu-ray', 'bdrip', 'bdremux', 'webrip', 'web-dl', 'webdl',
  'hdtv', 'dvdrip', 'dvd',
  'aac', 'ac3', 'flac', 'mp3', 'dts', 'opus', 'vorbis',
  'srtx2', 'srtx1', 'ass', 'pgs', 'sub', 'sup',
  '10bit', '8bit', 'hi10p', 'hi444', 'yuv420',
  'remux', 'amzn', 'nflx', 'hmax',
]);

/** Matches episode/season tokens: S2, S03, E01, EP12, E1, 01~03, ep01-end, etc. */
const EP_TOKEN_RE = /^(?:s\d+|ep?\d+|e\d+|e\d+-\d+|\d{1,3}(?:end)?)$/;

/**
 * Strip leading bracketed group tags: [Group][...], (Group), 【Group】.
 * These typically appear at the start of fansub filenames.
 * @param {string} str
 * @returns {string}
 */
function stripLeadingTags(str) {
  // Remove any leading sequences of [..], (..), 【..】 before real content
  return str.replace(/^(?:\[[^\]]*\]|\([^)]*\)|【[^】]*】|\s)+/, '');
}

/**
 * Normalize a title string into an array of lowercase, half-width tokens
 * with noise and episode-number tokens removed.
 *
 * @param {string|null|undefined} title
 * @returns {string[]}
 */
export function normalizeTokens(title) {
  if (!title || typeof title !== 'string') return [];

  // NFKC: converts full-width digits/letters → ASCII, decomposes ligatures
  let s = title.normalize('NFKC');

  // Strip leading bracketed group tags
  s = stripLeadingTags(s);

  // Also strip any inline bracketed tags containing only noise (e.g. trailing [WebRip 1080p ...])
  s = s.replace(/\[[^\]]*\]/g, ' ');
  s = s.replace(/\([^)]*\)/g, ' ');
  s = s.replace(/【[^】]*】/g, ' ');

  // Lowercase
  s = s.toLowerCase();

  // Split on whitespace and common punctuation delimiters
  const raw = s.split(/[\s\-_.,;:·\\/|+~！？。、]+/);

  const tokens = [];
  for (const tok of raw) {
    const t = tok.trim();
    if (!t) continue;
    if (NOISE_SET.has(t)) continue;
    if (EP_TOKEN_RE.test(t)) continue;
    tokens.push(t);
  }

  return tokens;
}
