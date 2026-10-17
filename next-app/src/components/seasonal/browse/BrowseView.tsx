"use client";

// The seasonal browse page: heading and bar chart, filter bar (or the phone's
// search row and sheet), tag row, and the results.
//
// All of the season arrives as props; filtering, sorting, switching views and
// revealing batches happen here, at once, with no request. The state lives in
// the URL as well (history.replaceState, so a filtered page is a link worth
// sharing and the back button still leaves the page). Changing season or year
// is a real route change through ordinary links, and while it loads the
// results show the page's one skeleton.
//
// The follow buttons come in as `Follow` — see types.ts for why.

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { seasonYearLabel } from "@/lib/contentLabels";
import { HUE_FAMILIES } from "@/lib/home/hueFamilies";
import { oklchCss } from "@/lib/home/tone";
import { useLang } from "@/lib/lang-client";
import { barModeOf, seasonBars, type Bar } from "@/lib/seasonal/bars";
import { effectiveView } from "@/lib/seasonal/batch";
import {
  browseItems,
  clearFilters,
  facetsOf,
  hueOptionsOf,
  settleState,
  sheetFilterCount,
  toggleHue,
  toggleMonth,
  toggleWeekday,
  withoutTag,
} from "@/lib/seasonal/browse";
import { seasonEnum, yearOptions, type SeasonSlug } from "@/lib/seasonal/links";
import type { SeasonalItem } from "@/lib/seasonal/model";
import { browseSearch, parseBrowseState, type BrowseState } from "@/lib/seasonal/state";
import FilterBar, { type SearchBinding } from "./FilterBar";
import FilterSheet from "./FilterSheet";
import HeadRow from "./HeadRow";
import HueDots from "./HueDots";
import type { MenuKey } from "./MenuField";
import Results from "./Results";
import TagRow from "./TagRow";
import { useLayout, useSeasonClock } from "./hooks";
import { SearchIcon, SlidersIcon } from "./icons";
import { useBrowseCopy, type BrowseCopy } from "./useBrowseCopy";
import type { FollowSlot, SeasonTarget } from "./types";
import controls from "./controls.module.css";
import frame from "./frame.module.css";

/** Years the phone sheet offers as chips: next year and the six before this one. */
const PHONE_YEARS_BACK = 6;

export interface BrowseViewProps {
  items: readonly SeasonalItem[];
  /** The state the server parsed from the request's query. */
  initial: BrowseState;
  serverNowMs: number;
  season: SeasonSlug;
  year: number;
  /** The server's year: the year menu runs to the one after it. */
  clockYear: number;
  heading: string;
  Follow: FollowSlot;
}

/**
 * The first state, the same on both sides of hydration: on a first load the
 * browser's URL is the request the server parsed. When the router restores
 * this page from its cache (back / forward), the props are that first
 * request's while the URL carries the filters the reader had set — the URL
 * wins, so the page comes back as it was left.
 */
function firstState(initial: BrowseState): BrowseState {
  if (typeof window === "undefined" || !window.location) return initial;
  return parseBrowseState(new URLSearchParams(window.location.search));
}

/** The query a list re-enters for: anything but the search box, whose every keystroke would replay it. */
function listKeyOf(state: BrowseState): string {
  return [state.view, state.sort, state.genres.join(","), state.format, state.status, state.source, state.seq, state.wd, state.mon, state.hue].join("|");
}

export default function BrowseView({ items, initial, serverNowMs, season, year, clockYear, heading, Follow }: BrowseViewProps) {
  const { lang } = useLang();
  const copy = useBrowseCopy();
  const nowMs = useSeasonClock(serverNowMs);
  const layout = useLayout();

  const facets = useMemo(() => facetsOf(items), [items]);
  const mode = useMemo(() => barModeOf(items), [items]);
  const hues = useMemo(() => hueOptionsOf(items), [items]);

  const [state, setState] = useState<BrowseState>(() => settleState(firstState(initial), facets, mode));
  const [draft, setDraft] = useState(state.q);
  const [pages, setPages] = useState(1);
  const [menu, setMenu] = useState<MenuKey | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pending, setPending] = useState<SeasonTarget | null>(null);
  const composing = useRef(false);
  const sheetButton = useRef<HTMLButtonElement | null>(null);

  /** Every change of what is shown goes through here: settled, batch reset, search box in step. */
  const commit = useCallback(
    (next: BrowseState) => {
      const settled = settleState(next, facets, mode);
      setState(settled);
      setDraft(settled.q);
      setPages(1);
    },
    [facets, mode],
  );

  // The URL follows the state. replaceState rather than pushState: a filter
  // is not a place, and Back should leave the page rather than undo a chip.
  useEffect(() => {
    const search = browseSearch(state, window.location.search);
    if (search === window.location.search) return;
    window.history.replaceState(null, "", `${window.location.pathname}${search}${window.location.hash}`);
  }, [state]);

  // One menu at a time, closed by a press anywhere outside it.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target?.closest?.(`[data-menu="${menu}"]`)) setMenu(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menu]);

  // A season link started loading and the reader went Back before it landed:
  // this page is staying, so its skeleton goes.
  useEffect(() => {
    if (!pending) return;
    const onPop = () => setPending(null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [pending]);

  const onNavigate = useCallback((target: SeasonTarget) => {
    setMenu(null);
    setPending(target);
  }, []);

  const view = effectiveView(state.view, layout);
  const list = useMemo(() => browseItems(items, state, mode), [items, state, mode]);
  const bars = useMemo(() => seasonBars(items, mode, state, nowMs), [items, mode, state, nowMs]);
  const years = useMemo(() => yearOptions(year, clockYear), [year, clockYear]);
  const phoneYears = useMemo(() => years.filter((y) => y === year || (y <= clockYear + 1 && y >= clockYear - PHONE_YEARS_BACK)), [years, year, clockYear]);

  const search: SearchBinding = {
    value: draft,
    onChange: (value) => {
      setDraft(value);
      if (!composing.current) commit({ ...state, q: value });
    },
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: (value) => {
      composing.current = false;
      commit({ ...state, q: value });
    },
  };

  const onMore = useCallback(() => setPages((p) => p + 1), []);

  const onBar = (bar: Bar) =>
    commit(bar.kind === "weekday" ? toggleWeekday(state, bar.weekday) : toggleMonth(state, bar.key));

  const closeSheet = () => {
    setSheetOpen(false);
    sheetButton.current?.focus({ preventScroll: true });
  };

  const family = HUE_FAMILIES.find((f) => f.key === state.hue);
  const seasonYear = seasonYearLabel(seasonEnum(season), year, lang);
  const filterCount = sheetFilterCount(state);

  return (
    <main
      className={frame.page}
      style={family ? { backgroundColor: oklchCss(13, 0.016, family.hue) } : undefined}
      data-seasonal-browse
      data-layout={layout}
    >
      <HeadRow heading={heading} count={list.length} bars={bars} mode={mode} lang={lang} copy={copy} onBar={onBar} />

      <FilterBar
        state={state}
        search={search}
        season={season}
        year={year}
        years={years}
        facets={facets}
        menu={menu}
        onMenu={setMenu}
        onCommit={commit}
        onNavigate={onNavigate}
        lang={lang}
        copy={copy}
      />

      <PhoneSearch
        search={search}
        copy={copy}
        filterCount={filterCount}
        open={sheetOpen}
        onOpen={() => setSheetOpen(true)}
        buttonRef={sheetButton}
      />
      <HueDots options={hues} selected={state.hue} onPick={(key) => commit(toggleHue(state, key))} copy={copy} phone />

      <TagRow
        state={state}
        season={season}
        year={year}
        hues={hues}
        sorts={facets.sorts}
        view={view}
        menu={menu}
        onMenu={setMenu}
        onRemove={(tag) => commit(withoutTag(state, tag))}
        onClear={() => commit(clearFilters(state))}
        onHue={(key) => commit(toggleHue(state, key))}
        onSort={(sort) => commit({ ...state, sort })}
        onView={(next) => commit({ ...state, view: next })}
        lang={lang}
        copy={copy}
      />

      <Results
        list={list}
        view={view}
        layout={layout}
        pages={pages}
        onMore={onMore}
        listKey={listKeyOf(state)}
        pending={pending !== null}
        state={state}
        mode={mode}
        nowMs={nowMs}
        lang={lang}
        copy={copy}
        Follow={Follow}
        seasonYear={seasonYear}
        onClear={() => commit(clearFilters(state))}
      />

      <FilterSheet
        open={sheetOpen}
        onClose={closeSheet}
        state={state}
        onCommit={commit}
        season={season}
        year={year}
        years={phoneYears}
        sorts={facets.sorts}
        count={list.length}
        pending={pending}
        onNavigate={onNavigate}
        lang={lang}
        copy={copy}
      />
    </main>
  );
}

interface PhoneSearchProps {
  search: SearchBinding;
  copy: BrowseCopy;
  filterCount: number;
  open: boolean;
  onOpen: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}

/** The phone's row: the search field and the button that opens the sheet, with a count of what the sheet has set. */
function PhoneSearch({ search, copy, filterCount, open, onOpen, buttonRef }: PhoneSearchProps) {
  return (
    <div className={controls.searchRow} data-phone-search>
      <div className={`${controls.control} ${controls.search}`}>
        <SearchIcon />
        <input
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          aria-label={copy.phoneSearch}
          placeholder={copy.phoneSearch}
          value={search.value}
          onChange={(e) => search.onChange(e.currentTarget.value)}
          onCompositionStart={search.onCompositionStart}
          onCompositionEnd={(e) => search.onCompositionEnd(e.currentTarget.value)}
          data-search="phone"
        />
      </div>
      <button
        ref={buttonRef}
        type="button"
        className={controls.sheetBtn}
        aria-label={copy.filterSort}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onOpen}
        data-sheet-open
      >
        <SlidersIcon />
        {filterCount > 0 ? <b className={controls.sheetBadge}>{filterCount}</b> : null}
      </button>
    </div>
  );
}
