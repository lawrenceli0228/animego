"use client";

// The switch between rankings: 历代, then each of the last thirteen years that
// has a ranking, then 更早 — a menu of every ranked year before them. Every
// cell is a real link, and a block slides under the current one.
//
// A press moves the block at once, before the next ranking has arrived, so it
// slides while that page loads. An older year has no cell of its own: its
// page shows its year in the 更早 cell, with the block under it. Where the
// strip scrolls (a phone) the current cell is brought into view on arrival,
// and a strip that was scrolled to reach a year opens there again.

import { useEffect, useRef, type CSSProperties, type MouseEvent } from "react";
import { ChevronIcon } from "@/components/seasonal/browse/icons";
import Link from "@/components/ui/LocaleLink";
import type { Layout } from "@/lib/seasonal/batch";
import { topHref, withYear, type TopState } from "@/lib/top/query";
import type { StripYears } from "@/lib/top/years";
import type { TopCopy } from "./useTopCopy";
import top from "./top.module.css";

/** Where the strip was scrolled when a cell in it was pressed, for the next ranking to open at. */
let carriedScroll: number | null = null;

interface YearStripProps {
  /** What the header shows: the page's ranking, or the one pressed that is on its way. */
  shown: TopState;
  /** The page's own year: the strip's current link. */
  pageYear: number | null;
  strip: StripYears;
  olderOpen: boolean;
  onOlder: () => void;
  onGo: (next: TopState) => void;
  layout: Layout;
  copy: TopCopy;
}

/** Plain clicks are the page's to handle; a modified one opens a tab, as a link should. */
const plainClick = (e: MouseEvent) => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0);

export default function YearStrip({ shown, pageYear, strip, olderOpen, onOlder, onGo, layout, copy }: YearStripProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const shownIsOlder = shown.year !== null && !strip.recent.includes(shown.year);
  const pageIsOlder = pageYear !== null && !strip.recent.includes(pageYear);
  const hasOlder = strip.older.length > 0 || shownIsOlder || pageIsOlder;
  const cells = 1 + strip.recent.length + (hasOlder ? 1 : 0);
  const index = shown.year === null ? 0 : shownIsOlder ? cells - 1 : 1 + strip.recent.indexOf(shown.year);
  const style = { "--n": cells, "--i": index } as CSSProperties;

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const carried = carriedScroll;
    carriedScroll = null;
    if (scroller.scrollWidth <= scroller.clientWidth + 1) return;
    if (carried !== null) scroller.scrollLeft = carried;
    const cell = scroller.querySelector<HTMLElement>('[data-on="true"]');
    if (!cell) return;
    const box = scroller.getBoundingClientRect();
    const at = cell.getBoundingClientRect();
    if (at.left >= box.left && at.right <= box.right) return;
    scroller.scrollLeft += at.left + at.width / 2 - (box.left + box.width / 2);
  }, []);

  const cell = (year: number | null, label: string) => {
    const isPage = year === pageYear;
    const target = withYear(shown, year);
    return (
      <Link
        key={year ?? "all"}
        href={topHref(target)}
        prefetch={false}
        className={top.seg}
        aria-current={isPage ? "page" : undefined}
        data-on={year === shown.year ? "true" : "false"}
        data-year={year ?? "all"}
        data-mono={year === null ? undefined : "true"}
        onClick={(e) => {
          if (isPage && year === shown.year && plainClick(e)) e.preventDefault();
        }}
        onNavigate={() => {
          carriedScroll = scrollerRef.current?.scrollLeft ?? null;
          onGo(target);
        }}
      >
        {label}
      </Link>
    );
  };

  const olderLabel = shownIsOlder && shown.year !== null ? String(shown.year) : copy.older;
  const olderYears = pageIsOlder && pageYear !== null && !strip.older.includes(pageYear) ? [pageYear, ...strip.older] : strip.older;

  return (
    <div className={top.stripWrap} data-top-strip-wrap>
      <div ref={scrollerRef} className={top.scroller}>
        <nav className={top.strip} style={style} aria-label={copy.strip} data-top-strip>
          <i className={top.ind} aria-hidden="true" data-strip-indicator={shown.year ?? "all"} />
          {cell(null, copy.allTime)}
          {strip.recent.map((y) => cell(y, String(y)))}
          {hasOlder ? (
            <button
              type="button"
              className={top.seg}
              aria-expanded={olderOpen}
              aria-controls="top-older-years"
              aria-current={pageIsOlder ? "page" : undefined}
              data-on={shownIsOlder ? "true" : "false"}
              data-mono={shownIsOlder ? "true" : undefined}
              data-older
              onClick={onOlder}
            >
              {olderLabel}
              <ChevronIcon className={top.segChev} />
            </button>
          ) : null}
        </nav>
      </div>
      {hasOlder && layout === "desktop" ? (
        <OlderYears years={olderYears} shown={shown} pageYear={pageYear} open={olderOpen} onGo={onGo} copy={copy} variant="menu" />
      ) : null}
      {hasOlder && layout === "phone" ? (
        <OlderYears years={olderYears} shown={shown} pageYear={pageYear} open={olderOpen} onGo={onGo} copy={copy} variant="panel" />
      ) : null}
    </div>
  );
}

/**
 * The years before the strip's, newest first: a dropdown under 更早 on a
 * desktop, a panel of chips under the strip on a phone. Rendered while closed
 * too (hidden), so every year's page is a link in the server's HTML.
 */
function OlderYears({
  years,
  shown,
  pageYear,
  open,
  onGo,
  copy,
  variant,
}: {
  years: readonly number[];
  shown: TopState;
  pageYear: number | null;
  open: boolean;
  onGo: (next: TopState) => void;
  copy: TopCopy;
  variant: "menu" | "panel";
}) {
  return (
    <div
      id="top-older-years"
      className={variant === "menu" ? top.olderMenu : top.olderPanel}
      role="group"
      aria-label={copy.olderYears}
      hidden={!open}
      data-older-years
    >
      {years.map((y) => {
        const target = withYear(shown, y);
        const isPage = y === pageYear;
        return (
          <Link
            key={y}
            href={topHref(target)}
            prefetch={false}
            className={variant === "menu" ? top.olderOpt : top.olderChip}
            aria-current={isPage ? "page" : undefined}
            data-year={y}
            onClick={(e) => {
              if (isPage && plainClick(e)) e.preventDefault();
            }}
            onNavigate={() => onGo(target)}
          >
            {y}
          </Link>
        );
      })}
    </div>
  );
}
