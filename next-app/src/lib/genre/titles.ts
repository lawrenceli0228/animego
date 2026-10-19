// What a genre page calls its slices, in each language.
//
// Tables rather than dictionary keys, like lib/hubs/headings.ts: the server
// writes these into the <title> and the client into the headings, and both
// must say the same thing for the same URL. A table read by both sides cannot
// drift the way a key held in two dictionaries can.
//
// Pure: no React, no DOM.

import { genreLabel } from "@/lib/contentLabels";
import { genreHeading } from "@/lib/hubs/headings";
import type { Lang } from "@/lib/i18n/lang";
import type { DecadeKey, GridView, ListKey } from "./views";

const LIST_LABEL: Record<Lang, Record<ListKey, string>> = {
  zh: { airing: "正在连载", popular: "人气最高", recent: "近年新作", classic: "经典老番", top: "评分排行" },
  en: { airing: "Airing now", popular: "Most popular", recent: "Recent", classic: "Classics", top: "Top rated" },
  "zh-Hant": { airing: "正在連載", popular: "人氣最高", recent: "近年新作", classic: "經典老番", top: "評分排行" },
};

/** A decade as a tile names it: "2020 年代", and "更早" for everything before 1970. */
const DECADE_TILE: Record<Lang, (decade: DecadeKey) => string> = {
  zh: (d) => (d === "old" ? "更早" : `${d} 年代`),
  en: (d) => (d === "old" ? "Before 1970" : `${d}s`),
  "zh-Hant": (d) => (d === "old" ? "更早" : `${d} 年代`),
};

/** A decade as a heading names it, where "earlier" alone would not say earlier than what. */
const DECADE_TITLE: Record<Lang, (decade: DecadeKey) => string> = {
  zh: (d) => (d === "old" ? "1970 年以前" : `${d} 年代`),
  en: (d) => (d === "old" ? "Before 1970" : `${d}s`),
  "zh-Hant": (d) => (d === "old" ? "1970 年以前" : `${d} 年代`),
};

/** "正在连载" / "Airing now". */
export function listLabel(list: ListKey, lang: Lang): string {
  return LIST_LABEL[lang][list];
}

/** "2020 年代" / "2020s"; "更早" / "Before 1970". */
export function decadeTileLabel(decade: DecadeKey, lang: Lang): string {
  return DECADE_TILE[lang](decade);
}

/** "1990 年代" / "1990s"; "1970 年以前" / "Before 1970". */
export function decadeTitleLabel(decade: DecadeKey, lang: Lang): string {
  return DECADE_TITLE[lang](decade);
}

/** The ghost numeral a tile with no cover shows: "20", "<70". */
export function decadeGhost(decade: DecadeKey): string {
  return decade === "old" ? "<70" : decade.slice(2);
}

/** What the view adds to the genre's name: "正在连载", "1990 年代", "奇幻". */
export function gridViewLabel(view: GridView, lang: Lang): string {
  if (view.kind === "list") return listLabel(view.list, lang);
  if (view.kind === "decade") return decadeTitleLabel(view.decade, lang);
  return genreLabel(view.with, lang);
}

/**
 * The grid's <h1>: "动作 · 正在连载", "动作 · 1990 年代", "动作 × 奇幻".
 * Two genres are joined with ×, a genre and a slice of it with ·.
 */
export function gridHeading(genre: string, view: GridView, lang: Lang): string {
  const sep = view.kind === "with" ? " × " : " · ";
  return `${genreLabel(genre, lang)}${sep}${gridViewLabel(view, lang)}`;
}

/** The grid's <title>: "动作番剧 · 正在连载", "动作番剧 × 奇幻", and " · 3" past the first page. */
export function gridMetaTitle(genre: string, view: GridView, page: number, lang: Lang): string {
  const sep = view.kind === "with" ? " × " : " · ";
  const base = `${genreHeading(genre, lang)}${sep}${gridViewLabel(view, lang)}`;
  return page > 1 ? `${base} · ${page}` : base;
}
