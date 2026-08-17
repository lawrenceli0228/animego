// Width estimator for filter-chip *skeletons* (search/loading.tsx and
// seasonal/[season]/[year]/loading.tsx).
//
// Those skeletons used to hardcode per-chip pixel widths transcribed from the
// English genre names ("Mahou Shoujo" -> 96px). Once the chips render Chinese
// labels the whole row is ~33% narrower (1462px -> 966px at 18 genres), which
// is enough to drop a wrapped line on a ~1200px container: the skeleton
// reserves two rows, the real content needs one, and the swap jumps. Deriving
// the widths from the labels themselves keeps the skeleton honest and means a
// future label edit can no longer silently re-introduce the shift.
//
// Skeletons are measured against ZH, and that is now an assumption rather
// than a fact. It held while every server render was Chinese (getLang() was
// pinned, since deleted): the swap the user saw was always skeleton ->
// Chinese chips, with English labels arriving only after useLang() reconciled
// from the cookie, well past paint.
//
// Since the route tree moved under app/[lang]/ the chips are SSR'd in the
// URL's language, so on /en/… the first paint is English labels against a
// zh-measured skeleton — the ~33% width gap this module exists to close,
// reopened in the other direction. It is not fixable from inside a
// loading.tsx: like not-found.tsx, Next hands it no params, so it cannot
// learn its own locale. Fixing it properly means either measuring both and
// reserving the wider, or moving the skeleton behind something that has the
// route param. Left as-is because /en is not a published, indexed tree yet;
// revisit before it is.

/** CJK ideographs + fullwidth punctuation render at ~1em; Latin at ~0.58em. */
const CJK = /[　-〿㐀-䶿一-鿿＀-￯]/;

interface ChipMetrics {
  /** Chip font size in px. */
  fontSize?: number;
  /** Horizontal padding per side, in px. */
  paddingX?: number;
  /** Border width per side, in px. */
  border?: number;
}

/**
 * Approximate the rendered width of a chip. Deliberately an estimate, not a
 * measurement — this only feeds decorative skeleton boxes, so being within a
 * few px of the real pill is all that matters.
 */
export function estimateChipWidth(
  label: string,
  { fontSize = 12, paddingX = 10, border = 1 }: ChipMetrics = {},
): number {
  let text = 0;
  for (const ch of label) {
    text += CJK.test(ch) ? fontSize : fontSize * 0.58;
  }
  return Math.round(text + paddingX * 2 + border * 2);
}
