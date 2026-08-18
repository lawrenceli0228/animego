// Chinese labels for AniList *content* enums: genre / format / staff role.
//
// Deliberately NOT in locales/{zh,en}.ts or locales/{zh,en}-spa.js. Those four
// dicts hold UI copy and have a documented drift problem — spaDictCoverage.test.ts
// exists because adding a key to only one pair shipped raw key names to users.
// These maps are *data* enums consumed by both RSC and client components, so a
// single plain module is the only shape that structurally cannot drift.
//
// Every table below is keyed by language FIRST — `Record<Lang, …>` — so a new
// entry in LANGS is a compile error here rather than a silent fallthrough.
// The rule each table states, per language:
//
//   a table  -> that language has its own labels; a key it lacks falls through
//               to the raw AniList value
//   null     -> that language renders AniList's strings verbatim, on purpose
//
// Only `en` is null today, and only because AniList already speaks English.
// The previous encoding of that was `if (lang !== "zh") return raw` — which
// reads as "en is the identity" but MEANS "everything that is not Chinese is
// English". A third language would have inherited English labels inside an
// otherwise-translated page with nothing failing anywhere. Writing `null` per
// language costs one line and forces the decision to be made rather than
// defaulted: a zh-Hant reader wants the zh table, not the English strings.
//
// Coverage measured against prod on 2026-08-06 (17,304 rows):
//   genre       19 distinct values  -> 100%
//   format       7 distinct values  -> 100% (TV/OVA/ONA are identical in both
//                                     languages, so ~39% of rows visibly change)
//   staff role   4,794 raw values, 1,405 after suffix normalisation;
//                the 55 entries below cover 91.8% of all 104,412 staff rows.

import type { Lang } from "@/lib/i18n";

/**
 * One AniList content enum's labels, per language.
 *
 * `null` is not "unset" — it is the explicit statement that this language
 * shows AniList's own strings. contentLabels.test.ts cross-checks the set of
 * languages that declare null against a hand-vetted list, so a new language
 * cannot pick the English identity without someone signing off on it.
 */
type EnumLabels = Record<Lang, Record<string, string> | null>;

/** Shared lookup: the language's table, or the raw value when it has none. */
function labelFor(labels: EnumLabels, value: string, lang: Lang): string {
  return labels[lang]?.[value] ?? value;
}

// --- Genre -----------------------------------------------------------------

/**
 * Every genre AniList emits for our catalogue. Keep this in sync with the
 * prod `anime_genres` vocabulary — genreCoverage in contentLabels.test.ts
 * asserts the full set is present so a new AniList genre fails CI instead of
 * silently rendering English.
 */
export const GENRE_LABEL: EnumLabels = {
  zh: {
    Action: "动作",
    Adventure: "冒险",
    Comedy: "喜剧",
    Drama: "剧情",
    Ecchi: "福利",
    Fantasy: "奇幻",
    Hentai: "成人",
    Horror: "恐怖",
    "Mahou Shoujo": "魔法少女",
    Mecha: "机战",
    Music: "音乐",
    Mystery: "悬疑",
    Psychological: "心理",
    Romance: "恋爱",
    "Sci-Fi": "科幻",
    "Slice of Life": "日常",
    Sports: "运动",
    Supernatural: "超自然",
    Thriller: "惊悚",
  },
  // AniList genre strings ARE the English UI labels.
  en: null,
};

/**
 * Genres offered as filter chips on /search and /seasonal. Intentionally a
 * SUBSET of GENRE_LABEL.zh: Hentai is a real value in the catalogue (so it must
 * render when present on a detail page) but is not offered as a browse filter.
 * Previously hardcoded twice — SearchFilters.tsx and SeasonalFilterChips.tsx
 * each kept their own copy.
 */
export const FILTER_GENRES = [
  "Action",
  "Adventure",
  "Comedy",
  "Drama",
  "Ecchi",
  "Fantasy",
  "Horror",
  "Mahou Shoujo",
  "Mecha",
  "Music",
  "Mystery",
  "Psychological",
  "Romance",
  "Sci-Fi",
  "Slice of Life",
  "Sports",
  "Supernatural",
  "Thriller",
] as const;

export type FilterGenre = (typeof FILTER_GENRES)[number];

export function genreLabel(genre: string, lang: Lang): string {
  return labelFor(GENRE_LABEL, genre, lang);
}

// --- Format ----------------------------------------------------------------

/**
 * Unlike genre and staff role, en is NOT the identity here: it maps
 * TV_SHORT -> "Short" (not the raw enum) to match the label the seasonal
 * filter has always shown. Every other value happens to be its own name.
 *
 * MUSIC was missing from the previous map in SeasonalFilterChips.tsx, so the
 * 1,207 music-video entries (7% of the catalogue) fell through to the raw enum.
 *
 * The two halves used to be `FORMAT_LABEL` / `FORMAT_LABEL_EN`, selected by a
 * ternary. Grepping `_ZH` found neither, because the zh half carried no
 * suffix at all — the pair was only discoverable by reading the selector.
 */
export const FORMAT_LABEL: EnumLabels = {
  zh: {
    TV: "TV",
    TV_SHORT: "TV 短篇",
    MOVIE: "剧场版",
    SPECIAL: "特别篇",
    OVA: "OVA",
    ONA: "ONA",
    MUSIC: "音乐 MV",
  },
  en: {
    TV: "TV",
    TV_SHORT: "Short",
    MOVIE: "Movie",
    SPECIAL: "Special",
    OVA: "OVA",
    ONA: "ONA",
    MUSIC: "Music",
  },
};

export function formatLabel(format: string, lang: Lang): string {
  return labelFor(FORMAT_LABEL, format, lang);
}

// --- Airing status ---------------------------------------------------------

/** Also a real en table rather than the identity — see FORMAT_LABEL. */
export const STATUS_LABEL: EnumLabels = {
  zh: {
    RELEASING: "连载中",
    FINISHED: "已完结",
    NOT_YET_RELEASED: "未开播",
    CANCELLED: "已取消",
    HIATUS: "休载中",
  },
  en: {
    RELEASING: "Airing",
    FINISHED: "Finished",
    NOT_YET_RELEASED: "Upcoming",
    CANCELLED: "Cancelled",
    HIATUS: "Hiatus",
  },
};

export function statusLabel(status: string, lang: Lang): string {
  return labelFor(STATUS_LABEL, status, lang);
}

// --- Source material -------------------------------------------------------

/**
 * A real en table, not the identity: AniList's raw values are screaming-snake
 * enums ("LIGHT_NOVEL", "VISUAL_NOVEL"), not display strings.
 *
 * This lived twice — in app/anime/[id]/page.tsx and in
 * app/player/_components/EpisodeFileList.tsx — as byte-identical eight-entry
 * copies, each written as `Record<string, { zh: string; en: string }>` and
 * read with `SOURCE_LABEL[source]?.[lang]`. Two copies of a table means the
 * next language has to be added to both, and the language-second key order
 * means neither copy would have told anyone which one was missed.
 */
export const SOURCE_LABEL: EnumLabels = {
  zh: {
    ORIGINAL: "原创",
    MANGA: "漫改",
    LIGHT_NOVEL: "轻小说改",
    VISUAL_NOVEL: "视觉小说改",
    VIDEO_GAME: "游戏改",
    NOVEL: "小说改",
    WEB_NOVEL: "网文改",
    GAME: "游戏改",
  },
  en: {
    ORIGINAL: "Original",
    MANGA: "Manga",
    LIGHT_NOVEL: "Light Novel",
    VISUAL_NOVEL: "Visual Novel",
    VIDEO_GAME: "Video Game",
    NOVEL: "Novel",
    WEB_NOVEL: "Web Novel",
    GAME: "Game",
  },
};

/**
 * Returns null rather than the raw enum for an unknown source.
 *
 * Both call sites already discarded misses (`?.[lang] ?? null`) and render
 * the row only when there is a label — showing a reader "WEB_NOVEL" is worse
 * than showing them nothing. That differs from the other helpers here, which
 * fall through to the raw AniList value because theirs is human-readable.
 */
export function sourceLabel(source: string | null | undefined, lang: Lang): string | null {
  if (!source) return null;
  return SOURCE_LABEL[lang]?.[source] ?? null;
}

// --- Season ----------------------------------------------------------------

/** Also a real en table — the raw values are "WINTER", not "Winter". */
export const SEASON_LABEL: EnumLabels = {
  zh: { WINTER: "冬季", SPRING: "春季", SUMMER: "夏季", FALL: "秋季" },
  en: { WINTER: "Winter", SPRING: "Spring", SUMMER: "Summer", FALL: "Fall" },
};

export function seasonLabel(season: string, lang: Lang): string {
  return labelFor(SEASON_LABEL, season, lang);
}

/**
 * "2024 冬季" / "Winter 2024" — the season and its year, ordered per language.
 *
 * The order is the reason this is a function rather than a bare lookup, and
 * the reason it is worth centralising: three surfaces rendered this string
 * and no two of them agreed.
 *
 *   app/u/[username]  zh year-first, en season-first
 *   app/settings      zh year-first, en season-first — but with NO en table,
 *                     so English readers got the raw enum: "WINTER 2024"
 *   app/profile       year-first in BOTH languages: "2024 Winter"
 *
 * Two of the three copies of the label table were byte-identical and the
 * third was half of one. Unifying fixes the raw-enum leak outright and moves
 * /profile's English readout to season-first, matching the other two.
 */
export function seasonYearLabel(season: string, year: string | number, lang: Lang): string {
  const label = seasonLabel(season, lang);
  return lang === "zh" ? `${year} ${label}`.trim() : `${label} ${year}`.trim();
}

// --- Relation type ---------------------------------------------------------

/**
 * How one entry relates to another in AniList's `relations` edge.
 *
 * A real en table for the same reason as SOURCE_LABEL: the raw values are
 * "SIDE_STORY" and "SPIN_OFF", not prose.
 */
export const RELATION_LABEL: EnumLabels = {
  zh: {
    PREQUEL: "前传",
    SEQUEL: "续集",
    SIDE_STORY: "番外",
    PARENT: "本篇",
    CHARACTER: "角色出演",
    SUMMARY: "总集篇",
    ALTERNATIVE: "替代版",
    SPIN_OFF: "衍生作品",
    ADAPTATION: "改编",
    OTHER: "其他",
  },
  en: {
    PREQUEL: "Prequel",
    SEQUEL: "Sequel",
    SIDE_STORY: "Side Story",
    PARENT: "Parent",
    CHARACTER: "Character",
    SUMMARY: "Summary",
    ALTERNATIVE: "Alternative",
    SPIN_OFF: "Spin-Off",
    ADAPTATION: "Adaptation",
    OTHER: "Other",
  },
};

export function relationLabel(relation: string, lang: Lang): string {
  return labelFor(RELATION_LABEL, relation, lang);
}

// --- Staff role ------------------------------------------------------------

/**
 * AniList staff roles are free text, not an enum: prod holds 4,794 distinct
 * values because episode/song qualifiers get appended — "Episode Director
 * (eps 3, 7)", "Theme Song Performance (ED2)", "Key Animation (12 episodes)".
 * Stripping those qualifiers collapses the set to 1,405 and lifts top-50
 * coverage from 84.6% to 91.8%.
 *
 * Only trailing qualifiers that are episode/OP/ED/numeric are stripped. A
 * meaningful parenthetical such as "ADR Director (English)" is left intact and
 * matched whole, because dropping it would merge distinct roles.
 */
// `(?![a-z])` rather than `\b`: the boundary assertion fails on "(OP1)" and
// "(ED2)" because "P"/"D" and the digit are both word characters, so there is
// no boundary between them — those two forms leaked through while bare "(OP)"
// and "(ED)" were stripped. Numbered opening/ending credits are extremely
// common on AniList and "Theme Song Performance" is a top-10 role by volume,
// so the leak measurably depressed the hit rate of STAFF_ROLE_LABEL.
// A meaningful parenthetical such as "(English)" still survives: "En" is
// neither "ep"/"eps" nor "ed".
const ROLE_QUALIFIER = /\((?:eps?\.?|op|ed)(?![a-z])[^)]*\)|\(\s*\d[^)]*\)/gi;

export function normalizeStaffRole(role: string): string {
  return role.replace(ROLE_QUALIFIER, "").replace(/\s+/g, " ").trim();
}

export const STAFF_ROLE_LABEL: EnumLabels = {
  zh: {
    Director: "监督",
    "Character Design": "人物设定",
    "Original Creator": "原作",
    "Art Director": "美术监督",
    Music: "音乐",
    "Series Composition": "系列构成",
    "Theme Song Performance": "主题曲演唱",
    Script: "脚本",
    "Original Character Design": "原作人物设定",
    "Sound Director": "音响监督",
    "Key Animation": "原画",
    "Director of Photography": "摄影监督",
    "Color Design": "色彩设计",
    Editing: "剪辑",
    Storyboard: "分镜",
    "Animation Director": "作画监督",
    "Original Story": "原案",
    "Episode Director": "演出",
    "Prop Design": "道具设定",
    "Art Design": "美术设定",
    "Mechanical Design": "机械设定",
    "Assistant Director": "助理监督",
    Producer: "制片人",
    "Chief Animation Director": "总作画监督",
    Animation: "动画制作",
    "Sound Effects": "音效",
    "Sub Character Design": "副人物设定",
    "Music Performance": "音乐演奏",
    "Chief Director": "总监督",
    "Music Composition": "作曲",
    "Music Lyrics": "作词",
    "Title Logo Design": "标题设计",
    Planning: "企划",
    "Music Arrangement": "编曲",
    "CG Director": "CG 监督",
    "Theme Song Lyrics": "主题曲作词",
    "In-Between Animation": "动画中割",
    "Background Art": "背景美术",
    "Theme Song Composition": "主题曲作曲",
    "Animation Producer": "动画制片人",
    Supervisor: "监修",
    "Main Animator": "主动画师",
    "Theme Song Arrangement": "主题曲编曲",
    "Design Works": "设计",
    Assistance: "协力",
    "Original Plan": "原案",
    "Insert Song Performance": "插入曲演唱",
    Photography: "摄影",
    "Executive Producer": "执行制片人",
    Screenplay: "剧本",
    "ADR Director (English)": "英语配音监督",
    "Original Work Assistance": "原作协力",
    "Design Assistance": "设计协力",
    "Music Vocal Performance": "歌唱",
    "Unit Director": "单元监督",
  },
  // AniList staff roles are already English free text.
  en: null,
};

/**
 * Translate a staff role, preserving any episode/song qualifier that was
 * stripped for lookup: "Episode Director (eps 3, 7)" -> "演出 (eps 3, 7)".
 * Unknown roles fall through to the original string unchanged.
 */
export function staffRoleLabel(role: string, lang: Lang): string {
  const table = STAFF_ROLE_LABEL[lang];
  if (!table) return role; // identity language — see the module header
  const translated = table[normalizeStaffRole(role)];
  if (!translated) return role;
  const qualifiers = role.match(ROLE_QUALIFIER);
  return qualifiers ? `${translated} ${qualifiers.join(" ")}` : translated;
}

// --- Title picking for relation / recommendation wires ---------------------

/**
 * Relations and recommendations arrive with `title` (romaji) plus an optional
 * `titleChinese`. Both render sites used to hardcode `title || titleChinese`,
 * which suppressed the Chinese title even when it was present — the legacy SPA
 * behaviour, carried over verbatim. Prod has Chinese titles for 79.1% of
 * recommendation rows and 48.7% of relation rows, so this is pure waste in zh.
 */
interface RelatedEntry {
  title?: string | null;
  titleChinese?: string | null;
}

/**
 * Which title each language reaches for first, and what it falls back to.
 *
 * Spelled out per language rather than derived from `lang === "zh"`. Both
 * ladders hold the same two fields in opposite order, so the old ternary made
 * "romaji first" the answer for every language that was not Chinese — a
 * zh-Hant reader would have been served romaji ahead of a Chinese title that
 * was sitting right there in the payload.
 */
const RELATED_TITLE_LADDER: Record<Lang, readonly (keyof RelatedEntry)[]> = {
  zh: ["titleChinese", "title"],
  en: ["title", "titleChinese"],
};

export function pickRelatedTitle(entry: RelatedEntry, lang: Lang): string {
  for (const field of RELATED_TITLE_LADDER[lang]) {
    const value = entry[field]?.trim();
    if (value) return value;
  }
  return "";
}
