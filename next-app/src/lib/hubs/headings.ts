// The <h1> of each hub page, in one place so a breadcrumb that points at a
// hub can call the page what the page calls itself. Each page's <title>,
// description and heading all derive from the same string; so does the
// crumb on every detail page that lists the hub as its parent.

import { genreLabel } from "@/lib/contentLabels";
import type { Lang } from "@/lib/i18n/lang";

const GENRE: Record<Lang, (label: string) => string> = {
  zh: (label) => `${label}番剧`,
  en: (label) => `${label} Anime`,
  "zh-Hant": (label) => `${label}番劇`,
};

const STUDIO: Record<Lang, (name: string) => string> = {
  zh: (name) => `${name} 制作的番剧`,
  en: (name) => `Anime by ${name}`,
  "zh-Hant": (name) => `${name} 製作的番劇`,
};

/** A year's page is its ranking; the ranking with no year is every year's. */
const TOP: Record<Lang, (year: number | null) => string> = {
  zh: (year) => (year === null ? "历代 Top 100" : `${year} 年度 Top 100`),
  en: (year) => (year === null ? "Top 100 Anime" : `Top 100 Anime of ${year}`),
  "zh-Hant": (year) => (year === null ? "歷代 Top 100" : `${year} 年度 Top 100`),
};

/** "动作番剧" / "Action Anime" — takes the raw AniList genre, not a label. */
export function genreHeading(genre: string, lang: Lang): string {
  return GENRE[lang](genreLabel(genre, lang));
}

export function studioHeading(name: string, lang: Lang): string {
  return STUDIO[lang](name);
}

/** "历代 Top 100" / "2024 年度 Top 100" — the ranking pages' heading. */
export function topHeading(year: number | null, lang: Lang): string {
  return TOP[lang](year);
}
