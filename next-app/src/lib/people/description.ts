// Which description a character page shows, and in which language.
//
// The API answers two (go-api internal/people): AniList's, in the profile,
// and Bangumi's summary (0048), beside it. Both are in AniList's markup --
// the import rewrote Bangumi's BBCode into it -- so one renderer
// (SpoilerDescription) shows either. A Chinese page reads Bangumi's first,
// as the approved design does, and an English page AniList's; each falls
// back to the other. An accepted reader edit to the description is already
// AniList's then, and Bangumi's is null, so the edit shows in every
// language.

import type { Lang } from "@/lib/i18n/lang";
import { parseAnilistMarkdown } from "./anilistMarkdown";
import type { Character } from "./types";

export type DescriptionLanguage = "ja" | "zh" | "en";

export interface ShownDescription {
  /** In the page's description markup, for SpoilerDescription. */
  text: string;
  /** Bangumi's is credited under it, as the title's synopsis is. */
  source: "bangumi" | "anilist";
  /** The text's language: its `lang`, and so its font. */
  lang: DescriptionLanguage;
}

/**
 * What a description is mostly written in. Bangumi's summaries are Chinese
 * or Japanese, AniList's English: kana makes it Japanese, Han alone
 * Chinese, and more Latin letters than either -- an English description
 * with a name in Japanese -- English.
 */
export function descriptionLanguage(text: string): DescriptionLanguage {
  const kana = text.match(/[぀-ヿ]/g)?.length ?? 0;
  const han = text.match(/[㐀-鿿]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  if (latin > kana + han) return "en";
  if (kana > 0) return "ja";
  if (han > 0) return "zh";
  return "en";
}

/** The description the page shows a reader of `lang`, or null when it has none. */
export function characterDescription(
  character: Pick<Character, "profile" | "bangumiDescription">,
  lang: Lang,
): ShownDescription | null {
  const anilist = { text: character.profile?.description?.trim() ?? "", source: "anilist" as const };
  const bangumi = { text: character.bangumiDescription?.trim() ?? "", source: "bangumi" as const };
  for (const candidate of lang === "en" ? [anilist, bangumi] : [bangumi, anilist]) {
    // Parsed to know there is text: a description that is nothing but an
    // image or a link target leaves none.
    if (candidate.text && parseAnilistMarkdown(candidate.text).length > 0) {
      return { ...candidate, lang: descriptionLanguage(candidate.text) };
    }
  }
  return null;
}
