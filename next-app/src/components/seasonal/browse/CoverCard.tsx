"use client";

// One cover in the grid: the poster with its badge and follow button, the
// title, and — on a desktop — the AniList-style popover beside it.
//
// The title is the card's one accessible link; the cover repeats it for the
// pointer and is hidden from assistive tech, and the popover only repeats what
// the detail page says, so it is aria-hidden too. On a phone the popover gives
// way to one airing line under the title.

import { memo, type CSSProperties } from "react";
import FadeImage from "@/components/ui/FadeImage";
import Link from "@/components/ui/LocaleLink";
import { oklchCss, toneLadder } from "@/lib/home/tone";
import type { Lang } from "@/lib/i18n/lang";
import type { BarMode } from "@/lib/seasonal/bars";
import type { ZoneOffset } from "@/lib/seasonal/clock";
import {
  airingText,
  bangumiScoreText,
  coverBadge,
  genreLabels,
  infoLine,
} from "@/lib/seasonal/display";
import type { SeasonalItem } from "@/lib/seasonal/model";
import type { BrowseState } from "@/lib/seasonal/state";
import { Pills, Score } from "./CardBits";
import type { BrowseCopy } from "./useBrowseCopy";
import type { FollowSlot } from "./types";
import cards from "./cards.module.css";

/** The popover lists this many genres. */
const POP_GENRES = 3;

interface CoverCardProps {
  item: SeasonalItem;
  hidden: boolean;
  delayMs: number;
  nowMs: number;
  zone: ZoneOffset;
  state: BrowseState;
  mode: BarMode;
  lang: Lang;
  copy: BrowseCopy;
  Follow: FollowSlot;
  /** The first cover is the page's largest paint; load it at once. */
  priority: boolean;
}

function CoverCard({ item, hidden, delayMs, nowMs, zone, state, mode, lang, copy, Follow, priority }: CoverCardProps) {
  const tone = toneLadder(item.hue);
  const pop = oklchCss(21, 0.02, item.hue);
  const href = `/anime/${item.id}`;
  const badge = coverBadge(item, nowMs, state, mode, copy, lang, zone);
  const isNew = badge?.kind === "new";
  const bangumi = bangumiScoreText(item.bangumi);

  const rootStyle: CSSProperties = { color: tone.text, animationDelay: `${delayMs}ms` };

  return (
    <div className={cards.card} style={rootStyle} hidden={hidden} data-anime-card data-id={item.id}>
      <div className={cards.cwrap}>
        <Link
          href={href}
          prefetch={false}
          className={cards.cover}
          style={{ background: tone.fill }}
          tabIndex={-1}
          aria-hidden="true"
        >
          <span className={cards.art}>
            <FadeImage src={item.cover} alt="" width={190} height={272} className={cards.coverImg} priority={priority} />
          </span>
        </Link>
        {badge ? (
          <span
            className={cards.live}
            data-badge={badge.kind}
            style={isNew ? { background: tone.text, color: tone.onSolid } : undefined}
          >
            <i className={cards.liveDot} style={{ color: isNew ? tone.onSolid : tone.text }} />
            {badge.text}
          </span>
        ) : null}
        <Follow anilistId={item.id} title={item.title} variant="cover" />
      </div>
      <Link href={href} prefetch={false} className={cards.title}>
        {item.title}
      </Link>
      <span className={cards.air}>{airingText(item, nowMs, copy, lang, "short")}</span>
      <div className={cards.pop} style={{ background: pop }} aria-hidden="true" data-popover>
        <i className={cards.arrow} style={{ color: pop }} />
        <div className={cards.popHead}>
          <div className={cards.popAir}>{airingText(item, nowMs, copy, lang)}</div>
          <Score score={item.score} />
        </div>
        {item.studio ? (
          <div className={cards.popStudio} style={{ color: tone.text }} data-studio>
            {item.studio}
          </div>
        ) : null}
        <div className={cards.popInfo}>{infoLine(item, copy, lang)}</div>
        {bangumi ? (
          <div className={cards.popBgm}>
            Bangumi<b>{bangumi}</b>
          </div>
        ) : null}
        <Pills labels={genreLabels(item, lang, POP_GENRES)} tone={tone.text} onTone={tone.onSolid} />
      </div>
    </div>
  );
}

export default memo(CoverCard);
