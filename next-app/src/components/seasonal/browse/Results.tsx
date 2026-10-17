"use client";

// The result list in whichever view is chosen, and what sits under it.
//
// Every item of the filtered list is rendered, so its link is in the HTML a
// crawler reads; the ones past the revealed batches carry `hidden` until
// "show more" (or scrolling near it) reveals the next batch.
//
// While another season is loading, the only skeleton on the page stands in
// for the list. Filtering never shows one: it is instant.

import { useEffect, useRef } from "react";
import { fillTemplate } from "@/lib/home/time";
import type { Lang } from "@/lib/i18n/lang";
import type { BarMode } from "@/lib/seasonal/bars";
import { batchSize, hiddenCount, staggerMs, visibleCount, type Layout } from "@/lib/seasonal/batch";
import type { SeasonalItem } from "@/lib/seasonal/model";
import type { BrowseState, ViewKey } from "@/lib/seasonal/state";
import ChartCard from "./ChartCard";
import CoverCard from "./CoverCard";
import TableRow from "./TableRow";
import { ChevronIcon } from "./icons";
import type { BrowseCopy } from "./useBrowseCopy";
import type { FollowSlot } from "./types";
import cards from "./cards.module.css";
import chart from "./chart.module.css";
import rows from "./rows.module.css";
import states from "./states.module.css";

/** How close (px) "show more" has to come to the viewport before it reveals on its own. */
const AUTO_REVEAL_MARGIN_PX = 240;
/** No automatic reveal before the reader has scrolled at all: a tall screen would otherwise unroll the season. */
const AUTO_REVEAL_MIN_SCROLL_PX = 40;

/** Skeleton sizes: one batch of the view. The phone's stylesheet hides the extra ones. */
const SKELETON: Record<ViewKey, number> = { grid: 36, chart: 12, table: 16 };

interface ResultsProps {
  list: readonly SeasonalItem[];
  view: ViewKey;
  layout: Layout;
  pages: number;
  onMore: () => void;
  /** Changes whenever the list is a different query, so it re-enters with its stagger. */
  listKey: string;
  pending: boolean;
  state: BrowseState;
  mode: BarMode;
  nowMs: number;
  lang: Lang;
  copy: BrowseCopy;
  Follow: FollowSlot;
  seasonYear: string;
  onClear: () => void;
}

export default function Results(props: ResultsProps) {
  const { list, view, layout, pages, onMore, listKey, pending, copy, onClear } = props;

  if (pending) {
    return (
      <div className={cards.results} data-results data-view={view} aria-busy="true">
        <Skeleton view={view} />
      </div>
    );
  }

  if (list.length === 0) {
    return (
      <div className={cards.results} data-results data-view={view}>
        <div className={states.empty} data-empty>
          {copy.empty}
          <button type="button" className={states.emptyBtn} onClick={onClear}>
            {copy.clearFilters}
          </button>
        </div>
      </div>
    );
  }

  const batch = batchSize(view, layout);
  const shown = visibleCount(list.length, pages, batch);
  const left = hiddenCount(list.length, pages, batch);

  return (
    <div className={cards.results} data-results data-view={view}>
      <List key={listKey} {...props} shown={shown} />
      {left > 0 ? <LoadMore left={left} onMore={onMore} copy={copy} /> : null}
    </div>
  );
}

function List({
  list,
  view,
  layout,
  shown,
  state,
  mode,
  nowMs,
  lang,
  copy,
  Follow,
  seasonYear,
}: ResultsProps & { shown: number }) {
  if (view === "chart") {
    return (
      <div className={chart.charts} data-charts>
        {list.map((item, i) => (
          <ChartCard
            key={item.id}
            item={item}
            hidden={i >= shown}
            delayMs={staggerMs(i, view, layout)}
            nowMs={nowMs}
            lang={lang}
            copy={copy}
            Follow={Follow}
            priority={i === 0}
          />
        ))}
      </div>
    );
  }
  if (view === "table") {
    return (
      <div className={rows.rows} data-rows>
        {list.map((item, i) => (
          <TableRow
            key={item.id}
            item={item}
            hidden={i >= shown}
            delayMs={staggerMs(i, view, layout)}
            nowMs={nowMs}
            lang={lang}
            copy={copy}
            seasonYear={seasonYear}
          />
        ))}
      </div>
    );
  }
  return (
    <div className={cards.grid} data-grid>
      {list.map((item, i) => (
        <CoverCard
          key={item.id}
          item={item}
          hidden={i >= shown}
          delayMs={staggerMs(i, view, layout)}
          nowMs={nowMs}
          state={state}
          mode={mode}
          lang={lang}
          copy={copy}
          Follow={Follow}
          priority={i === 0}
        />
      ))}
    </div>
  );
}

/**
 * "显示更多 · 还有 N 部", and the observer that presses it for the reader
 * once they scroll near it.
 *
 * Re-armed after every reveal (`left` changes): if the batch that just came in
 * was short and the button is still in range, the fresh observer's first
 * report reveals the next one, rather than leaving the reader stuck in front
 * of a button an observer will never report again.
 */
function LoadMore({ left, onMore, copy }: { left: number; onMore: () => void; copy: BrowseCopy }) {
  const ref = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    let near = false;
    let fired = false;
    const maybeReveal = () => {
      if (fired || !near || window.scrollY < AUTO_REVEAL_MIN_SCROLL_PX) return;
      fired = true;
      onMore();
    };
    const observer = new IntersectionObserver(
      (entries) => {
        near = entries[entries.length - 1]?.isIntersecting ?? false;
        maybeReveal();
      },
      { rootMargin: `0px 0px ${AUTO_REVEAL_MARGIN_PX}px 0px` },
    );
    observer.observe(el);
    // The observer reports crossings only. A button already in range when the
    // reader starts scrolling needs the scroll itself to count.
    window.addEventListener("scroll", maybeReveal, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", maybeReveal);
    };
  }, [left, onMore]);

  return (
    <div className={states.moreZone}>
      <button ref={ref} type="button" className={states.moreBtn} onClick={onMore} data-load-more>
        {copy.showMore}
        <span className={states.moreLeft}>{fillTemplate(copy.moreLeft, { n: left })}</span>
        <ChevronIcon />
      </button>
    </div>
  );
}

function Skeleton({ view }: { view: ViewKey }) {
  const n = Array.from({ length: SKELETON[view] }, (_, i) => i);
  if (view === "chart") {
    return (
      <div className={`${chart.charts} ${states.fade}`} aria-hidden="true" data-skeleton>
        {n.map((i) => (
          <div key={i} className={`${states.skChart} ${states.sk}`} />
        ))}
      </div>
    );
  }
  if (view === "table") {
    return (
      <div className={`${rows.rows} ${states.fade}`} aria-hidden="true" data-skeleton>
        {n.map((i) => (
          <div key={i} className={`${states.skRow} ${states.sk}`} />
        ))}
      </div>
    );
  }
  return (
    <div className={`${cards.grid} ${states.fade}`} aria-hidden="true" data-skeleton>
      {n.map((i) => (
        <div key={i} className={states.skCard}>
          <div className={`${states.skCover} ${states.sk}`} />
          <div className={`${states.skLine} ${states.sk}`} />
          <div className={`${states.skLine} ${states.skShort} ${states.sk}`} />
        </div>
      ))}
    </div>
  );
}
