// The <h1> and the <title> of /search, in three languages.
//
// Split out of page.tsx because two things now need it at once: the page's
// generateMetadata, which runs on the server, and SearchExperience, which
// repaints the heading in the browser as the reader types. One copy so the
// tab title and the heading cannot describe different searches.

import { genreLabel } from "@/lib/contentLabels";
import type { Dict } from "@/lib/i18n";
import type { Lang } from "@/lib/i18n/lang";

// Local Records of functions rather than dictionary keys with a placeholder,
// because the value sits in a different place in each language — Chinese puts
// the genre BEFORE its noun and quotes the query with its own punctuation,
// English puts both after a preposition. A single template with {{q}} in it
// cannot say that.
const QUERY_HEADING: Record<Lang, (q: string) => string> = {
  zh: (q) => `搜索"${q}"的动画结果`,
  en: (q) => `Search results for "${q}"`,
  "zh-Hant": (q) => `搜尋"${q}"的動畫結果`,
};

const GENRE_HEADING: Record<Lang, (label: string) => string> = {
  zh: (label) => `${label}类型的动画`,
  en: (label) => `${label} anime`,
  "zh-Hant": (label) => `${label}類型的動畫`,
};

export const META_DESCRIPTION: Record<Lang, (subject: string) => string> = {
  zh: (subject) => `AnimeGoClub 搜索结果: ${subject}`,
  en: (subject) => `AnimeGoClub search results for ${subject}`,
  "zh-Hant": (subject) => `AnimeGoClub 搜尋結果: ${subject}`,
};

/**
 * The heading for a query, mirroring legacy SearchPage.jsx:25-29 so the SSR
 * text matches the SPA exactly. Crawler bots and accessibility tools key off
 * this <h1>, so it stays in sync with the active query.
 */
export function buildHeading(
  q: string,
  genre: string,
  dict: Dict,
  lang: Lang,
): string {
  if (q) {
    return QUERY_HEADING[lang](q);
  }
  if (genre) {
    // zh used to render the raw enum ("Action 类型的动画"). genreLabel is the
    // identity for en, so the English heading is unchanged; the zh heading
    // drops the space because Chinese does not separate the two words.
    return GENRE_HEADING[lang](genreLabel(genre, lang));
  }
  return dict.search.title;
}
