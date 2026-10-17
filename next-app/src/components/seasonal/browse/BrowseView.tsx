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

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { seasonYearLabel } from "@/lib/contentLabels";
import { HUE_FAMILIES } from "@/lib/home/hueFamilies";
import { oklchCss } from "@/lib/home/tone";
import { useLang } from "@/lib/lang-client";
import { barModeOf, seasonBars, type Bar } from "@/lib/seasonal/bars";
import { batchMemory, memoryUrl, rememberedPages } from "@/lib/seasonal/batchMemory";
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
 * Whether a browse page has hydrated in this document yet. Until one has, a
 * mount is the hydration of the server's HTML and must render one batch, as
 * the server did — even when a reload kept a history entry that remembers
 * more. Every later mount is a client render (a navigation, Back / Forward)
 * and may open what the entry remembers.
 */
let hydratedOnce = false;

/** The query a list re-enters for: anything but the search box, whose every keystroke would replay it. */
function listKeyOf(state: BrowseState): string {
  return [state.view, state.sort, state.genres.join(","), state.format, state.status, state.source, state.seq, state.wd, state.mon, state.hue].join("|");
}

export default function BrowseView({ items, initial, serverNowMs, season, year, clockYear, heading, Follow }: BrowseViewProps) {
  // The first state is read from the router's query, not from `initial` and
  // not from window.location. On a first load all three agree. When the
  // router restores this page from its cache (back / forward), the props are
  // that first request's while the query carries the filters the reader had
  // set, so the query wins and the page comes back as it was left. And during
  // a client navigation INTO this page, window.location still holds the page
  // being left (the router commits the new URL after this render): reading
  // it put a search page's ?q= into the season, and a year link's dropped
  // month filter back into the next year.
  const query = useSearchParams();
  const pathname = usePathname();
  const { lang } = useLang();
  const copy = useBrowseCopy();
  const { nowMs, zone } = useSeasonClock(serverNowMs);
  const layout = useLayout();

  const facets = useMemo(() => facetsOf(items), [items]);
  const mode = useMemo(() => barModeOf(items), [items]);
  const hues = useMemo(() => hueOptionsOf(items), [items]);

  const [state, setState] = useState<BrowseState>(() => settleState(query ? parseBrowseState(query) : initial, facets, mode));
  const [draft, setDraft] = useState(state.q);
  // Back from a show opens the batches that were open when the reader left
  // (see lib/seasonal/batchMemory.ts); any other arrival opens one.
  const [pages, setPages] = useState(() =>
    hydratedOnce && typeof window !== "undefined"
      ? rememberedPages(window.history.state, memoryUrl(pathname, query ? query.toString() : ""))
      : 1,
  );
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

  useEffect(() => {
    hydratedOnce = true;
  }, []);

  // The URL follows the state, and the history entry remembers the open
  // batches for it. replaceState rather than pushState: a filter is not a
  // place, and Back should leave the page rather than undo a chip.
  useEffect(() => {
    const search = browseSearch(state, window.location.search);
    const url = memoryUrl(window.location.pathname, search);
    const moved = search !== window.location.search;
    if (!moved && rememberedPages(window.history.state, url) === pages) return;
    if (moved) {
      // A fresh object: Next copies its own entry state into it and moves
      // the router's query (useSearchParams) to the new address.
      window.history.replaceState(batchMemory(url, pages), "", `${window.location.pathname}${search}${window.location.hash}`);
    } else {
      // Only the batches changed: Next's own entry state rides along, so the
      // call goes straight through without a router update.
      window.history.replaceState({ ...window.history.state, ...batchMemory(url, pages) }, "");
    }
  }, [state, pages]);

  // One menu at a time, closed by a press anywhere outside it, and by Escape
  // wherever focus is. The field's own Escape handler only hears keys from
  // inside the field, and Safari does not focus a button that is clicked, so
  // after a mouse open focus is on <body> and the key would go nowhere. The
  // listener lives only while a menu is open (as LanguageMenu's does); a key
  // the field already handled stops at React's root and never reaches it.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target?.closest?.(`[data-menu="${menu}"]`)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenu(null);
      document.querySelector<HTMLElement>(`[data-menu="${menu}"] button`)?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
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
  const list = useMemo(() => browseItems(items, state, mode, zone, nowMs), [items, state, mode, zone, nowMs]);
  const bars = useMemo(() => seasonBars(items, mode, state, nowMs, zone), [items, mode, state, nowMs, zone]);
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
        zone={zone}
        lang={lang}
        copy={copy}
        Follow={Follow}
        seasonYear={seasonYear}
        onClear={() => {
          // The empty state, and its button, go once the filters do.
          commit(clearFilters(state));
          document.querySelector<HTMLElement>("[data-seasonal-browse] [data-tag-row]")?.focus({ preventScroll: true });
        }}
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
