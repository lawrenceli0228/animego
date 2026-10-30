"use client";

// One row of the table view: a small cover, the title and its genres, then
// score (with popularity under it), format (with episodes or runtime) and
// status (with when it airs, or the season it aired in).

import { memo, type CSSProperties } from "react";
import FadeImage from "@/components/ui/FadeImage";
import Link from "@/components/ui/LocaleLink";
import { formatLabel, statusLabel } from "@/lib/contentLabels";
import { toneLadder } from "@/lib/home/tone";
import type { Lang } from "@/lib/i18n/lang";
import { formatSubLine, genreLabels, popularityText, statusSubLine } from "@/lib/seasonal/display";
import type { SeasonalItem } from "@/lib/seasonal/model";
import { Pills, Score } from "./CardBits";
import type { RankMark } from "./types";
import type { BrowseCopy } from "./useBrowseCopy";
import cards from "./cards.module.css";
import rows from "./rows.module.css";

const ROW_GENRES = 3;

interface TableRowProps {
  item: SeasonalItem;
  hidden: boolean;
  delayMs: number;
  nowMs: number;
  lang: Lang;
  copy: BrowseCopy;
  /** "2026 秋季" — what a finished show's status line says. */
  seasonYear: string;
  /**
   * The show's place in a ranking: a column of its number outside the row,
   * read before the title. On a phone the ranked row is AniList's compact
   * one — number, cover, title over a line of when and what, score. Pass a
   * stable object (the row is memoised).
   */
  rank?: RankMark;
}

function TableRow({ item, hidden, delayMs, nowMs, lang, copy, seasonYear, rank }: TableRowProps) {
  const tone = toneLadder(item.hue);
  const href = `/anime/${item.id}`;
  const rootStyle: CSSProperties = { color: tone.text, animationDelay: `${delayMs}ms` };
  const row = (
    <div
      className={rows.row}
      style={rank ? undefined : rootStyle}
      hidden={rank ? undefined : hidden}
      data-anime-card={rank ? undefined : true}
      data-id={rank ? undefined : item.id}
    >
      <Link
        href={href}
        prefetch={false}
        className={rows.rowCover}
        style={{ background: tone.fill }}
        tabIndex={-1}
        aria-hidden="true"
      >
        <FadeImage src={item.cover} alt="" width={48} height={64} className={rows.rowImg} />
      </Link>
      <div className={rows.rowMain}>
        <Link href={href} prefetch={false} className={rows.rowTitle}>
          {rank ? <span className={cards.srOnly}>{`${rank.label} `}</span> : null}
          {item.title}
        </Link>
        {rank ? <div className={rows.rowSub}>{rank.sub}</div> : null}
        <Pills
          labels={genreLabels(item, lang, ROW_GENRES)}
          tone={tone.text}
          onTone={tone.onSolid}
          small
          inline
          className={rows.rowPills}
        />
      </div>
      <div className={rows.col} data-col="score">
        <div className={rows.colMain}>
          <Score score={item.score} placeholder="—" />
        </div>
        <div className={rows.colSub}>{popularityText(item.popularity, copy, lang)}</div>
      </div>
      <div className={rows.col} data-col="format">
        <div className={rows.colMain}>{item.format ? formatLabel(item.format, lang) : "—"}</div>
        <div className={rows.colSub}>{formatSubLine(item, copy)}</div>
      </div>
      <div className={rows.col} data-col="status">
        <div className={rows.colMain}>{item.status ? statusLabel(item.status, lang) : "—"}</div>
        <div className={rows.colSub}>{statusSubLine(item, nowMs, copy, lang, seasonYear)}</div>
      </div>
    </div>
  );
  if (!rank) return row;
  return (
    <div className={rows.ranked} style={rootStyle} hidden={hidden} data-anime-card data-id={item.id}>
      <span className={rows.rankNum} aria-hidden="true" data-rank={rank.n}>
        <i>#</i>
        {rank.n}
      </span>
      {row}
    </div>
  );
}

export default memo(TableRow);
