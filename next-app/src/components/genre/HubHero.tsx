"use client";

// The hub's heading — "动作番剧" and "5,241 部 · 84 部连载中" — and the strip
// of every genre under it.
//
// While another genre's hub is on its way the heading already names it (and
// says no count until that page has one), and the strip's block is already
// under it.

import type { FilterGenre } from "@/lib/contentLabels";
import type { StripEntry } from "@/lib/genre/strip";
import { genreHeading } from "@/lib/hubs/headings";
import type { Lang } from "@/lib/i18n/lang";
import GenreStrip from "./GenreStrip";
import type { GenreCopy } from "./useGenreCopy";
import hero from "./hero.module.css";

interface HubHeroProps {
  /** The page's own genre: the strip's current link. */
  genre: FilterGenre;
  /** The genre the heading names: the page's, or one pressed whose hub is loading. */
  shown: FilterGenre;
  /** "" when there is no count to show. */
  countLine: string;
  strip: readonly StripEntry[];
  onPick: (genre: FilterGenre) => void;
  lang: Lang;
  copy: GenreCopy;
}

export default function HubHero({ genre, shown, countLine, strip, onPick, lang, copy }: HubHeroProps) {
  return (
    <div className={hero.hero}>
      <div className={hero.h1row}>
        <h1 className={hero.h1}>{genreHeading(shown, lang)}</h1>
        {countLine ? (
          <span className={hero.count} data-count>
            {countLine}
          </span>
        ) : null}
      </div>
      <GenreStrip
        genre={genre}
        entries={strip}
        pendingGenre={shown === genre ? null : shown}
        onPick={onPick}
        lang={lang}
        copy={copy}
      />
    </div>
  );
}
