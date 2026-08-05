"use client";

// Client leaf for the SeasonRankings meta line ("动作 · 冒险 · 12 话").
//
// SeasonRankings is a pure RSC and stays that way — its rows are static and
// its hover is CSS-only, so converting the whole grid to a client component
// to translate two genre words would be a bad trade. But its `lang` prop
// comes from getLang(), which is pinned to "zh" so pages stay ISR-cacheable;
// localising in place would therefore render Chinese genres for English
// readers, where the raw AniList value used to render.
//
// So the genre tokens — and only they — move into this leaf, which reads the
// real language via useLang() (SSR-seeded zh, reconciled from the `lang`
// cookie after mount). That is the same source the /search and /seasonal
// filter chips use, so a genre reads identically wherever it appears.
//
// The episode suffix is already localised server-side through `dict`, so it
// arrives here as a finished string and needs no second language lookup.

import type { CSSProperties } from "react";
import { genreLabel } from "@/lib/contentLabels";
import { useLang } from "@/lib/lang-client";

interface RankingMetaProps {
  /** Raw AniList genre enums, pre-sliced by the caller to the display count. */
  genres: readonly string[];
  /** Server-formatted episode suffix, e.g. " · 12 话". Empty when unknown. */
  epsSuffix: string;
  style?: CSSProperties;
}

export default function RankingMeta({
  genres,
  epsSuffix,
  style,
}: RankingMetaProps) {
  const { lang } = useLang();
  return (
    <div style={style}>
      {genres.map((g) => genreLabel(g, lang)).join(" · ")}
      {epsSuffix}
    </div>
  );
}
