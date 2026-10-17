"use client";

// One chart card (AniList's "chart" view): the cover with the title over it,
// then the countdown, the meta line, the synopsis, and a footer of genre pills
// and the follow button. The cover is the card's link and carries the title
// as its text.

import { memo, type CSSProperties } from "react";
import FadeImage from "@/components/ui/FadeImage";
import Link from "@/components/ui/LocaleLink";
import { oklchCss, toneLadder } from "@/lib/home/tone";
import type { Lang } from "@/lib/i18n/lang";
import { countdown, genreLabels, metaLine } from "@/lib/seasonal/display";
import type { SeasonalItem } from "@/lib/seasonal/model";
import { Pills, Score } from "./CardBits";
import type { BrowseCopy } from "./useBrowseCopy";
import type { FollowSlot } from "./types";
import chart from "./chart.module.css";

/** Three pills fit the desktop footer; the phone's stylesheet keeps two. */
const FOOT_GENRES = 3;

interface ChartCardProps {
  item: SeasonalItem;
  hidden: boolean;
  delayMs: number;
  nowMs: number;
  lang: Lang;
  copy: BrowseCopy;
  Follow: FollowSlot;
}

function ChartCard({ item, hidden, delayMs, nowMs, lang, copy, Follow }: ChartCardProps) {
  const tone = toneLadder(item.hue);
  const cd = countdown(item, nowMs, copy, lang);
  const rootStyle: CSSProperties = {
    background: oklchCss(21, 0.02, item.hue),
    color: tone.text,
    animationDelay: `${delayMs}ms`,
  };

  return (
    <div className={chart.chart} style={rootStyle} hidden={hidden} data-anime-card data-id={item.id}>
      <Link href={`/anime/${item.id}`} prefetch={false} className={chart.chCover} style={{ background: tone.fill }}>
        <FadeImage src={item.cover} alt="" width={190} height={272} className={chart.chImg} />
        <div className={chart.chOverlay}>
          <div className={chart.chTitle}>{item.title}</div>
          {item.studio ? (
            <div className={chart.chStudio} data-studio>
              {item.studio}
            </div>
          ) : null}
        </div>
      </Link>
      <div className={chart.chData}>
        <div className={chart.chBody}>
          <div className={chart.chHead}>
            <div>
              <div className={chart.chKey}>{cd.label}</div>
              <div className={chart.chValue}>{cd.value}</div>
            </div>
            <Score score={item.score} inChart />
          </div>
          <div className={chart.chMeta} data-meta>
            {metaLine(item, copy, lang)}
          </div>
          <div className={chart.chDesc}>{item.synopsis || copy.noSynopsis}</div>
        </div>
        <div className={chart.chFoot}>
          <Pills
            labels={genreLabels(item, lang, FOOT_GENRES)}
            tone={tone.text}
            onTone={tone.onSolid}
            small
            inline
            twoOnPhone
          />
          <Follow anilistId={item.id} title={item.title} variant="chart" />
        </div>
      </div>
    </div>
  );
}

export default memo(ChartCard);
