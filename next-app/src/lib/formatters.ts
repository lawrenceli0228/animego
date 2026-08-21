import type { Lang } from "./i18n";

// Every pick* helper here answers the same question — "for this language,
// which of these fields do I try, and in what order?" — so each one keeps its
// answer in a `Record<Lang, …>` above it rather than in an `if (lang ===
// "zh")`. The conditional form silently hands the English ladder to every
// language that is not Chinese, which fails for a third Chinese variant in the
// most expensive way available: it looks translated, because the chrome around
// it is, so nobody files a bug.

/** First rung of `ladder` whose field holds a non-empty string, else "". */
function firstNonEmpty<T>(obj: T, ladder: readonly (keyof T)[]): string {
  for (const field of ladder) {
    const value = obj[field];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

type TitleBearing = {
  titleChinese?: string | null;
  titleRomaji?: string | null;
  titleEnglish?: string | null;
  titleNative?: string | null;
  /**
   * Traditional Chinese title (migration 0022). Optional because this helper
   * is structural — see the note on DescriptionBearing.descriptionCn — and
   * because it is absent from any response served by a go-api older than that
   * migration. See the hant channel header in lib/types.ts: this is the
   * DISPLAY field. Anything that reaches a search engine must read
   * `titleHantSeo`, which is a different field and not on this ladder.
   */
  titleHant?: string | null;
};

const TITLE_LADDER: Record<Lang, readonly (keyof TitleBearing)[]> = {
  zh: ["titleChinese", "titleNative", "titleRomaji", "titleEnglish"],
  en: ["titleEnglish", "titleRomaji"],
  // Traditional first, then the SIMPLIFIED title, and only then Japanese.
  // titleHant is null on most rows until the backfill runs, and a Simplified
  // title is readable to a Traditional reader in a way romaji and Japanese are
  // not — so the second rung is where nearly all of the value is today.
  // Otherwise identical to zh, including the titleNative rung: a Traditional
  // reader wants the Japanese original ahead of an English localisation for
  // the same reason a Simplified one does.
  "zh-Hant": ["titleHant", "titleChinese", "titleNative", "titleRomaji", "titleEnglish"],
};

/**
 * Pick the best display title for a given language preference.
 *
 * Returns "" if every field on the language's ladder is missing — note that
 * en deliberately stops after two rungs and will NOT fall through to
 * titleNative, so an entry with only a Japanese title renders blank for an
 * English reader. That is the legacy client/src/utils/formatters.js behaviour,
 * preserved verbatim so Phase 4 LandingPage components keep matching.
 */
export function pickTitle(obj: TitleBearing, lang: Lang): string {
  return firstNonEmpty(obj, TITLE_LADDER[lang]);
}

/**
 * Same as TitleBearing but reading the SERP-safe Traditional field.
 *
 * `titleHantSeo` is a generated column (migration 0022) that is NULL whenever
 * `title_hant_source = 'opencc'`. It is a separate field rather than a flag on
 * the same one so that a caller cannot get a machine-converted title by
 * forgetting a check — the value simply is not there.
 */
type SeoTitleBearing = Omit<TitleBearing, "titleHant"> & {
  titleHantSeo?: string | null;
};

const SEO_TITLE_LADDER: Record<Lang, readonly (keyof SeoTitleBearing)[]> = {
  // Identical to TITLE_LADDER for the two languages whose titles never came
  // out of a converter. Written out rather than aliased so that widening Lang
  // forces a decision here too.
  zh: ["titleChinese", "titleNative", "titleRomaji", "titleEnglish"],
  en: ["titleEnglish", "titleRomaji"],
  "zh-Hant": ["titleHantSeo", "titleChinese", "titleNative", "titleRomaji", "titleEnglish"],
};

/**
 * Pick the title for a surface a search engine reads: `<title>`, `og:title`,
 * `twitter:title`, JSON-LD `name`.
 *
 * Differs from pickTitle only for zh-Hant, and only on rows whose Traditional
 * title was machine converted. Those fall through to the Simplified title,
 * which is a real name for the show and one Google already associates with it
 * — unlike a converted name, which is wrong for a measured 15.4% of modern TV
 * anime, with the errors concentrated on popular titles.
 *
 * The visible `<h1>` deliberately keeps using pickTitle. A converted title is
 * perfectly readable Traditional Chinese and is the better thing to show a
 * reader; what is being protected here is narrower — the identity Google
 * learns for the page, which is the least reversible thing on it.
 */
export function pickSeoTitle(obj: SeoTitleBearing, lang: Lang): string {
  return firstNonEmpty(obj, SEO_TITLE_LADDER[lang]);
}

type DescriptionBearing = {
  description?: string | null;
  /**
   * Chinese synopsis (anime_cache.description_cn, migration 0014). Optional
   * here because this helper is deliberately structural: the detail payload
   * carries both fields (AnimeDetail declares them non-optional), every other
   * endpoint carries neither, and both shapes must be accepted. Optionality is
   * about the *callers*, not about the detail wire contract.
   */
  descriptionCn?: string | null;
  /** 'bangumi' | 'llm' | 'manual' — see anime_cache.description_cn_source. */
  descriptionCnSource?: string | null;
  /**
   * Traditional Chinese synopsis (anime_cache.description_hant, migration
   * 0022). Optional for the same structural reason as descriptionCn above.
   */
  descriptionHant?: string | null;
  /** 'opencc' | 'manual' — see anime_cache.description_hant_source. */
  descriptionHantSource?: string | null;
};

export interface DescriptionPick {
  /** Text to render. "" when nothing is available, never null. */
  text: string;
  /**
   * Provenance of `text`: the description_cn_source value when the Chinese
   * column was used, or null when this is AniList's `description` (the
   * fallback, and the only thing en ever gets).
   */
  source: string | null;
}

/**
 * Whether a language may render `description_cn`, the Chinese synopsis.
 *
 * A hard editorial rule, not a fallback: an English reader is never shown the
 * Chinese synopsis no matter how good it is, and no matter how empty the
 * English one is. Stated per language because the answer is genuinely a
 * judgement call for each new audience — a zh-Hant reader almost certainly
 * should get it (converted), and `lang === "zh"` would have said no.
 */
const READS_CHINESE_SYNOPSIS: Record<Lang, boolean> = {
  zh: true,
  en: false,
  // Yes — and this is the case the comment above was written for. A
  // Traditional reader gets descriptionHant when it exists and descriptionCn
  // when it does not; Simplified prose is legible to them, an English
  // synopsis is a different language.
  "zh-Hant": true,
};

/**
 * Where each language looks for its Chinese synopsis, in order.
 *
 * Only consulted for languages that READS_CHINESE_SYNOPSIS admits. Each rung
 * names the text field and the column that records its provenance, because
 * the two must move together — `text` from one rung and `source` from another
 * is the attribution bug pickDescription exists to prevent.
 */
const CHINESE_SYNOPSIS_LADDER: Record<
  Lang,
  readonly { text: keyof DescriptionBearing; source: keyof DescriptionBearing }[]
> = {
  zh: [{ text: "descriptionCn", source: "descriptionCnSource" }],
  en: [],
  "zh-Hant": [
    { text: "descriptionHant", source: "descriptionHantSource" },
    // Falls back to the Simplified synopsis rather than to AniList's English.
    // description_hant is null on every row until the conversion backfill
    // runs, so without this rung zh-Hant would read English prose on the
    // entire catalogue — while still claiming to be a Chinese page.
    { text: "descriptionCn", source: "descriptionCnSource" },
  ],
};

/**
 * Pick the description body copy for a given language preference.
 *
 * - languages in READS_CHINESE_SYNOPSIS: descriptionCn > description
 * - the rest: description, always.
 *
 * Same ladder shape as pickTitle, but it returns provenance alongside the
 * text instead of a bare string. Callers need to know *which* rung they
 * landed on — the Bangumi text is transcribed from a third party, so it
 * carries an attribution line and a `data-nosnippet` boundary that the
 * AniList fallback does not. Recomputing that condition at the call site
 * would let the two drift, and the failure mode is silent: attribution
 * pointing at text we did not source from Bangumi.
 *
 * Rows where description_cn is NULL — every row until the enrichment
 * backfill runs — return exactly what a plain `detail.description` read
 * returned before this channel existed.
 */
export function pickDescription(obj: DescriptionBearing, lang: Lang): DescriptionPick {
  if (READS_CHINESE_SYNOPSIS[lang]) {
    for (const rung of CHINESE_SYNOPSIS_LADDER[lang]) {
      const text = obj[rung.text];
      if (text) return { text, source: obj[rung.source] ?? null };
    }
  }
  return { text: obj.description || "", source: null };
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

// ─── The three name ladders: zh-Hant is a deliberate copy of zh ────────────
//
// There is no Traditional name data. Neither Bangumi nor AniList ships a
// Traditional character, voice-actor or staff name, and migration 0022 added
// a hant channel for TITLES only — nothing on anime_characters or anime_staff.
// So the choice here is not "Traditional or Simplified", it is "Simplified or
// English", and a Simplified 阿尼亞·福傑 serves a Traditional reader far better
// than "Anya Forger" does: the glyphs differ, the name is still read.
//
// This is a KNOWN GAP, not an oversight. When a Traditional name channel
// exists these three tables each grow a rung ahead of the Cn one, exactly as
// TITLE_LADDER already has. Until then, copying zh is the correct answer and
// converting these strings at render time is not — machine-converting a
// person's name is how you get 髮 in a surname.

const CHARACTER_NAME_LADDER: Record<Lang, readonly (keyof CharacterNameBearing)[]> = {
  zh: ["nameCn", "nameJa", "nameEn"],
  en: ["nameEn", "nameJa", "nameCn"],
  "zh-Hant": ["nameCn", "nameJa", "nameEn"],
};

/** Same ladder as CHARACTER_NAME_LADDER, over the voice actor field names. */
const VOICE_ACTOR_NAME_LADDER: Record<Lang, readonly (keyof VoiceActorNameBearing)[]> = {
  zh: ["voiceActorCn", "voiceActorJa", "voiceActorEn"],
  en: ["voiceActorEn", "voiceActorJa", "voiceActorCn"],
  "zh-Hant": ["voiceActorCn", "voiceActorJa", "voiceActorEn"],
};

/**
 * Pick a character display name per language preference.
 *
 * Returns "" when every field is empty. nameCn may be unreliable
 * (Bangumi enrichment historically wrote Japanese into the Cn slot
 * before the 2026-05-27 fix), so the zh fallback ladder still has to
 * tolerate non-Chinese strings — surfacing a Japanese name beats
 * showing nothing. The enrichment cache will heal over time as series
 * pick up bangumiVersion = 2+ writes with the correct field.
 */
export function pickCharacterName(c: CharacterNameBearing, lang: Lang): string {
  return firstNonEmpty(c, CHARACTER_NAME_LADDER[lang]);
}

/** Same ladder as pickCharacterName, applied to voice actor fields. */
export function pickVoiceActorName(c: VoiceActorNameBearing, lang: Lang): string {
  return firstNonEmpty(c, VOICE_ACTOR_NAME_LADDER[lang]);
}

type StaffNameBearing = {
  nameEn?: string | null;
  nameJa?: string | null;
};

/**
 * zh prefers JP — matches the legacy StaffSection.jsx, which intentionally
 * favoured Japanese for Chinese users because staff Chinese translations are
 * mostly absent in Bangumi. That preference is about the *audience*, not about
 * the script, so it is the one ladder here a new Chinese variant should copy
 * from zh rather than reason about from scratch.
 */
const STAFF_NAME_LADDER: Record<Lang, readonly (keyof StaffNameBearing)[]> = {
  zh: ["nameJa", "nameEn"],
  en: ["nameEn", "nameJa"],
  // Copied from zh per the note above this block — and the comment on zh
  // makes it the one ladder where copying is not just the least-bad option:
  // the Japanese-first preference is about the audience, not the script.
  "zh-Hant": ["nameJa", "nameEn"],
};

/**
 * Pick a staff display name, falling back across the available fields.
 *
 * The wire shape from /api/anime/:id is `{nameEn, nameJa, role,
 * imageUrl}` — there is no top-level `name` field; an earlier render
 * mistakenly read `s.name` and rendered "—" for every staff row.
 */
export function pickStaffName(s: StaffNameBearing, lang: Lang): string {
  return firstNonEmpty(s, STAFF_NAME_LADDER[lang]);
}

type EpisodeTitleBearing = {
  /** Bangumi's Chinese episode title. */
  nameCn?: string | null;
  /** The original (usually Japanese) episode title. */
  name?: string | null;
};

/**
 * Which episode-title field each language reaches for first.
 *
 * There is no Traditional episode-title channel — migration 0022 added hant
 * columns for the anime title and synopsis only — so zh-Hant reads nameCn,
 * same as zh, for the same reason the character-name ladders do. Known gap;
 * it grows a rung when the data exists.
 */
const EPISODE_TITLE_LADDER: Record<Lang, readonly (keyof EpisodeTitleBearing)[]> = {
  zh: ["nameCn", "name"],
  en: ["name", "nameCn"],
  "zh-Hant": ["nameCn", "name"],
};

/**
 * Pick an episode's display title, "" when the row carries neither field.
 *
 * Written twice before this — once in the detail page's EpisodeGrid and once
 * in components/anime/EpisodesGrid, as the same `lang === "zh" ? nameCn ||
 * name : name || nameCn` expression. Two copies of a language ternary is two
 * independent chances to miss one, and the grids sit on the same page: fixing
 * one and not the other produces a page whose episode titles change script
 * halfway down.
 */
export function pickEpisodeTitle(
  t: EpisodeTitleBearing | undefined,
  lang: Lang,
): string {
  return t ? firstNonEmpty(t, EPISODE_TITLE_LADDER[lang]) : "";
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
 * Width of a string in "latin character" units, counting CJK as two.
 *
 * A character count is the wrong unit for deciding when prose is long enough
 * to need a read-more control, because the two languages disagree about what
 * a character is worth. 300 Latin characters is two or three sentences; 300
 * Han characters is several paragraphs' worth of content rendered in glyphs
 * that are twice as wide. Measured against the summaries we harvest, every
 * Chinese one lands between 55 and 289 characters while its English
 * counterpart runs 235 to 1100 — so a shared character threshold puts the
 * entire Chinese corpus below the cut and the English one above it.
 *
 * Measuring the text rather than switching on the UI language matters: a
 * Chinese reader whose title has no Chinese summary falls back to the English
 * one, and that text must still be judged by English rules.
 */
export function visualWidth(str: string | null | undefined): number {
  if (!str) return 0;
  let width = 0;
  for (const ch of str) {
    // CJK ideographs, kana, and fullwidth forms render at ~1em; the Latin
    // range at ~0.5em.
    width += /[⺀-鿿＀-￯]/.test(ch) ? 2 : 1;
  }
  return width;
}

/**
 * Truncate on visual width rather than character count, so the cut lands at
 * the same apparent length regardless of script. Appends "..." when cut.
 */
export function truncateVisual(str: string | null | undefined, maxWidth: number): string {
  if (!str) return "";
  if (visualWidth(str) <= maxWidth) return str;
  let width = 0;
  let out = "";
  for (const ch of str) {
    const w = /[⺀-鿿＀-￯]/.test(ch) ? 2 : 1;
    if (width + w > maxWidth) break;
    width += w;
    out += ch;
  }
  return out + "...";
}

// ─── "3 分钟前" ────────────────────────────────────────────────────────────

/** The four buckets `formatRelativeTime` can land in, per language. */
interface RelativeTimeCopy {
  justNow: string;
  minutes: (n: number) => string;
  hours: (n: number) => string;
  days: (n: number) => string;
}

/**
 * Lives here, keyed by Lang, rather than at the two call sites.
 *
 * It was written twice — ActivityFeedView.timeAgo and
 * NotificationBell.relativeTime — as byte-equivalent chains of `lang === "zh"
 * ? … : …`. Two copies of a ternary is two places a third language routes to
 * English, and the notification panel is a surface where that is especially
 * hard to notice: the timestamp is 10px grey text beside copy that IS
 * translated, so the row reads as fine at a glance.
 */
const RELATIVE_TIME: Record<Lang, RelativeTimeCopy> = {
  zh: {
    justNow: "刚刚",
    minutes: (n) => `${n} 分钟前`,
    hours: (n) => `${n} 小时前`,
    days: (n) => `${n} 天前`,
  },
  en: {
    justNow: "just now",
    minutes: (n) => `${n}m ago`,
    hours: (n) => `${n}h ago`,
    days: (n) => `${n}d ago`,
  },
  "zh-Hant": {
    justNow: "剛剛",
    minutes: (n) => `${n} 分鐘前`,
    hours: (n) => `${n} 小時前`,
    days: (n) => `${n} 天前`,
  },
};

const MINUTE_S = 60;
const HOUR_S = 3600;
const DAY_S = 86400;

/**
 * "3 分钟前" / "3m ago" for an ISO timestamp.
 *
 * `nowMs` is a parameter rather than a `Date.now()` call so a server-rendered
 * row and its hydration agree — ActivityFeedView already threaded a pinned
 * clock through for exactly that reason and this preserves it.
 *
 * Returns "" for an unparseable timestamp. NotificationBell previously had no
 * such guard and would render "NaN 天前"; ActivityFeedView did. Taking the
 * careful one is the only behavioural difference between the two originals.
 */
export function formatRelativeTime(iso: string, lang: Lang, nowMs: number): string {
  const parsed = new Date(iso).getTime();
  if (!Number.isFinite(parsed)) return "";
  const copy = RELATIVE_TIME[lang];
  const elapsed = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  if (elapsed < MINUTE_S) return copy.justNow;
  if (elapsed < HOUR_S) return copy.minutes(Math.floor(elapsed / MINUTE_S));
  if (elapsed < DAY_S) return copy.hours(Math.floor(elapsed / HOUR_S));
  return copy.days(Math.floor(elapsed / DAY_S));
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

/** Render a year-bearing fuzzy date. `month`/`day` may still be null. */
type DateRenderer = (fd: FuzzyDate) => string;

const ISO_DATE: DateRenderer = (fd) => {
  const yyyy = String(fd.year);
  if (fd.month == null) return yyyy;
  const mm = String(fd.month).padStart(2, "0");
  if (fd.day == null) return `${yyyy}-${mm}`;
  return `${yyyy}-${mm}-${String(fd.day).padStart(2, "0")}`;
};

const DATE_RENDERER: Record<Lang, DateRenderer> = {
  zh: (fd) =>
    `${fd.year}年${fd.month ? `${fd.month}月` : ""}${fd.day ? `${fd.day}日` : ""}`,
  // ISO-style, for parity with the pre-i18n behaviour.
  en: ISO_DATE,
  // Same shape as zh. 年 / 月 / 日 are identical in both scripts, so this is
  // a copy rather than a conversion — but it is written out rather than
  // aliased to the zh renderer so the two can diverge without surgery.
  "zh-Hant": (fd) =>
    `${fd.year}年${fd.month ? `${fd.month}月` : ""}${fd.day ? `${fd.day}日` : ""}`,
};

/**
 * The language `formatFuzzyDate` uses when a caller omits one.
 *
 * NOT DEFAULT_LANG, and this must not be "fixed" to match it. The only caller
 * that omits the argument is the JSON-LD builder in app/anime/[id]/page.tsx,
 * which writes schema.org `startDate` — a field Google parses as ISO-8601.
 * Defaulting to the site default ("zh") would emit "2021年12月5日" into
 * structured data and invalidate the rich result on every detail page, with
 * no visible symptom in the rendered HTML.
 *
 * A third language therefore does not touch this constant: it adds its own
 * entry to DATE_RENDERER above (which tsc will demand) and leaves the machine
 * -readable default pinned to the renderer that emits ISO.
 */
const MACHINE_READABLE_DATE_LANG: Lang = "en";

/**
 * Render an AniList fuzzy date as YYYY[-MM[-DD]]. Returns null when the
 * date is missing entirely or has no year (a month/day without a year is
 * not formattable in any locale-safe way). Pre-formatted ISO strings are
 * passed through unchanged so this helper is safe to call on legacy data.
 */
export function formatFuzzyDate(
  date: FuzzyDate | string | null | undefined,
  lang: Lang = MACHINE_READABLE_DATE_LANG,
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

  return DATE_RENDERER[lang](fd);
}
