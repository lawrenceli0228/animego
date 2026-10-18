"use client";

// The phone's 筛选与排序 sheet: season (a segmented control of links), year
// (links), sort, genres, format and status, and a button that shows how many
// shows the choices leave.
//
// A dialog in the full sense: portalled to <body> (an ancestor's stacking
// context cannot hold it under the cards), the page scroll locked on <html>
// through lib/scrollLock.ts (a lock on <body> is a no-op on this site), focus
// moved in on open and kept in while open, Escape handled on the sheet's own
// element, and a tap on the backdrop closes it. Giving focus back on close is
// the opener's job — it owns the button focus goes back to.

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "@/components/ui/LocaleLink";
import { FILTER_GENRES, formatLabel, genreLabel, seasonLabel, statusLabel } from "@/lib/contentLabels";
import { fillTemplate } from "@/lib/home/time";
import type { Lang } from "@/lib/i18n/lang";
import { resetSheet, toggleGenre } from "@/lib/seasonal/browse";
import { SEASON_SLUGS, seasonEnum, seasonHref, type SeasonSlug } from "@/lib/seasonal/links";
import { FILTER_FORMATS, FILTER_STATUSES, type BrowseState, type SortKey } from "@/lib/seasonal/state";
import { useScrollLock } from "@/lib/scrollLock";
import { sortLabel } from "./TagRow";
import type { BrowseCopy } from "./useBrowseCopy";
import type { SeasonTarget } from "./types";
import sheet from "./sheet.module.css";

const FOCUSABLE = 'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])';

export interface FilterSheetProps {
  open: boolean;
  onClose: () => void;
  state: BrowseState;
  onCommit: (next: BrowseState) => void;
  season: SeasonSlug;
  year: number;
  years: readonly number[];
  sorts: readonly SortKey[];
  /** How many shows the current choices leave. */
  count: number;
  /** A season or year link that is loading; the season pill slides there at once. */
  pending: SeasonTarget | null;
  onNavigate: (target: SeasonTarget) => void;
  lang: Lang;
  copy: BrowseCopy;
}

export default function FilterSheet(props: FilterSheetProps) {
  // Only ever open after a press, i.e. after hydration, so `document` exists.
  if (!props.open) return null;
  return createPortal(<Sheet {...props} />, document.body);
}

function Sheet({
  onClose,
  state,
  onCommit,
  season,
  year,
  years,
  sorts,
  count,
  pending,
  onNavigate,
  lang,
  copy,
}: FilterSheetProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement | null>(null);
  useScrollLock(true);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !ref.current) return;
    const nodes = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const shownSeason = (pending?.season as SeasonSlug | undefined) ?? season;
  const pillIndex = Math.max(0, SEASON_SLUGS.indexOf(shownSeason));

  return (
    <div className={sheet.wrap} data-sheet>
      <button type="button" className={sheet.backdrop} aria-label={copy.closeSheet} tabIndex={-1} onClick={onClose} />
      <div
        ref={ref}
        className={sheet.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className={sheet.grab} aria-hidden="true" />
        <div className={sheet.head}>
          <h2 className={sheet.title} id={titleId}>
            {copy.filterSort}
          </h2>
          <button type="button" className={sheet.reset} onClick={() => onCommit(resetSheet(state))}>
            {copy.reset}
          </button>
        </div>
        <div className={sheet.body}>
          <Section label={copy.season} aside={<span className={sheet.sectionYear}>{year}</span>}>
            <nav className={sheet.seg} aria-label={copy.season}>
              <i
                className={sheet.segPill}
                style={{ transform: `translateX(calc(${pillIndex} * (100% + 4px)))` }}
                aria-hidden="true"
              />
              {SEASON_SLUGS.map((s) =>
                s === season ? (
                  <span key={s} className={sheet.segItem} aria-current="page">
                    {seasonLabel(seasonEnum(s), lang)}
                  </span>
                ) : (
                  <Link
                    key={s}
                    href={seasonHref(s, year, state)}
                    prefetch={false}
                    className={sheet.segItem}
                    onNavigate={() => onNavigate({ season: s, year })}
                  >
                    {seasonLabel(seasonEnum(s), lang)}
                  </Link>
                ),
              )}
            </nav>
          </Section>

          <Section label={copy.year}>
            <nav className={sheet.chips} aria-label={copy.year}>
              {years.map((y) =>
                y === year ? (
                  <span key={y} className={sheet.chip} aria-current="page">
                    {fillTemplate(copy.yearOption, { year: y })}
                  </span>
                ) : (
                  <Link
                    key={y}
                    href={seasonHref(season, y, state)}
                    prefetch={false}
                    className={sheet.chip}
                    onNavigate={() => onNavigate({ season, year: y })}
                  >
                    {fillTemplate(copy.yearOption, { year: y })}
                  </Link>
                ),
              )}
            </nav>
          </Section>

          <Section label={copy.sort}>
            <div className={sheet.chips}>
              {sorts.map((key) => (
                <Chip key={key} on={state.sort === key} onPress={() => onCommit({ ...state, sort: key })} value={key}>
                  {sortLabel(key, copy)}
                </Chip>
              ))}
            </div>
          </Section>

          <Section label={copy.genres}>
            <div className={sheet.chips}>
              {FILTER_GENRES.map((g) => (
                <Chip key={g} on={state.genres.includes(g)} onPress={() => onCommit(toggleGenre(state, g))} value={g}>
                  {genreLabel(g, lang)}
                </Chip>
              ))}
            </div>
          </Section>

          <Section label={copy.format}>
            <div className={sheet.chips}>
              {["", ...FILTER_FORMATS].map((f) => (
                <Chip key={f || "all"} on={state.format === f} onPress={() => onCommit({ ...state, format: f })} value={f || "all"}>
                  {f ? formatLabel(f, lang) : copy.all}
                </Chip>
              ))}
            </div>
          </Section>

          <Section label={copy.status}>
            <div className={sheet.chips}>
              {["", ...FILTER_STATUSES].map((s) => (
                <Chip key={s || "all"} on={state.status === s} onPress={() => onCommit({ ...state, status: s })} value={s || "all"}>
                  {s ? statusLabel(s, lang) : copy.all}
                </Chip>
              ))}
            </div>
          </Section>
        </div>
        <div className={sheet.foot}>
          <button type="button" className={sheet.apply} onClick={onClose} data-sheet-apply>
            {fillTemplate(copy.apply, { n: count })}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className={sheet.section}>
      <div className={sheet.sectionLabel}>
        <span>{label}</span>
        {aside}
      </div>
      {children}
    </div>
  );
}

function Chip({ on, onPress, value, children }: { on: boolean; onPress: () => void; value: string; children: ReactNode }) {
  return (
    <button type="button" className={sheet.chip} aria-pressed={on} data-chip={value} onClick={onPress}>
      {children}
    </button>
  );
}
