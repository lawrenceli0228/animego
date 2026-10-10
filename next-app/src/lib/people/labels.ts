// Labels for the data values on the person and character pages: a
// character's role, a voice's language and notes, gender, occupations, blood
// type and home town.
//
// Code tables rather than dictionary keys, for the reason lib/contentLabels.ts
// gives: these are data enums (and AniList free text), read by server and
// client components alike, and a Record<Lang, …> is a compile error when a
// language is added rather than a key that silently renders as itself. `null`
// for a language means it shows AniList's own (English) string on purpose.

import type { Lang } from "@/lib/i18n/lang";

type Labels = Record<Lang, Record<string, string> | null>;

function lookup(labels: Labels, value: string, lang: Lang): string {
  return labels[lang]?.[value] ?? value;
}

// ── A character's role on a title ─────────────────────────────────────────

/** The same three words the detail page's cast list uses. */
export const CHARACTER_ROLE_LABEL: Record<Lang, Record<string, string>> = {
  zh: { MAIN: "主角", SUPPORTING: "配角", BACKGROUND: "客串" },
  en: { MAIN: "Main", SUPPORTING: "Supporting", BACKGROUND: "Background" },
  "zh-Hant": { MAIN: "主角", SUPPORTING: "配角", BACKGROUND: "客串" },
};

/** The role's label, or null when AniList gave none. */
export function characterRoleLabel(role: string | null | undefined, lang: Lang): string | null {
  if (!role) return null;
  return CHARACTER_ROLE_LABEL[lang][role.toUpperCase()] ?? role;
}

// ── A voice's language and notes ──────────────────────────────────────────

/**
 * AniList's languageV2 labels as a dub is named in Chinese: 日配, 中配. The
 * credits keep Japanese voices only, so 日配 is the one a page shows; the
 * others stay so a voice in another language, should one ever reach a page,
 * still reads as a dub name rather than in English on a Chinese page.
 */
const DUB_LANGUAGE_LABEL: Labels = {
  zh: {
    Japanese: "日配",
    Chinese: "中配",
    Korean: "韩配",
    English: "英配",
    French: "法配",
    German: "德配",
    Spanish: "西配",
    Portuguese: "葡配",
    Italian: "意配",
    Thai: "泰配",
  },
  en: null,
  "zh-Hant": {
    Japanese: "日配",
    Chinese: "中配",
    Korean: "韓配",
    English: "英配",
    French: "法配",
    German: "德配",
    Spanish: "西配",
    Portuguese: "葡配",
    Italian: "義配",
    Thai: "泰配",
  },
};

export function dubLanguageLabel(language: string | null | undefined, lang: Lang): string | null {
  if (!language) return null;
  return lookup(DUB_LANGUAGE_LABEL, language, lang);
}

/** The words AniList's role notes are made of, translated where common. */
const ROLE_NOTE_WORD: Labels = {
  zh: {
    Childhood: "童年",
    Child: "幼年",
    Young: "幼年",
    Teen: "少年",
    Adult: "成年",
    Elderly: "老年",
    Old: "老年",
    Female: "女性",
    Male: "男性",
  },
  en: null,
  "zh-Hant": {
    Childhood: "童年",
    Child: "幼年",
    Young: "幼年",
    Teen: "少年",
    Adult: "成年",
    Elderly: "老年",
    Old: "老年",
    Female: "女性",
    Male: "男性",
  },
};

/** "ep 511", "eps 440-", "eps 233-1122", "eps 103, 104". */
const EPISODES = /^eps?\.?\s+([\d\s,\-–]+)$/i;

function episodeNote(part: string, lang: Lang): string | null {
  const m = EPISODES.exec(part);
  if (!m || lang === "en") return null;
  const spec = m[1].trim();
  const open = /[-–]$/.test(spec);
  const body = spec
    .replace(/[-–]$/, "")
    .split(",")
    .map((s) => s.trim().replace(/\s*[-–]\s*/, "–"))
    .filter(Boolean)
    .join("、");
  if (!body) return null;
  return open ? `第 ${body} 集起` : `第 ${body} 集`;
}

/**
 * AniList's role notes in the reader's language: each `;`-separated part
 * translated when it is a known word or an episode range, kept as written
 * otherwise. "Adult; eps 1116-" → "成年 · 第 1116 集起".
 */
export function roleNotesLabel(notes: string | null | undefined, lang: Lang): string | null {
  if (!notes?.trim()) return null;
  return notes
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => episodeNote(p, lang) ?? lookup(ROLE_NOTE_WORD, p, lang))
    .join(" · ");
}

/** "日配 · 童年": a voice's language and notes, as one line. */
export function voiceLine(language: string | null, notes: string | null, lang: Lang): string {
  return [dubLanguageLabel(language, lang), roleNotesLabel(notes, lang)].filter(Boolean).join(" · ");
}

// ── Profile facts ─────────────────────────────────────────────────────────

// "Other" is the edit form's third choice (the canvas's 其他); AniList's own
// values are free text, and the ones it uses are the first three.
const GENDER_LABEL: Labels = {
  zh: { Male: "男", Female: "女", "Non-binary": "非二元", Other: "其他" },
  en: null,
  "zh-Hant": { Male: "男", Female: "女", "Non-binary": "非二元", Other: "其他" },
};

export function genderLabel(gender: string | null | undefined, lang: Lang): string | null {
  if (!gender?.trim()) return null;
  return lookup(GENDER_LABEL, gender.trim(), lang);
}

/** The ABO groups, with or without a Rh sign. Anything else prints as given. */
const BLOOD_TYPE = /^(A|B|AB|O)([+-])?$/i;

export function bloodTypeLabel(bloodType: string | null | undefined, lang: Lang): string | null {
  const raw = bloodType?.trim();
  if (!raw) return null;
  const m = BLOOD_TYPE.exec(raw);
  if (!m || lang === "en") return raw;
  return `${m[1].toUpperCase()}${m[2] ?? ""}型`;
}

/**
 * AniList's primaryOccupations are free text. The ones that recur on anime
 * staff are translated; the rest print as AniList has them.
 */
const OCCUPATION_LABEL: Labels = {
  zh: {
    "Voice Actor": "声优",
    "Voice Actress": "声优",
    Actor: "演员",
    Actress: "演员",
    Narrator: "旁白",
    Singer: "歌手",
    Vocalist: "歌手",
    Musician: "音乐人",
    Composer: "作曲",
    Lyricist: "作词",
    Arranger: "编曲",
    Director: "导演",
    "Episode Director": "演出",
    "Storyboard Artist": "分镜",
    Animator: "动画师",
    "Animation Director": "作画监督",
    "Key Animator": "原画",
    "Character Designer": "角色设计",
    Illustrator: "插画家",
    Mangaka: "漫画家",
    Writer: "作家",
    Novelist: "小说家",
    Screenwriter: "编剧",
    "Series Composition": "系列构成",
    Producer: "制片人",
    "Sound Director": "音响监督",
    "Art Director": "美术监督",
    Photographer: "摄影",
  },
  en: null,
  "zh-Hant": {
    "Voice Actor": "聲優",
    "Voice Actress": "聲優",
    Actor: "演員",
    Actress: "演員",
    Narrator: "旁白",
    Singer: "歌手",
    Vocalist: "歌手",
    Musician: "音樂人",
    Composer: "作曲",
    Lyricist: "作詞",
    Arranger: "編曲",
    Director: "導演",
    "Episode Director": "演出",
    "Storyboard Artist": "分鏡",
    Animator: "動畫師",
    "Animation Director": "作畫監督",
    "Key Animator": "原畫",
    "Character Designer": "角色設計",
    Illustrator: "插畫家",
    Mangaka: "漫畫家",
    Writer: "作家",
    Novelist: "小說家",
    Screenwriter: "編劇",
    "Series Composition": "系列構成",
    Producer: "製片人",
    "Sound Director": "音響監督",
    "Art Director": "美術監督",
    Photographer: "攝影",
  },
};

/** Occupations, translated, without blanks and repeats (Actor and Actress are one tag). */
export function occupationLabels(occupations: readonly string[], lang: Lang): string[] {
  const out: string[] = [];
  for (const o of occupations) {
    const label = o.trim() ? lookup(OCCUPATION_LABEL, o.trim(), lang) : "";
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

// ── Home town ─────────────────────────────────────────────────────────────

/**
 * Japan's prefectures, as AniList romanises them, in Chinese. Nearly every
 * voice actor's home town is "<city>, <prefecture> Prefecture, Japan" or
 * "Tokyo, Japan", and the prefecture is the part a Chinese reader can use;
 * a romanised city name in the middle of a Chinese page is not.
 */
const PREFECTURES: Record<string, { zh: string; hant: string }> = {
  hokkaido: { zh: "北海道", hant: "北海道" },
  aomori: { zh: "青森县", hant: "青森縣" },
  iwate: { zh: "岩手县", hant: "岩手縣" },
  miyagi: { zh: "宫城县", hant: "宮城縣" },
  akita: { zh: "秋田县", hant: "秋田縣" },
  yamagata: { zh: "山形县", hant: "山形縣" },
  fukushima: { zh: "福岛县", hant: "福島縣" },
  ibaraki: { zh: "茨城县", hant: "茨城縣" },
  tochigi: { zh: "栃木县", hant: "栃木縣" },
  gunma: { zh: "群马县", hant: "群馬縣" },
  saitama: { zh: "埼玉县", hant: "埼玉縣" },
  chiba: { zh: "千叶县", hant: "千葉縣" },
  tokyo: { zh: "东京都", hant: "東京都" },
  kanagawa: { zh: "神奈川县", hant: "神奈川縣" },
  niigata: { zh: "新潟县", hant: "新潟縣" },
  toyama: { zh: "富山县", hant: "富山縣" },
  ishikawa: { zh: "石川县", hant: "石川縣" },
  fukui: { zh: "福井县", hant: "福井縣" },
  yamanashi: { zh: "山梨县", hant: "山梨縣" },
  nagano: { zh: "长野县", hant: "長野縣" },
  gifu: { zh: "岐阜县", hant: "岐阜縣" },
  shizuoka: { zh: "静冈县", hant: "靜岡縣" },
  aichi: { zh: "爱知县", hant: "愛知縣" },
  mie: { zh: "三重县", hant: "三重縣" },
  shiga: { zh: "滋贺县", hant: "滋賀縣" },
  kyoto: { zh: "京都府", hant: "京都府" },
  osaka: { zh: "大阪府", hant: "大阪府" },
  hyogo: { zh: "兵库县", hant: "兵庫縣" },
  nara: { zh: "奈良县", hant: "奈良縣" },
  wakayama: { zh: "和歌山县", hant: "和歌山縣" },
  tottori: { zh: "鸟取县", hant: "鳥取縣" },
  shimane: { zh: "岛根县", hant: "島根縣" },
  okayama: { zh: "冈山县", hant: "岡山縣" },
  hiroshima: { zh: "广岛县", hant: "廣島縣" },
  yamaguchi: { zh: "山口县", hant: "山口縣" },
  tokushima: { zh: "德岛县", hant: "德島縣" },
  kagawa: { zh: "香川县", hant: "香川縣" },
  ehime: { zh: "爱媛县", hant: "愛媛縣" },
  kochi: { zh: "高知县", hant: "高知縣" },
  fukuoka: { zh: "福冈县", hant: "福岡縣" },
  saga: { zh: "佐贺县", hant: "佐賀縣" },
  nagasaki: { zh: "长崎县", hant: "長崎縣" },
  kumamoto: { zh: "熊本县", hant: "熊本縣" },
  oita: { zh: "大分县", hant: "大分縣" },
  miyazaki: { zh: "宫崎县", hant: "宮崎縣" },
  kagoshima: { zh: "鹿儿岛县", hant: "鹿兒島縣" },
  okinawa: { zh: "冲绳县", hant: "沖繩縣" },
};

/** Countries a credited person's home town most often names. */
const COUNTRIES: Record<string, { zh: string; hant: string }> = {
  japan: { zh: "日本", hant: "日本" },
  china: { zh: "中国", hant: "中國" },
  "south korea": { zh: "韩国", hant: "韓國" },
  korea: { zh: "韩国", hant: "韓國" },
  taiwan: { zh: "台湾", hant: "臺灣" },
  "hong kong": { zh: "香港", hant: "香港" },
  "united states": { zh: "美国", hant: "美國" },
  usa: { zh: "美国", hant: "美國" },
};

/**
 * Lower-case, accents off, and the long vowels AniList spells three ways
 * (Hyōgo, Hyougo, Hyogo; Ōita, Ooita, Oita) folded to one.
 */
function romajiKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(prefecture|metropolis|city|ken|to|fu)\b/g, "")
    .replace(/ou/g, "o")
    .replace(/oo/g, "o")
    .trim();
}

/**
 * A home town for a Chinese page: the Japanese prefecture, else the country,
 * in Chinese; as AniList wrote it when neither is recognised. English keeps
 * AniList's text.
 */
export function homeTownLabel(homeTown: string | null | undefined, lang: Lang): string | null {
  const raw = homeTown?.trim();
  if (!raw) return null;
  if (lang === "en") return raw;
  const script = lang === "zh-Hant" ? "hant" : "zh";
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const pref = PREFECTURES[romajiKey(parts[i])];
    if (pref) return pref[script];
  }
  const country = COUNTRIES[parts[parts.length - 1]?.toLowerCase() ?? ""];
  return country ? country[script] : raw;
}
