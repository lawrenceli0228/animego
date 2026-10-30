// A ranking's <title>: its heading, then what narrows it — "2025 年度 Top 100 ·
// 秋季 · 剧场版 · 动作". The heading alone for the unfiltered page.
//
// Pure: no React, no DOM.

import { formatLabel, genreLabel, seasonLabel } from "@/lib/contentLabels";
import { topHeading } from "@/lib/hubs/headings";
import type { Lang } from "@/lib/i18n/lang";
import type { TopState } from "./query";

export function topTitle(state: Pick<TopState, "year" | "format" | "genre" | "season">, lang: Lang): string {
  const parts = [topHeading(state.year, lang)];
  if (state.year !== null && state.season) parts.push(seasonLabel(state.season, lang));
  if (state.format) parts.push(formatLabel(state.format, lang));
  if (state.genre) parts.push(genreLabel(state.genre, lang));
  return parts.join(" · ");
}
