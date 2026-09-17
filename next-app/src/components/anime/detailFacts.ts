// What the detail page shows of the phase-2 data — the 0036 scalars and the
// 0038 tags — and the rules for showing it. Pure, no React: the page renders
// these, the JSON-LD reads the same slices, and the tests run them without
// either.
//
// Every list here is capped. The columns hold everything AniList said (a
// title can carry twenty synonyms and forty tags) and the page is not the
// place to print all of it; the rule, as with the people in detailPeople.ts,
// is that what the structured data claims is what the reader can see.

import type { Lang } from "@/lib/i18n/lang";
import type { AnimeDetail, DetailTag } from "@/lib/types";

export const DETAIL_SYNONYMS_SHOWN = 8;
export const DETAIL_TAGS_SHOWN = 14;

/**
 * AniList's tag rank is the share of users who agree the tag applies. Below
 * this the tag is one or two people's opinion, and a list that leads with
 * "Female Protagonist 92%" and trails off into "Time Skip 11%" reads worse
 * than one that stops.
 */
export const ANILIST_TAG_MIN_RANK = 30;

/**
 * The alternative titles worth a row: AniList's synonyms minus the titles
 * the page already prints (romaji, English, native, Chinese, Traditional)
 * and minus duplicates, case-insensitively — AniList lists "Frieren at the
 * Funeral" and "Frieren At The Funeral" as two synonyms often enough.
 *
 * Ordered by script before the cap, because AniList orders by code point,
 * which puts every Latin-script translation (Italian, Vietnamese, Polish…)
 * ahead of 海贼王 and ワンピース; One Piece's first eight synonyms are in
 * seven European languages and its Chinese name is eleventh. A Chinese
 * reader's row leads with Han, then kana, then Hangul, then Latin; an
 * English reader's leads with Latin. Within a script AniList's order holds.
 */
export function visibleSynonyms(detail: AnimeDetail, lang: Lang): string[] {
  const shown = new Set(
    [detail.titleRomaji, detail.titleEnglish, detail.titleNative, detail.titleChinese, detail.titleHant]
      .filter((t): t is string => Boolean(t))
      .map(norm),
  );
  const unique: string[] = [];
  for (const raw of detail.synonyms ?? []) {
    const s = raw.trim();
    if (!s) continue;
    const key = norm(s);
    if (shown.has(key)) continue;
    shown.add(key);
    unique.push(s);
  }
  const order = SCRIPT_ORDER[lang];
  return unique
    .map((s, i) => ({ s, i, rank: order.indexOf(scriptOf(s)) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .slice(0, DETAIL_SYNONYMS_SHOWN)
    .map((x) => x.s);
}

type Script = "han" | "kana" | "hangul" | "latin" | "other";

const SCRIPT_ORDER: Record<Lang, readonly Script[]> = {
  zh: ["han", "kana", "hangul", "latin", "other"],
  "zh-Hant": ["han", "kana", "hangul", "latin", "other"],
  en: ["latin", "han", "kana", "hangul", "other"],
};

/** The script of the first letter in the string; "other" when there is none. */
export function scriptOf(s: string): Script {
  for (const ch of s) {
    if (/\p{Script=Han}/u.test(ch)) return "han";
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) return "kana";
    if (/\p{Script=Hangul}/u.test(ch)) return "hangul";
    if (/\p{Script=Latin}/u.test(ch)) return "latin";
    if (/\p{L}/u.test(ch)) return "other";
  }
  return "other";
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The tags worth a row, in the order the page prints them.
 *
 * Bangumi's tags are Chinese and lead for the Chinese readers; AniList's are
 * English and lead for English readers. Within a source the order is by
 * rank — agreement for AniList, vote count for Bangumi — and a spoiler tag
 * never appears: it is the one kind of tag that can hurt the reader, and
 * the page has no reveal control to put behind it. Deduped across sources
 * by lowercase name so a title tagged "Isekai" by both is one chip.
 */
export function visibleTags(detail: AnimeDetail, lang: Lang): DetailTag[] {
  const tags = detail.tags ?? [];
  const bangumi = bySource(tags, "bangumi");
  const anilist = bySource(tags, "anilist").filter((t) => (t.rank ?? 0) >= ANILIST_TAG_MIN_RANK);
  const ordered = lang === "en" ? [...anilist, ...bangumi] : [...bangumi, ...anilist];
  const seen = new Set<string>();
  const out: DetailTag[] = [];
  for (const t of ordered) {
    const key = norm(t.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= DETAIL_TAGS_SHOWN) break;
  }
  return out;
}

function bySource(tags: DetailTag[], source: DetailTag["source"]): DetailTag[] {
  return tags
    .filter((t) => t.source === source && !t.isSpoiler && t.name.trim())
    .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
}

/**
 * The companies on the title that are not the animation studio — the
 * production committee, in AniList's data the studios with isMain=false.
 * Names only: they have no hub page (the studio hub lists main studios),
 * and most of them are one broadcaster or publisher on many titles.
 */
export function producers(detail: AnimeDetail): string[] {
  const main = new Set(detail.studios.map(norm));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of detail.studioDetails ?? []) {
    const key = norm(s.name);
    if (s.isMain || !key || main.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(s.name);
  }
  return out;
}
