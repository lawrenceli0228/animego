"use client";

// The ranking's filters: the format chips, the genre picker and — on a year's
// page — the season chips. Every option is a real link to the narrowed
// ranking; the current one is marked and goes nowhere. The genre menu is a
// dropdown on a desktop and a panel of chips under the row on a phone, where
// the row itself scrolls sideways.

import type { MouseEvent, ReactNode } from "react";
import { ChevronIcon } from "@/components/seasonal/browse/icons";
import Link from "@/components/ui/LocaleLink";
import { formatLabel, genreLabel, seasonLabel } from "@/lib/contentLabels";
import type { Lang } from "@/lib/i18n/lang";
import type { Layout } from "@/lib/seasonal/batch";
import { TOP_FORMATS, TOP_GENRES, TOP_SEASONS, topHref, type TopState } from "@/lib/top/query";
import type { TopCopy } from "./useTopCopy";
import top from "./top.module.css";

interface FilterRowProps {
  /** What the header shows: the page's ranking, or the one on its way. */
  shown: TopState;
  /** The page's own ranking: its options are marked current. */
  page: TopState;
  genreOpen: boolean;
  onGenre: () => void;
  onGo: (next: TopState) => void;
  layout: Layout;
  lang: Lang;
  copy: TopCopy;
}

const plainClick = (e: MouseEvent) => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0);

/** Same filters (the view aside). */
function sameRanking(a: TopState, b: TopState): boolean {
  return a.year === b.year && a.format === b.format && a.genre === b.genre && a.season === b.season;
}

export default function FilterRow({ shown, page, genreOpen, onGenre, onGo, layout, lang, copy }: FilterRowProps) {
  /** One option: a link to `target`, lit when the header shows it, current when the page is it. */
  const option = (key: string, target: TopState, on: boolean, label: ReactNode, className: string) => {
    const isPage = sameRanking(target, page);
    return (
      <Link
        key={key}
        href={topHref(target)}
        prefetch={false}
        className={className}
        aria-current={isPage ? "page" : undefined}
        data-on={on ? "true" : "false"}
        data-option={key}
        onClick={(e) => {
          if (isPage && on && plainClick(e)) e.preventDefault();
        }}
        onNavigate={() => onGo(target)}
      >
        {label}
      </Link>
    );
  };

  const genreOptions = (className: string) => [
    option("genre:all", { ...shown, genre: null }, shown.genre === null, copy.all, className),
    ...TOP_GENRES.map((g) =>
      option(`genre:${g}`, { ...shown, genre: g }, shown.genre === g, genreLabel(g, lang), className),
    ),
  ];

  return (
    <>
      <div className={top.filters} role="group" aria-label={copy.filters} data-top-filters>
        <div className={top.chips} role="group" aria-label={copy.formats}>
          {option("format:all", { ...shown, format: null }, shown.format === null, copy.all, top.chip)}
          {TOP_FORMATS.map((f) =>
            option(`format:${f}`, { ...shown, format: f }, shown.format === f, formatLabel(f, lang), top.chip),
          )}
        </div>
        <i className={top.sep} aria-hidden="true" />
        <div className={top.pickWrap} data-menu="genre">
          <button
            type="button"
            className={top.pick}
            aria-expanded={genreOpen}
            aria-controls="top-genres"
            data-on={shown.genre ? "true" : "false"}
            data-genre-picker
            onClick={onGenre}
          >
            {shown.genre ? genreLabel(shown.genre, lang) : copy.genre}
            <ChevronIcon className={top.pickChev} />
          </button>
          {layout === "desktop" ? (
            <div id="top-genres" className={top.genreMenu} role="group" aria-label={copy.genre} hidden={!genreOpen} data-genre-menu>
              {genreOptions(top.menuOpt)}
            </div>
          ) : null}
        </div>
        {shown.year !== null ? (
          <>
            <i className={top.sep} aria-hidden="true" />
            <div className={top.chips} role="group" aria-label={copy.seasons}>
              {option("season:all", { ...shown, season: null }, shown.season === null, copy.wholeYear, top.chip)}
              {TOP_SEASONS.map((s) =>
                option(`season:${s}`, { ...shown, season: s }, shown.season === s, seasonLabel(s, lang), top.chip),
              )}
            </div>
          </>
        ) : null}
      </div>
      {layout === "phone" ? (
        <div id="top-genres" className={top.genrePanel} role="group" aria-label={copy.genre} hidden={!genreOpen} data-genre-menu data-menu="genre">
          {genreOptions(top.chip)}
        </div>
      ) : null}
    </>
  );
}
