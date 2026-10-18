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
import type { BrowseCopy } from "./useBrowseCopy";
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
}

function TableRow({ item, hidden, delayMs, nowMs, lang, copy, seasonYear }: TableRowProps) {
  const tone = toneLadder(item.hue);
  const href = `/anime/${item.id}`;
  const rootStyle: CSSProperties = { color: tone.text, animationDelay: `${delayMs}ms` };

  return (
    <div className={rows.row} style={rootStyle} hidden={hidden} data-anime-card data-id={item.id}>
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
          {item.title}
        </Link>
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
}

export default memo(TableRow);
