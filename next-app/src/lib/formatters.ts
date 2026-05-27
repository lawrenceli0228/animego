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

type CharacterNameBearing = {
  nameEn?: string | null;
  nameJa?: string | null;
  nameCn?: string | null;
};

type VoiceActorNameBearing = {
  voiceActorEn?: string | null;
  voiceActorJa?: string | null;
  voiceActorCn?: string | null;
};

/**
 * Pick a character display name per language preference.
 *
 * - `zh`: nameCn > nameJa > nameEn
 * - `en`: nameEn > nameJa > nameCn
 *
 * Returns "" when every field is empty. nameCn may be unreliable
 * (Bangumi enrichment historically wrote Japanese into the Cn slot
 * before the 2026-05-27 fix), so the zh fallback ladder still has to
 * tolerate non-Chinese strings — surfacing a Japanese name beats
 * showing nothing. The enrichment cache will heal over time as series
 * pick up bangumiVersion = 2+ writes with the correct field.
 */
export function pickCharacterName(c: CharacterNameBearing, lang: Lang): string {
  if (lang === "zh") {
    return c.nameCn || c.nameJa || c.nameEn || "";
  }
  return c.nameEn || c.nameJa || c.nameCn || "";
}

/** Same ladder as pickCharacterName, applied to voice actor fields. */
export function pickVoiceActorName(c: VoiceActorNameBearing, lang: Lang): string {
  if (lang === "zh") {
    return c.voiceActorCn || c.voiceActorJa || c.voiceActorEn || "";
  }
  return c.voiceActorEn || c.voiceActorJa || c.voiceActorCn || "";
}

type StaffNameBearing = {
  nameEn?: string | null;
  nameJa?: string | null;
};

/**
 * Pick a staff display name. zh prefers JP (matches the legacy
 * StaffSection.jsx which intentionally favoured Japanese for Chinese
 * users because staff Chinese translations are mostly absent in
 * Bangumi). en prefers EN. Falls back across the available fields.
 *
 * The wire shape from /api/anime/:id is `{nameEn, nameJa, role,
 * imageUrl}` — there is no top-level `name` field; an earlier render
 * mistakenly read `s.name` and rendered "—" for every staff row.
 */
export function pickStaffName(s: StaffNameBearing, lang: Lang): string {
  if (lang === "zh") {
    return s.nameJa || s.nameEn || "";
  }
  return s.nameEn || s.nameJa || "";
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

/**
 * AniList "fuzzy date" shape — year/month/day can each be null when the
 * source only knew part of the date (a season window, an unannounced day,
 * etc.). The Mongo cache mirrors AniList's shape verbatim, so callers
 * receive this object even though the TypeScript type used to claim
 * `string | null`. Treat anything else (already-normalised ISO string)
 * as opaque and pass through.
 */
export interface FuzzyDate {
  year: number | null;
  month: number | null;
  day: number | null;
}

function isFuzzyDate(value: unknown): value is FuzzyDate {
  return (
    typeof value === "object" &&
    value !== null &&
    "year" in value &&
    "month" in value &&
    "day" in value
  );
}

/**
 * Render an AniList fuzzy date as YYYY[-MM[-DD]]. Returns null when the
 * date is missing entirely or has no year (a month/day without a year is
 * not formattable in any locale-safe way). Pre-formatted ISO strings are
 * passed through unchanged so this helper is safe to call on legacy data.
 */
export function formatFuzzyDate(
  date: FuzzyDate | string | null | undefined,
  lang: Lang = "en",
): string | null {
  if (date == null) return null;

  // Coerce a string date (legacy ISO) to FuzzyDate so localization
  // still works for both representations.
  let fd: FuzzyDate;
  if (typeof date === "string") {
    // Accept "YYYY", "YYYY-MM", "YYYY-MM-DD". Anything else surfaced as-is.
    const m = date.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
    if (!m) return date;
    fd = {
      year: Number(m[1]),
      month: m[2] ? Number(m[2]) : null,
      day: m[3] ? Number(m[3]) : null,
    };
  } else {
    if (!isFuzzyDate(date)) return null;
    fd = date;
  }

  if (fd.year == null) return null;

  if (lang === "zh") {
    const y = `${fd.year}年`;
    const m = fd.month ? `${fd.month}月` : "";
    const d = fd.day ? `${fd.day}日` : "";
    return `${y}${m}${d}`;
  }
  // en: ISO-style stays for parity with previous behavior.
  const yyyy = String(fd.year);
  if (fd.month == null) return yyyy;
  const mm = String(fd.month).padStart(2, "0");
  if (fd.day == null) return `${yyyy}-${mm}`;
  const dd = String(fd.day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
