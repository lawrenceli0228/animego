// How a score is coloured, and the thresholds that decide it.
//
// Pure logic, no React and no DOM, split out of page.tsx for the reason
// testImportHygiene.test.ts states as the repo convention: a test cannot
// import the page. `page.tsx -> DetailActions.tsx -> SubscriptionButton.tsx
// -> react-hot-toast`, and react-hot-toast touches `document` while its module
// is still evaluating, so any suite reaching it dies before its first
// assertion. Same split as animeJsonLd.ts next door.
//
// ## Why this is a module and not two lines in the page
//
// It was two lines in the page, and it shipped a bug to production for as
// long as it was:
//
//     scoreColor(s)          →  #30d158 / #ff9f0a / #ff453a   (three bands)
//     S.scoreBadge(color)    →  background: rgba(255,159,10,0.12)  (always amber)
//
// The foreground knew about bands. The background did not. So every anime
// rated 75 or above rendered green text on an amber pill — live, on the
// site's highest-traffic page, on exactly the titles people search for.
// ★9 and ★8.3 were wrong; ★6 and ★5.7 happened to be right, which is why
// nobody caught it by looking.
//
// The fix is not "also make the background a function". It is that nothing
// can ask for one half any more: the exported style functions each return a
// complete pair, and there is no exported way to get a foreground alone.
// Both halves come out of the same lookup or neither does.
//
// ## Two treatments, because the badge sits on two different things
//
// On a solid surface (detail hero, episode list) the badge is a tinted pill:
// a 12% wash of its own band colour. Over cover artwork (anime cards) that
// wash would be invisible against whatever the poster happens to be, so the
// badge uses an opaque dark scrim instead and only the text carries the band.
// Both are exported as pairs, so picking the wrong treatment is a visible
// mistake rather than a silent mismatch.
//
// ## Three copies, one of them also wrong
//
// This threshold ladder existed verbatim in three files: this page,
// player/_components/EpisodeFileList.tsx, and components/anime/AnimeCard.tsx.
// EpisodeFileList had the identical amber-background defect. AnimeCard was
// correct, because its background is the neutral scrim. All three now read
// the thresholds from here, so the next edit to them cannot reach two of
// three places.

import type { CSSProperties } from "react";

/** The three rating bands. Shared vocabulary with DESIGN.md → Rating Bands. */
export type ScoreBand = "high" | "mid" | "low";

/**
 * The band boundaries, as AniList's 0–100 scale.
 *
 * Site-wide semantics, not a detail-page detail — the anime cards use the
 * same two numbers. Changing one of them means changing DESIGN.md's Rating
 * Bands table in the same commit; scoreStyle.test.ts asserts against these
 * constants and globals.test.ts asserts the table, so a half-change is red.
 */
export const SCORE_THRESHOLDS = {
  /** At or above this is a good score. */
  high: 75,
  /** At or above this is average. Below it is a bad score. */
  mid: 50,
} as const;

/**
 * The custom-property pair each band paints with.
 *
 * Names, not values. The values live in globals.css because DESIGN.md is
 * their source and globals.test.ts pins them there — duplicating the hex
 * here would create a second copy that can drift silently, which is the
 * class of bug this whole module exists to close.
 */
const BAND_VARS: Record<ScoreBand, { fg: string; bg: string }> = {
  high: { fg: "var(--score-high-fg)", bg: "var(--score-high-bg)" },
  mid: { fg: "var(--score-mid-fg)", bg: "var(--score-mid-bg)" },
  low: { fg: "var(--score-low-fg)", bg: "var(--score-low-bg)" },
};

/**
 * Which band a score falls in.
 *
 * Exported for tests and for anywhere that needs the band without the
 * styling — but note that `scoreBadgeStyle` is what a component should
 * reach for. Nothing outside this module should be turning a band into a
 * colour by hand; that is the seam the production bug opened up in.
 */
export function scoreBand(score: number): ScoreBand {
  if (score >= SCORE_THRESHOLDS.high) return "high";
  if (score >= SCORE_THRESHOLDS.mid) return "mid";
  return "low";
}

/**
 * The colour half of a score badge: background and text, always together.
 *
 * Returns only the two coupled properties. Padding, radius, and the mono
 * face are static and belong to the badge's stylesheet rule — mixing them
 * in here would put layout back into a JS object, which is the other half
 * of what this page is being dug out of.
 */
export function scoreBadgeStyle(score: number): Pick<CSSProperties, "background" | "color"> {
  const { fg, bg } = BAND_VARS[scoreBand(score)];
  return { background: bg, color: fg };
}

/**
 * The colour half of a score badge painted **over cover artwork**.
 *
 * Same band foreground, but an opaque scrim instead of the band's own tint:
 * a 12% wash has no contrast guarantee against a poster that could be any
 * colour, and anime covers are deliberately saturated. The scrim gives the
 * text a known background to sit on regardless of what is behind it.
 *
 * A pair for the same reason the tinted variant is a pair — the point is
 * that no caller assembles a background and a foreground itself.
 */
export function scoreScrimStyle(score: number): Pick<CSSProperties, "background" | "color"> {
  return { background: "var(--score-scrim-bg)", color: BAND_VARS[scoreBand(score)].fg };
}

/**
 * The band colour alone, for a score set as running text rather than a pill.
 *
 * The detail hero sets its facts as one sentence — "★ 9 · BGM 7.8 · TV · 连载中"
 * — so the score has no pill to tint. It still has to say which band it is
 * in: that is the actual information, and it is what the production bug
 * destroyed (a 87 rendered green-on-amber, so the background named one band
 * and the text another).
 *
 * Returning a single property is safe here for the reason the pairs above
 * are not: there is no second colour to disagree with. The moment a caller
 * wants a background behind this, it must switch to `scoreBadgeStyle` or
 * `scoreScrimStyle` rather than adding one alongside — assembling the pair
 * at a call site is exactly the seam this module exists to close.
 */
export function scoreTextStyle(score: number): Pick<CSSProperties, "color"> {
  return { color: BAND_VARS[scoreBand(score)].fg };
}
