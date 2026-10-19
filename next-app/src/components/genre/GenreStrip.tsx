"use client";

// The hub's genre strip: every browsable genre as a link, with its count, and
// a block that slides under the current one.
//
// A press moves the block at once, before the next genre's page has arrived,
// so it slides while that page loads (the content area meanwhile shows the
// hub's skeleton). Where the strip scrolls — a phone, a tablet, English — the
// current genre is brought into view on arrival, and a strip that was
// scrolled to reach a genre opens there again on that genre's page.

import { useEffect, useRef, type CSSProperties } from "react";
import Link from "@/components/ui/LocaleLink";
import { genreLabel, type FilterGenre } from "@/lib/contentLabels";
import { formatCount } from "@/lib/genre/format";
import type { StripEntry } from "@/lib/genre/strip";
import { genrePath, genreSlug } from "@/lib/hubs/paths";
import type { Lang } from "@/lib/i18n/lang";
import type { GenreCopy } from "./useGenreCopy";
import hero from "./hero.module.css";

/** Cells to a row in the English desktop strip's two rows. */
const WIDE_COLUMNS = 9;

/** Where the strip was scrolled when a genre in it was pressed, for that genre's page to open at. */
let carriedScroll: number | null = null;

interface GenreStripProps {
  genre: FilterGenre;
  entries: readonly StripEntry[];
  /** A genre pressed whose page is on its way: the block is already under it. */
  pendingGenre: FilterGenre | null;
  onPick: (genre: FilterGenre) => void;
  lang: Lang;
  copy: GenreCopy;
}

export default function GenreStrip({ genre, entries, pendingGenre, onPick, lang, copy }: GenreStripProps) {
  const scrollerRef = useRef<HTMLElement | null>(null);
  const shown = pendingGenre ?? genre;
  const index = Math.max(
    0,
    entries.findIndex((e) => e.genre === shown),
  );
  const indicator = {
    "--i": index,
    "--c": index % WIDE_COLUMNS,
    "--r": Math.floor(index / WIDE_COLUMNS),
  } as CSSProperties;

  // Bring the current genre into view where the strip scrolls. Only the
  // strip's own box moves (scrollIntoView would scroll the page too).
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const carried = carriedScroll;
    carriedScroll = null;
    if (scroller.scrollWidth <= scroller.clientWidth + 1) return;
    if (carried !== null) scroller.scrollLeft = carried;
    const pill = scroller.querySelector<HTMLElement>('[aria-current="page"]');
    if (!pill) return;
    const box = scroller.getBoundingClientRect();
    const at = pill.getBoundingClientRect();
    if (at.left >= box.left && at.right <= box.right) return;
    scroller.scrollLeft += at.left + at.width / 2 - (box.left + box.width / 2);
  }, []);

  return (
    <nav ref={scrollerRef} className={hero.scroller} aria-label={copy.strip} data-genre-strip>
      <div className={hero.strip} data-wide={lang === "en" ? "true" : "false"}>
        <i className={hero.ind} style={indicator} aria-hidden="true" data-strip-indicator={genreSlug(shown)} />
        {entries.map((entry) => {
          const isCurrent = entry.genre === genre;
          const label = genreLabel(entry.genre, lang);
          const count = entry.count === null ? null : formatCount(entry.count);
          return (
            <Link
              key={entry.genre}
              href={genrePath(entry.genre)}
              prefetch={false}
              className={hero.seg}
              aria-current={isCurrent ? "page" : undefined}
              data-on={entry.genre === shown ? "true" : "false"}
              data-genre={genreSlug(entry.genre)}
              onClick={isCurrent ? (e) => e.preventDefault() : undefined}
              onNavigate={
                isCurrent
                  ? undefined
                  : () => {
                      carriedScroll = scrollerRef.current?.scrollLeft ?? null;
                      onPick(entry.genre);
                    }
              }
            >
              {/* The name a screen reader reads is the pill's own text, the
                * unit added: "动作 5,242 部" — a voice command for the visible
                * words finds it (WCAG 2.5.3). */}
              <b className={hero.segName}>{label}</b>
              {count === null ? null : (
                <span className={hero.segCount}>
                  {count}
                  <span className={hero.srOnly}>{` ${copy.stripUnit}`}</span>
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
