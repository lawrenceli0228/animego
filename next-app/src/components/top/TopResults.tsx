"use client";

// A ranking's shows in the chosen view, and "show more" under them.
//
// The whole ranking is rendered — every show a real link in the server's HTML,
// in order — and the ones past the revealed batches carry `hidden`. "Show
// more" reveals the next batch; so does the reader scrolling near it by hand,
// and only by hand (see MoreButton). Nothing is fetched: all of it is here.

import { useCallback, useEffect, useMemo, useRef } from "react";
import ChartCard from "@/components/seasonal/browse/ChartCard";
import CoverCard from "@/components/seasonal/browse/CoverCard";
import TableRow from "@/components/seasonal/browse/TableRow";
import { ChevronIcon } from "@/components/seasonal/browse/icons";
import type { FollowSlot, RankMark } from "@/components/seasonal/browse/types";
import type { BrowseCopy } from "@/components/seasonal/browse/useBrowseCopy";
import cards from "@/components/seasonal/browse/cards.module.css";
import chart from "@/components/seasonal/browse/chart.module.css";
import rows from "@/components/seasonal/browse/rows.module.css";
import states from "@/components/seasonal/browse/states.module.css";
import Link from "@/components/ui/LocaleLink";
import { formatLabel, seasonLabel } from "@/lib/contentLabels";
import { genreAiringText, yearSeasonText, type GenreCardCopy } from "@/lib/genre/display";
import { fillTemplate } from "@/lib/home/time";
import type { Lang } from "@/lib/i18n/lang";
import type { Layout } from "@/lib/seasonal/batch";
import type { ZoneOffset } from "@/lib/seasonal/clock";
import { infoLine, type AiringVariant } from "@/lib/seasonal/display";
import type { SeasonalItem } from "@/lib/seasonal/model";
import { DEFAULT_STATE, type ViewKey } from "@/lib/seasonal/state";
import { shownCount, topBatchSize, topStaggerMs } from "@/lib/top/batch";
import type { TopItem } from "@/lib/top/items";
import type { TopCopy } from "./useTopCopy";
import top from "./top.module.css";

/** How close (px) "show more" has to come to the viewport before it reveals on its own — the seasonal page's. */
const AUTO_REVEAL_MARGIN_PX = 240;
/** No automatic reveal before the reader has scrolled at all: a tall screen would otherwise unroll the ranking. */
const AUTO_REVEAL_MIN_SCROLL_PX = 40;
/** The keys that scroll a page down: with a wheel and a finger, how a reader scrolls by hand. */
const SCROLL_KEYS = new Set([" ", "PageDown", "ArrowDown", "End"]);

export interface ResultsEnv {
  nowMs: number;
  zone: ZoneOffset;
  lang: Lang;
  layout: Layout;
  copy: TopCopy;
  browse: BrowseCopy;
  card: GenreCardCopy;
  Follow: FollowSlot;
}

interface TopResultsProps {
  items: readonly TopItem[];
  /** The view as the layout draws it (effectiveTopView). */
  view: ViewKey;
  pages: number;
  onMore: () => void;
  /** A year's page: a phone cover's line names the season rather than the year. */
  isYear: boolean;
  /** Where "clear filters" goes, when the ranking is filtered; null when it is not. */
  clearHref: string | null;
  onClear: () => void;
  env: ResultsEnv;
}

/** What each card says about its show's place. */
function rankMark(item: TopItem, isYear: boolean, env: ResultsEnv): RankMark {
  const { lang, copy, card } = env;
  const when = yearSeasonText(item, card, lang);
  const info = infoLine(item, card, lang);
  const meta = isYear
    ? item.season
      ? seasonLabel(item.season, lang)
      : item.format
        ? formatLabel(item.format, lang)
        : ""
    : item.year === null
      ? ""
      : String(item.year);
  return {
    n: item.place,
    label: fillTemplate(copy.rank, { n: item.place }),
    meta,
    when,
    info,
    sub: [when, info].filter(Boolean).join(" · "),
  };
}

export default function TopResults({ items, view, pages, onMore, isYear, clearHref, onClear, env }: TopResultsProps) {
  const { nowMs, zone, lang, layout, copy, browse, card, Follow } = env;
  const listRef = useRef<HTMLDivElement | null>(null);
  const focusAfter = useRef<number | null>(null);

  const marks = useMemo(
    () => new Map(items.map((item) => [item.id, rankMark(item, isYear, env)])),
    // env's strings and language are what a mark reads; its clock is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, isYear, env.lang, env.copy, env.card],
  );
  const airing = useCallback(
    (item: SeasonalItem, now: number, variant: AiringVariant) => genreAiringText(item, now, card, lang, variant),
    [card, lang],
  );

  const batch = topBatchSize(view, layout);
  const shown = shownCount(items.length, pages, batch);
  const left = items.length - shown;

  const press = useCallback(() => {
    const active = document.activeElement;
    focusAfter.current = active instanceof HTMLElement && active.matches("[data-load-more]") ? shown : null;
    onMore();
  }, [onMore, shown]);

  // A pressed "show more" leaves with the batch it revealed (or for good, after
  // the last): focus goes on to the first new title, for a reader still on it.
  useEffect(() => {
    const first = focusAfter.current;
    if (first === null) return;
    focusAfter.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && !active.matches("[data-load-more]")) return;
    const cardEl = listRef.current?.querySelectorAll("[data-anime-card]")[first];
    cardEl?.querySelector<HTMLElement>('a:not([tabindex="-1"])')?.focus({ preventScroll: true });
  }, [shown]);

  if (items.length === 0) {
    return (
      <div className={cards.results} data-results data-view={view}>
        <div className={states.empty} data-empty>
          {copy.empty}
          {clearHref ? (
            <Link href={clearHref} prefetch={false} className={`${states.emptyBtn} ${top.emptyLink}`} onNavigate={onClear}>
              {copy.clearFilters}
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  let list;
  if (view === "chart") {
    list = (
      <div ref={listRef} className={chart.charts} data-charts>
        {items.map((item, i) => (
          <ChartCard
            key={item.id}
            item={item}
            hidden={i >= shown}
            delayMs={topStaggerMs(i, view, layout)}
            nowMs={nowMs}
            lang={lang}
            copy={browse}
            Follow={Follow}
            priority={i === 0}
            rank={marks.get(item.id)}
          />
        ))}
      </div>
    );
  } else if (view === "table") {
    list = (
      <div ref={listRef} className={rows.rows} data-rows>
        {items.map((item, i) => (
          <TableRow
            key={item.id}
            item={item}
            hidden={i >= shown}
            delayMs={topStaggerMs(i, view, layout)}
            nowMs={nowMs}
            lang={lang}
            copy={browse}
            seasonYear={marks.get(item.id)?.when ?? ""}
            rank={marks.get(item.id)}
          />
        ))}
      </div>
    );
  } else {
    list = (
      <div ref={listRef} className={cards.grid5} data-grid>
        {items.map((item, i) => (
          <CoverCard
            key={item.id}
            item={item}
            hidden={i >= shown}
            delayMs={topStaggerMs(i, view, layout)}
            nowMs={nowMs}
            zone={zone}
            state={DEFAULT_STATE}
            mode="weekday"
            lang={lang}
            copy={browse}
            Follow={Follow}
            priority={i === 0}
            airing={airing}
            rank={marks.get(item.id)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={cards.results} data-results data-view={view}>
      {list}
      {left > 0 ? (
        <div className={states.moreZone}>
          <MoreButton left={left} onMore={press} copy={copy} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * "显示更多 · 还有 N 部". A press reveals the next batch; so does the reader
 * bringing it within AUTO_REVEAL_MARGIN_PX of the viewport by their own
 * scrolling — a wheel, a finger, a scrolling key. Re-armed after every reveal
 * (`left` changes), and every arming waits for the reader's hand again: a
 * browser moves the viewport by itself too (WebKit holds it against this
 * button while the batch above it comes in), and revealing on that would run
 * batch after batch in a row, carrying the reader down with them.
 */
function MoreButton({ left, onMore, copy }: { left: number; onMore: () => void; copy: TopCopy }) {
  const ref = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    let near = false;
    let fired = false;
    let byHand = false;
    const maybeReveal = () => {
      if (fired || !near || !byHand || window.scrollY < AUTO_REVEAL_MIN_SCROLL_PX) return;
      fired = true;
      onMore();
    };
    // A wheel or a finger at the foot of the page scrolls nothing — no scroll
    // event follows — and is the plainest asking for more there is.
    const onHand = () => {
      byHand = true;
      maybeReveal();
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (SCROLL_KEYS.has(e.key)) onHand();
    };
    const observer = new IntersectionObserver(
      (entries) => {
        near = entries[entries.length - 1]?.isIntersecting ?? false;
        maybeReveal();
      },
      { rootMargin: `0px 0px ${AUTO_REVEAL_MARGIN_PX}px 0px` },
    );
    observer.observe(el);
    window.addEventListener("scroll", maybeReveal, { passive: true });
    window.addEventListener("wheel", onHand, { passive: true });
    window.addEventListener("touchmove", onHand, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", maybeReveal);
      window.removeEventListener("wheel", onHand);
      window.removeEventListener("touchmove", onHand);
      window.removeEventListener("keydown", onKey);
    };
  }, [left, onMore]);

  return (
    <button ref={ref} type="button" className={states.moreBtn} onClick={onMore} data-load-more>
      {copy.showMore}
      <span className={states.moreLeft}>{fillTemplate(copy.moreLeft, { n: left })}</span>
      <ChevronIcon />
    </button>
  );
}

/** One batch of the view's skeleton, while another ranking is on its way. */
export function TopSkeleton({ view, layout }: { view: ViewKey; layout: Layout }) {
  const count = view === "chart" ? 10 : layout === "phone" ? (view === "table" ? 10 : 21) : 20;
  const n = Array.from({ length: count }, (_, i) => i);
  if (view === "chart") {
    return (
      <div className={cards.results} data-results data-view={view} aria-busy="true">
        <div className={`${chart.charts} ${states.fade}`} aria-hidden="true" data-skeleton>
          {n.map((i) => (
            <div key={i} className={`${states.skChart} ${states.sk}`} />
          ))}
        </div>
      </div>
    );
  }
  if (view === "table") {
    return (
      <div className={cards.results} data-results data-view={view} aria-busy="true">
        <div className={`${rows.rows} ${states.fade}`} aria-hidden="true" data-skeleton>
          {n.map((i) => (
            <div key={i} className={`${states.skRow} ${states.sk} ${top.skRanked}`} />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className={cards.results} data-results data-view={view} aria-busy="true">
      <div className={`${cards.grid5} ${states.fade}`} aria-hidden="true" data-skeleton>
        {n.map((i) => (
          <div key={i} className={states.skCard}>
            <div className={`${states.skCover} ${states.sk}`} />
            <div className={`${states.skLine} ${states.sk}`} />
            <div className={`${states.skLine} ${states.skShort} ${states.sk}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
