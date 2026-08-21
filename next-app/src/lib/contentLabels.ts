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
  "zh-Hant": {
    Action: "動作",
    Adventure: "冒險",
    Comedy: "喜劇",
    Drama: "劇情",
    Ecchi: "福利",
    Fantasy: "奇幻",
    Hentai: "成人",
    Horror: "恐怖",
    "Mahou Shoujo": "魔法少女",
    Mecha: "機戰",
    Music: "音樂",
    Mystery: "懸疑",
    Psychological: "心理",
    Romance: "戀愛",
    "Sci-Fi": "科幻",
    "Slice of Life": "日常",
    Sports: "運動",
    Supernatural: "超自然",
    Thriller: "驚悚",
  },
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
  "zh-Hant": {
    TV: "TV",
    TV_SHORT: "TV 短篇",
    MOVIE: "劇場版",
    SPECIAL: "特別篇",
    OVA: "OVA",
    ONA: "ONA",
    MUSIC: "音樂 MV",
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
  "zh-Hant": {
    RELEASING: "連載中",
    FINISHED: "已完結",
    NOT_YET_RELEASED: "未開播",
    CANCELLED: "已取消",
    HIATUS: "休載中",
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
  "zh-Hant": {
    ORIGINAL: "原創",
    MANGA: "漫改",
    LIGHT_NOVEL: "輕小說改",
    VISUAL_NOVEL: "視覺小說改",
    VIDEO_GAME: "遊戲改",
    NOVEL: "小說改",
    WEB_NOVEL: "網文改",
    GAME: "遊戲改",
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

// --- Duration --------------------------------------------------------------

/**
 * Per-episode runtime, e.g. "24分/集" or "24 min/ep".
 *
 * Chinese abbreviates the unit onto the number with no space; English needs
 * both the space and the longer abbreviation. Two call sites — the detail
 * page's meta row and the player's episode list — wrote this as
 * `lang === "zh" ? … : …` independently, which meant a third language got the
 * English form in both places with nothing to see in review.
 */
const DURATION_FORMAT: Record<Lang, (minutes: number | string) => string> = {
  zh: (minutes) => `${minutes}分/集`,
  en: (minutes) => `${minutes} min/ep`,
  "zh-Hant": (minutes) => `${minutes}分/集`,
};

/**
 * Returns null for a missing or zero duration, so callers can skip the row.
 *
 * Takes `string | number` because the two payloads disagree: AnimeDetail
 * types duration as a number, the player's site-anime lookup can hand back
 * the raw string the API sent. Both call sites interpolated it directly
 * before, so both are accepted rather than coerced.
 */
export function durationLabel(
  minutes: number | string | null | undefined,
  lang: Lang,
): string | null {
  return minutes ? DURATION_FORMAT[lang](minutes) : null;
}

// --- Season ----------------------------------------------------------------

/** Also a real en table — the raw values are "WINTER", not "Winter". */
export const SEASON_LABEL: EnumLabels = {
  zh: { WINTER: "冬季", SPRING: "春季", SUMMER: "夏季", FALL: "秋季" },
  en: { WINTER: "Winter", SPRING: "Spring", SUMMER: "Summer", FALL: "Fall" },
  // Identical glyphs to zh — all four season names are already Traditional.
  // Written out rather than aliased to GENRE_LABEL.zh so a later edit to one
  // table cannot silently move the other.
  "zh-Hant": { WINTER: "冬季", SPRING: "春季", SUMMER: "夏季", FALL: "秋季" },
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
/**
 * Which of the two orderings each language uses.
 *
 * Was `lang === "zh" ? year-first : season-first`, which is the silent
 * failure this module's header warns about one enum up: it reads as "Chinese
 * is year-first" but MEANS "everything that is not Simplified Chinese is
 * season-first", so zh-Hant would have rendered "春季 2024" — English word
 * order with Chinese glyphs — with nothing failing anywhere.
 */
const SEASON_YEAR_ORDER: Record<Lang, "year-first" | "season-first"> = {
  zh: "year-first",
  en: "season-first",
  "zh-Hant": "year-first",
};

export function seasonYearLabel(season: string, year: string | number, lang: Lang): string {
  const label = seasonLabel(season, lang);
  return SEASON_YEAR_ORDER[lang] === "year-first"
    ? `${year} ${label}`.trim()
    : `${label} ${year}`.trim();
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
  "zh-Hant": {
    PREQUEL: "前傳",
    SEQUEL: "續集",
    SIDE_STORY: "番外",
    PARENT: "本篇",
    CHARACTER: "角色出演",
    SUMMARY: "總集篇",
    ALTERNATIVE: "替代版",
    SPIN_OFF: "衍生作品",
    ADAPTATION: "改編",
    OTHER: "其他",
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
  // Converted from the zh table with OpenCC s2twp, then hand-corrected.
  // s2twp renders 脚本 as 指令碼 — the computing sense of "script", which is
  // the right Taiwanese word for a shell script and the wrong one for a
  // screenwriting credit. It is 腳本 here. (Same class of miss as 参数 ->
  // 引数: the phrase table is tuned for software vocabulary and these are
  // film-industry terms that happen to collide with it.)
  "zh-Hant": {
    Director: "監督",
    "Character Design": "人物設定",
    "Original Creator": "原作",
    "Art Director": "美術監督",
    Music: "音樂",
    "Series Composition": "系列構成",
    "Theme Song Performance": "主題曲演唱",
    Script: "腳本",
    "Original Character Design": "原作人物設定",
    "Sound Director": "音響監督",
    "Key Animation": "原畫",
    "Director of Photography": "攝影監督",
    "Color Design": "色彩設計",
    Editing: "剪輯",
    Storyboard: "分鏡",
    "Animation Director": "作畫監督",
    "Original Story": "原案",
    "Episode Director": "演出",
    "Prop Design": "道具設定",
    "Art Design": "美術設定",
    "Mechanical Design": "機械設定",
    "Assistant Director": "助理監督",
    Producer: "製片人",
    "Chief Animation Director": "總作畫監督",
    Animation: "動畫製作",
    "Sound Effects": "音效",
    "Sub Character Design": "副人物設定",
    "Music Performance": "音樂演奏",
    "Chief Director": "總監督",
    "Music Composition": "作曲",
    "Music Lyrics": "作詞",
    "Title Logo Design": "標題設計",
    Planning: "企劃",
    "Music Arrangement": "編曲",
    "CG Director": "CG 監督",
    "Theme Song Lyrics": "主題曲作詞",
    "In-Between Animation": "動畫中割",
    "Background Art": "背景美術",
    "Theme Song Composition": "主題曲作曲",
    "Animation Producer": "動畫製片人",
    Supervisor: "監修",
    "Main Animator": "主動畫師",
    "Theme Song Arrangement": "主題曲編曲",
    "Design Works": "設計",
    Assistance: "協力",
    "Original Plan": "原案",
    "Insert Song Performance": "插入曲演唱",
    Photography: "攝影",
    "Executive Producer": "執行製片人",
    Screenplay: "劇本",
    "ADR Director (English)": "英語配音監督",
    "Original Work Assistance": "原作協力",
    "Design Assistance": "設計協力",
    "Music Vocal Performance": "歌唱",
    "Unit Director": "單元監督",
  },
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
  /**
   * Traditional title (migration 0022). Optional for the same structural
   * reason as the rest of this shape: DetailRelation carries it,
   * DetailRecommendation does not, and both are passed to pickRelatedTitle.
   */
  titleHant?: string | null;
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
  // Traditional first, then the Simplified title, then romaji. A Simplified
  // title is a far better answer for a Traditional reader than romaji is, so
  // titleChinese sits above `title` rather than being skipped — the rungs are
  // ordered by how well each serves the reader, not by script purity.
  "zh-Hant": ["titleHant", "titleChinese", "title"],
};

export function pickRelatedTitle(entry: RelatedEntry, lang: Lang): string {
  for (const field of RELATED_TITLE_LADDER[lang]) {
    const value = entry[field]?.trim();
    if (value) return value;
  }
  return "";
}
