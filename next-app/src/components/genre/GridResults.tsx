"use client";

// The grid view's results: every title in one slice of the genre — a rail's
// "see all", a decade, a second genre — 36 to a page.
//
// The server's HTML holds the page the URL names, each title a link, and
// "show more" as a real link to the next page. With the script, a press — or
// the reader scrolling near it — fetches that page and appends it instead;
// if the fetch fails the next press simply follows the link.

import { useCallback, useEffect, useRef, type MouseEvent } from "react";
import CoverCard from "@/components/seasonal/browse/CoverCard";
import { ChevronIcon } from "@/components/seasonal/browse/icons";
import cards from "@/components/seasonal/browse/cards.module.css";
import states from "@/components/seasonal/browse/states.module.css";
import Link from "@/components/ui/LocaleLink";
import type { FilterGenre } from "@/lib/contentLabels";
import { formatCount } from "@/lib/genre/format";
import { autoLoads, loadsInPlace, titlesAfter, type GenreGridData } from "@/lib/genre/grid";
import { GRID_PAGE_SIZE, gridHref } from "@/lib/genre/views";
import { fillTemplate } from "@/lib/home/time";
import { genrePath } from "@/lib/hubs/paths";
import { DEFAULT_STATE } from "@/lib/seasonal/state";
import { MoreSkeleton } from "./Skeletons";
import type { CardEnv } from "./types";
import type { GenreCopy } from "./useGenreCopy";
import { useGridPages } from "./useGridPages";
import grid from "./grid.module.css";

/** How close (px) "show more" has to come to the viewport before it loads on its own — the seasonal page's. */
const AUTO_LOAD_MARGIN_PX = 240;
/** No automatic load before the reader has scrolled at all: a tall screen would otherwise unroll the slice. */
const AUTO_LOAD_MIN_SCROLL_PX = 40;
/**
 * How long a "show more" that has just mounted — a page of cards having just
 * come in above it — waits before coming near it loads the next page. A
 * browser that keeps the viewport where it was relative to the link while the
 * cards came in would otherwise have it load page after page in a row,
 * carrying the reader down with it; a reader's own scroll after this loads.
 */
const AUTO_LOAD_SETTLE_MS = 400;
/** Per-card entrance delay within a page, ms (AniList's stagger, slower on a phone's bigger cards). */
const STAGGER_MS = { desktop: 16, phone: 22 } as const;

interface GridResultsProps {
  genre: FilterGenre;
  data: GenreGridData;
  env: CardEnv;
  copy: GenreCopy;
}

export default function GridResults({ genre, data, env, copy }: GridResultsProps) {
  const { items, lastPage, open, hasMore, loading, failed, more } = useGridPages(data, env.lang);
  const stagger = STAGGER_MS[env.layout];
  const gridRef = useRef<HTMLDivElement | null>(null);
  // Where keyboard focus goes once a pressed "show more" has done its work:
  // the link it was on is replaced by the skeleton while the page loads, and
  // is gone for good after the last one.
  const focusAfter = useRef<number | null>(null);

  const press = useCallback(() => {
    const active = document.activeElement;
    focusAfter.current = active instanceof HTMLElement && active.matches("[data-load-more]") ? items.length : null;
    more();
  }, [items.length, more]);

  useEffect(() => {
    const first = focusAfter.current;
    if (first === null || loading) return;
    focusAfter.current = null;
    // Only for a reader still waiting on the press: focus that has moved on
    // while the page loaded — to the search box, to a card — is theirs.
    const active = document.activeElement;
    if (active && active !== document.body && !active.matches("[data-load-more]")) return;
    // The first of the new cards' title; or the link again, when the load failed.
    const card = items.length > first ? gridRef.current?.querySelectorAll("[data-anime-card]")[first] : null;
    const target = card
      ? card.querySelector<HTMLElement>('a:not([tabindex="-1"])')
      : document.querySelector<HTMLElement>("[data-load-more]");
    target?.focus({ preventScroll: true });
  }, [items.length, loading]);

  if (items.length === 0) {
    return (
      <div className={cards.results} data-results>
        <div className={states.empty} data-empty>
          {copy.empty}
          <Link href={genrePath(genre)} prefetch={false} className={`${states.emptyBtn} ${grid.emptyLink}`}>
            {copy.backShort}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={cards.results} data-results>
      <div ref={gridRef} className={cards.grid} data-grid>
        {items.map((item, i) => (
          <CoverCard
            key={item.id}
            item={item}
            hidden={false}
            delayMs={(i % GRID_PAGE_SIZE) * stagger}
            nowMs={env.nowMs}
            zone={env.zone}
            state={DEFAULT_STATE}
            mode="weekday"
            lang={env.lang}
            copy={env.copy}
            Follow={env.Follow}
            priority={i === 0}
            airing={env.airing}
          />
        ))}
      </div>
      {hasMore ? (
        <div className={states.moreZone}>
          {loading ? (
            <MoreSkeleton />
          ) : (
            <MoreLink
              href={gridHref(genre, data.view, lastPage + 1)}
              left={titlesAfter(data.total, lastPage)}
              followLink={failed || !loadsInPlace(open)}
              autoLoad={autoLoads(open)}
              onMore={press}
              copy={copy}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * "显示更多 · 还有 N 部": a link to the next page, which the script turns into
 * an in-place load — pressed, or, for the first few pages, brought within
 * AUTO_LOAD_MARGIN_PX of the viewport once the reader has scrolled. Re-armed
 * on every mount, and settled for AUTO_LOAD_SETTLE_MS first: a page that came
 * in short with the link still in range loads the next one at the reader's
 * next scroll, not by itself. With `followLink` (a failed load, or a grid
 * already holding as much as it should) a press is an ordinary link to the
 * next page.
 */
function MoreLink({
  href,
  left,
  followLink,
  autoLoad,
  onMore,
  copy,
}: {
  href: string;
  left: number;
  followLink: boolean;
  autoLoad: boolean;
  onMore: () => void;
  copy: GenreCopy;
}) {
  const ref = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || followLink || !autoLoad || typeof IntersectionObserver === "undefined") return;
    const armedAt = performance.now();
    let near = false;
    let fired = false;
    const maybeLoad = () => {
      if (fired || !near || window.scrollY < AUTO_LOAD_MIN_SCROLL_PX) return;
      if (performance.now() - armedAt < AUTO_LOAD_SETTLE_MS) return;
      fired = true;
      onMore();
    };
    const observer = new IntersectionObserver(
      (entries) => {
        near = entries[entries.length - 1]?.isIntersecting ?? false;
        maybeLoad();
      },
      { rootMargin: `0px 0px ${AUTO_LOAD_MARGIN_PX}px 0px` },
    );
    observer.observe(el);
    // The observer reports crossings only; a link already in range when the
    // reader starts scrolling needs the scroll itself to count.
    window.addEventListener("scroll", maybeLoad, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", maybeLoad);
    };
  }, [followLink, autoLoad, onMore]);

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // A modified click opens the page in a tab, as a link should.
    if (followLink || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onMore();
  };

  return (
    <Link ref={ref} href={href} prefetch={false} className={states.moreBtn} onClick={onClick} data-load-more>
      {copy.showMore}
      <span className={states.moreLeft}>{fillTemplate(copy.moreLeft, { n: formatCount(left) })}</span>
      <ChevronIcon />
    </Link>
  );
}
