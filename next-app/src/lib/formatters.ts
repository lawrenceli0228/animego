import type { Lang } from "./i18n";

type TitleBearing = {
  titleChinese?: string | null;
  titleRomaji?: string | null;
  titleEnglish?: string | null;
  titleNative?: string | null;
};

/**
 * Pick the best display title for a given language preference.
 *
 * - `zh`: titleChinese > titleNative > titleRomaji > titleEnglish
 * - `en`: titleEnglish > titleRomaji
 *
 * Returns "" if every field is missing. Mirrors the legacy
 * client/src/utils/formatters.js implementation exactly so behavior
 * matches Phase 4 LandingPage components that already use the same pick.
 */
export function pickTitle(obj: TitleBearing, lang: Lang): string {
  if (lang === "zh") {
    return obj.titleChinese || obj.titleNative || obj.titleRomaji || obj.titleEnglish || "";
  }
  return obj.titleEnglish || obj.titleRomaji || "";
}

/**
 * Format a 0-100 AniList score as a 0-10 string ("85" -> "8.5").
 * Returns "N/A" when the score is null / undefined / 0.
 */
export function formatScore(score: number | null | undefined): string {
  return score ? `${score / 10}` : "N/A";
}

/** Strip HTML tags and entity references from a string. */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").replace(/&[^;]+;/g, " ").trim();
}

/** Truncate to `len` chars, appending "..." when cut. */
export function truncate(str: string | null | undefined, len = 150): string {
  if (!str) return "";
  return str.length > len ? str.slice(0, len) + "..." : str;
}
