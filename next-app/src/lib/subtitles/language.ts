// What language a subtitle track is in, and which track to show first.
//
// The evidence is uneven. Muxers write an ISO 639-2 code ("chi") that cannot
// tell 简体 from 繁體; fansub groups say which script it is in the track name
// ("简体中文", "CHT", "繁日双语"); a sidecar says it in its file name
// ("….sc.ass", "….chs.ass", "….[简体].ass"). So the script is read from the
// name first, then from a BCP 47 tag, and only then from the bare ISO code.

export type SubtitleLang = "zh-Hans" | "zh-Hant" | "zh" | "ja" | "en" | "ko";

export interface LanguageHints {
  /** Track name or file name — free text written by people. */
  name?: string | null;
  languageBcp47?: string | null;
  /** ISO 639-2 as Matroska stores it. */
  language?: string | null;
}

export interface LanguageGuess {
  lang: SubtitleLang | null;
  /** 简日双语 / 繁日雙語 / CHS&JPN — Chinese with the Japanese line kept. */
  bilingual: boolean;
}

// Short codes only count as whole tokens: "sc" inside "description" or "tc"
// inside "batch" must not make a file Chinese.
const TOKEN_SPLIT = /[\s._\-[\]()（）【】&+,/]+/;

const HANT_TOKENS = new Set(["cht", "tc", "big5", "zh-hant", "zhhant", "zh-tw", "zh-hk", "zh-mo", "tchinese", "trad", "traditional", "hant"]);
const HANS_TOKENS = new Set(["chs", "sc", "gb", "gb2312", "gbk", "zh-hans", "zhhans", "zh-cn", "zh-sg", "schinese", "simplified", "hans"]);
const JA_TOKENS = new Set(["jpn", "jp", "ja", "japanese"]);
const EN_TOKENS = new Set(["eng", "en", "english"]);
const KO_TOKENS = new Set(["kor", "ko", "korean"]);
const ZH_TOKENS = new Set(["chi", "zho", "zh", "chinese", "cn"]);

function tokens(text: string): string[] {
  const lower = text.toLowerCase();
  // Keep "zh-hans" style tags whole before splitting on '-'.
  const tags = lower.match(/zh[-_](hans|hant|cn|tw|hk|sg|mo)/g) ?? [];
  return [...tags.map((t) => t.replace("_", "-")), ...lower.split(TOKEN_SPLIT).filter(Boolean)];
}

function fromName(name: string): LanguageGuess {
  const text = name.trim();
  if (!text) return { lang: null, bilingual: false };
  const toks = tokens(text);
  const has = (set: Set<string>) => toks.some((t) => set.has(t));

  const hant = /繁|正體|正体/.test(text) || has(HANT_TOKENS);
  const hans = /简|簡/.test(text) || has(HANS_TOKENS);
  const ja = /日[语語文]?|日本/.test(text) || has(JA_TOKENS);
  const en = /英[语語文]?/.test(text) || has(EN_TOKENS);
  const ko = /韩|韓|한국/.test(text) || has(KO_TOKENS);
  const zh = /中[文字]|汉|漢|华|華/.test(text) || has(ZH_TOKENS);
  const bilingual = /双语|雙語|bilingual/i.test(text) || ((hans || hant || zh) && ja);

  // A name that names both scripts ("简繁") gives no single answer; fall
  // through to the language tags.
  if (hant && !hans) return { lang: "zh-Hant", bilingual };
  if (hans && !hant) return { lang: "zh-Hans", bilingual };
  if (zh && !(hans && hant)) return { lang: "zh", bilingual };
  if (ja && !hans && !hant && !zh) return { lang: "ja", bilingual: false };
  if (en) return { lang: "en", bilingual: false };
  if (ko) return { lang: "ko", bilingual: false };
  return { lang: null, bilingual };
}

function fromBcp47(tag: string): SubtitleLang | null {
  const t = tag.toLowerCase();
  if (/^zh(-.*)?-(hant|tw|hk|mo)\b/.test(t) || /^zh-(hant|tw|hk|mo)/.test(t)) return "zh-Hant";
  if (/^zh(-.*)?-(hans|cn|sg)\b/.test(t) || /^zh-(hans|cn|sg)/.test(t)) return "zh-Hans";
  if (/^(zh|cmn|yue)\b/.test(t)) return "zh";
  if (/^ja\b/.test(t)) return "ja";
  if (/^en\b/.test(t)) return "en";
  if (/^ko\b/.test(t)) return "ko";
  return null;
}

function fromIso(code: string): SubtitleLang | null {
  switch (code.toLowerCase()) {
    case "chi":
    case "zho":
      return "zh";
    case "jpn":
      return "ja";
    case "eng":
      return "en";
    case "kor":
      return "ko";
    default:
      return null;
  }
}

export function guessLanguage(h: LanguageHints): LanguageGuess {
  const named = fromName(h.name ?? "");
  // A name that only says "Chinese" defers to a tag that knows the script.
  if (named.lang && named.lang !== "zh") return named;
  const tagged = (h.languageBcp47 && fromBcp47(h.languageBcp47)) || null;
  if (tagged && (tagged !== "zh" || !named.lang)) return { lang: tagged, bilingual: named.bilingual };
  if (named.lang) return named;
  const iso = (h.language && fromIso(h.language)) || null;
  return { lang: iso, bilingual: named.bilingual };
}

/** The script a reader of this site's language most likely wants. */
export function uiSubtitleLang(uiLang: string): SubtitleLang {
  if (uiLang === "zh-Hant") return "zh-Hant";
  if (uiLang === "en") return "en";
  return "zh-Hans";
}

// ─── Default track ─────────────────────────────────────────────────────────

export interface SelectableTrack {
  id: string;
  lang: SubtitleLang | null;
  supported: boolean;
  isDefault: boolean;
  isForced: boolean;
  /** "ass" tracks carry styling; preferred over plain text at equal rank. */
  styled: boolean;
  source: "embedded" | "sidecar" | "user";
}

/** A reader's standing choice: a language, or subtitles off. */
export type SubtitlePreference = SubtitleLang | "off" | null;

function langRank(lang: SubtitleLang | null, want: SubtitleLang): number {
  if (!lang) return 0;
  if (lang === want) return 4;
  const wantZh = want.startsWith("zh");
  if (wantZh && lang === "zh") return 3;
  if (wantZh && lang.startsWith("zh")) return 2;
  return 0;
}

/**
 * Which track an episode starts on.
 *
 * In order: the reader's last explicit choice (a language, or "off"), then
 * the site language — the exact script first, then any Chinese for a
 * Chinese-reading audience — then the file's own default flag. Forced tracks
 * (signs-only, "Signs & Songs") are never chosen while a full track exists.
 * At equal rank: the file's default flag, then styled ASS, then a sidecar the
 * reader put next to the video, then the order the tracks came in.
 */
export function pickDefaultTrack(
  tracks: SelectableTrack[],
  pref: SubtitlePreference,
  uiLang: string,
): string | null {
  if (pref === "off") return null;
  const usable = tracks.filter((t) => t.supported);
  if (!usable.length) return null;
  const full = usable.filter((t) => !t.isForced);
  const pool = full.length ? full : usable;

  const wants: SubtitleLang[] = [];
  if (pref) wants.push(pref);
  const ui = uiSubtitleLang(uiLang);
  if (!wants.includes(ui)) wants.push(ui);

  const tieBreak = (a: SelectableTrack, b: SelectableTrack) =>
    Number(b.isDefault) - Number(a.isDefault) ||
    Number(b.styled) - Number(a.styled) ||
    Number(b.source === "sidecar") - Number(a.source === "sidecar") ||
    pool.indexOf(a) - pool.indexOf(b);

  for (const want of wants) {
    let best: SelectableTrack | null = null;
    let bestRank = 0;
    for (const t of pool) {
      const r = langRank(t.lang, want);
      if (r > bestRank || (r === bestRank && r > 0 && best && tieBreak(t, best) < 0)) {
        best = t;
        bestRank = r;
      }
    }
    if (best) return best.id;
  }

  return [...pool].sort(tieBreak)[0]?.id ?? null;
}
