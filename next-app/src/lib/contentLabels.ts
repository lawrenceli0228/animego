// Chinese labels for AniList *content* enums: genre / format / staff role.
//
// Deliberately NOT in locales/{zh,en}.ts or locales/{zh,en}-spa.js. Those four
// dicts hold UI copy and have a documented drift problem — spaDictCoverage.test.ts
// exists because adding a key to only one pair shipped raw key names to users.
// These maps are *data* enums consumed by both RSC and client components, so a
// single plain module is the only shape that structurally cannot drift.
//
// `en` is always the identity: AniList already speaks English, so every helper
// returns the raw value unchanged for en and only translates for zh. That keeps
// the "English experience must not regress" constraint mechanically true rather
// than review-enforced.
//
// Coverage measured against prod on 2026-08-06 (17,304 rows):
//   genre       19 distinct values  -> 100%
//   format       7 distinct values  -> 100% (TV/OVA/ONA are identical in both
//                                     languages, so ~39% of rows visibly change)
//   staff role   4,794 raw values, 1,405 after suffix normalisation;
//                the 55 entries below cover 91.8% of all 104,412 staff rows.

import type { Lang } from "@/lib/i18n";

// --- Genre -----------------------------------------------------------------

/**
 * Every genre AniList emits for our catalogue. Keep this in sync with the
 * prod `anime_genres` vocabulary — genreCoverage in contentLabels.test.ts
 * asserts the full set is present so a new AniList genre fails CI instead of
 * silently rendering English.
 */
export const GENRE_LABEL: Record<string, string> = {
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
};

/**
 * Genres offered as filter chips on /search and /seasonal. Intentionally a
 * SUBSET of GENRE_LABEL: Hentai is a real value in the catalogue (so it must
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
  if (lang !== "zh") return genre;
  return GENRE_LABEL[genre] ?? genre;
}

// --- Format ----------------------------------------------------------------

/**
 * MUSIC was missing from the previous map in SeasonalFilterChips.tsx, so the
 * 1,207 music-video entries (7% of the catalogue) fell through to the raw enum.
 */
export const FORMAT_LABEL: Record<string, string> = {
  TV: "TV",
  TV_SHORT: "TV 短篇",
  MOVIE: "剧场版",
  SPECIAL: "特别篇",
  OVA: "OVA",
  ONA: "ONA",
  MUSIC: "音乐 MV",
};

export const FORMAT_LABEL_EN: Record<string, string> = {
  TV: "TV",
  TV_SHORT: "Short",
  MOVIE: "Movie",
  SPECIAL: "Special",
  OVA: "OVA",
  ONA: "ONA",
  MUSIC: "Music",
};

/**
 * en maps TV_SHORT -> "Short" (not the raw enum) to match the label the
 * seasonal filter has always shown; every other value is its own name.
 */
export function formatLabel(format: string, lang: Lang): string {
  const map = lang === "zh" ? FORMAT_LABEL : FORMAT_LABEL_EN;
  return map[format] ?? format;
}

// --- Airing status ---------------------------------------------------------

export const STATUS_LABEL: Record<string, string> = {
  RELEASING: "连载中",
  FINISHED: "已完结",
  NOT_YET_RELEASED: "未开播",
  CANCELLED: "已取消",
  HIATUS: "休载中",
};

export const STATUS_LABEL_EN: Record<string, string> = {
  RELEASING: "Airing",
  FINISHED: "Finished",
  NOT_YET_RELEASED: "Upcoming",
  CANCELLED: "Cancelled",
  HIATUS: "Hiatus",
};

export function statusLabel(status: string, lang: Lang): string {
  const map = lang === "zh" ? STATUS_LABEL : STATUS_LABEL_EN;
  return map[status] ?? status;
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

export const STAFF_ROLE_LABEL: Record<string, string> = {
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
};

/**
 * Translate a staff role, preserving any episode/song qualifier that was
 * stripped for lookup: "Episode Director (eps 3, 7)" -> "演出 (eps 3, 7)".
 * Unknown roles fall through to the original string unchanged.
 */
export function staffRoleLabel(role: string, lang: Lang): string {
  if (lang !== "zh") return role;
  const base = normalizeStaffRole(role);
  const zh = STAFF_ROLE_LABEL[base];
  if (!zh) return role;
  const qualifiers = role.match(ROLE_QUALIFIER);
  return qualifiers ? `${zh} ${qualifiers.join(" ")}` : zh;
}

// --- Title picking for relation / recommendation wires ---------------------

/**
 * Relations and recommendations arrive with `title` (romaji) plus an optional
 * `titleChinese`. Both render sites used to hardcode `title || titleChinese`,
 * which suppressed the Chinese title even when it was present — the legacy SPA
 * behaviour, carried over verbatim. Prod has Chinese titles for 79.1% of
 * recommendation rows and 48.7% of relation rows, so this is pure waste in zh.
 */
export function pickRelatedTitle(
  entry: { title?: string | null; titleChinese?: string | null },
  lang: Lang,
): string {
  const zh = entry.titleChinese?.trim() || "";
  const romaji = entry.title?.trim() || "";
  return lang === "zh" ? zh || romaji : romaji || zh;
}
