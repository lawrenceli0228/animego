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

const YEAR: Record<Lang, (year: number) => string> = {
  zh: (year) => `${year}年番剧`,
  en: (year) => `Anime of ${year}`,
  "zh-Hant": (year) => `${year}年番劇`,
};

/** "动作番剧" / "Action Anime" — takes the raw AniList genre, not a label. */
export function genreHeading(genre: string, lang: Lang): string {
  return GENRE[lang](genreLabel(genre, lang));
}

export function studioHeading(name: string, lang: Lang): string {
  return STUDIO[lang](name);
}

export function yearHeading(year: number, lang: Lang): string {
  return YEAR[lang](year);
}
