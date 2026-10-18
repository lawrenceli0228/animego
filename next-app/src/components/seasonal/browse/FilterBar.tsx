"use client";

// The desktop (and tablet) filter bar: search, genres, year, season, format,
// and a "more filters" panel with status, source and new-or-sequel.
//
// The year and season menus hold real links, rendered (hidden) even while
// closed: they are the season link graph a crawler walks, the one the old
// season nav provided. Choosing one is a route change; everything else here
// changes state in place.

import { useId, type KeyboardEvent, type ReactNode } from "react";
import Link from "@/components/ui/LocaleLink";
import { FILTER_GENRES, formatLabel, genreLabel, seasonLabel, sourceLabel, statusLabel } from "@/lib/contentLabels";
import { fillTemplate } from "@/lib/home/time";
import type { Lang } from "@/lib/i18n/lang";
import { toggleGenre, type Facets } from "@/lib/seasonal/browse";
import { SEASON_SLUGS, seasonEnum, seasonHref, type SeasonSlug } from "@/lib/seasonal/links";
import {
  FILTER_FORMATS,
  FILTER_STATUSES,
  SOURCE_GROUPS,
  type BrowseState,
  type SequelFilter,
  type SourceGroup,
} from "@/lib/seasonal/state";
import MenuField, { type MenuKey } from "./MenuField";
import { CheckIcon, SearchIcon, SlidersIcon } from "./icons";
import type { BrowseCopy } from "./useBrowseCopy";
import type { SeasonTarget } from "./types";
import controls from "./controls.module.css";

export interface SearchBinding {
  value: string;
  onChange: (value: string) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (value: string) => void;
}

/** How a list of picked genres reads in the trigger. */
const LIST_SEPARATOR: Record<Lang, string> = { zh: "、", en: ", ", "zh-Hant": "、" };

interface FilterBarProps {
  state: BrowseState;
  search: SearchBinding;
  season: SeasonSlug;
  year: number;
  years: readonly number[];
  facets: Facets;
  menu: MenuKey | null;
  onMenu: (menu: MenuKey | null) => void;
  onCommit: (next: BrowseState) => void;
  onNavigate: (target: SeasonTarget) => void;
  lang: Lang;
  copy: BrowseCopy;
}

export default function FilterBar(props: FilterBarProps) {
  const { state, search, season, year, years, menu, onMenu, onCommit, onNavigate, lang, copy } = props;
  const searchId = useId();
  const toggle = (key: MenuKey) => () => onMenu(menu === key ? null : key);
  const close = () => onMenu(null);

  const genreValue = state.genres.length
    ? state.genres.map((g) => genreLabel(g, lang)).join(LIST_SEPARATOR[lang])
    : copy.any;
  const moreSet = Boolean(state.status || state.source || state.seq);

  return (
    <div className={controls.filters} data-filter-bar>
      <div className={controls.field}>
        <label className={controls.label} htmlFor={searchId}>
          {copy.search}
        </label>
        <div className={`${controls.control} ${controls.search}`}>
          <SearchIcon />
          <input
            id={searchId}
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            placeholder={copy.searchPlaceholder}
            value={search.value}
            onChange={(e) => search.onChange(e.currentTarget.value)}
            onCompositionStart={search.onCompositionStart}
            onCompositionEnd={(e) => search.onCompositionEnd(e.currentTarget.value)}
            data-search="desktop"
          />
        </div>
      </div>

      <MenuField
        menuKey="genre"
        label={copy.genres}
        value={genreValue}
        isSet={state.genres.length > 0}
        open={menu === "genre"}
        onToggle={toggle("genre")}
        onClose={close}
        popup="listbox"
      >
        {({ labelId }) =>
          menu === "genre" ? (
            <div className={`${controls.menu} ${controls.menuWide}`} role="listbox" aria-multiselectable="true" aria-labelledby={labelId}>
              {FILTER_GENRES.map((g) => (
                <button
                  key={g}
                  type="button"
                  role="option"
                  aria-selected={state.genres.includes(g)}
                  className={controls.opt}
                  data-option={g}
                  onClick={() => onCommit(toggleGenre(state, g))}
                >
                  {genreLabel(g, lang)}
                  <CheckIcon />
                </button>
              ))}
            </div>
          ) : null
        }
      </MenuField>

      <MenuField
        menuKey="year"
        label={copy.year}
        value={fillTemplate(copy.yearOption, { year })}
        isSet
        open={menu === "year"}
        onToggle={toggle("year")}
        onClose={close}
      >
        {() => (
          <div className={controls.menu} hidden={menu !== "year"} data-menu-panel="year">
            {years.map((y) =>
              y === year ? (
                <span key={y} className={controls.opt} aria-current="page">
                  {fillTemplate(copy.yearOption, { year: y })}
                  <CheckIcon />
                </span>
              ) : (
                <Link
                  key={y}
                  href={seasonHref(season, y, state)}
                  prefetch={false}
                  className={controls.opt}
                  onNavigate={() => onNavigate({ season, year: y })}
                >
                  {fillTemplate(copy.yearOption, { year: y })}
                  <CheckIcon />
                </Link>
              ),
            )}
          </div>
        )}
      </MenuField>

      <MenuField
        menuKey="season"
        label={copy.season}
        value={seasonLabel(seasonEnum(season), lang)}
        isSet
        open={menu === "season"}
        onToggle={toggle("season")}
        onClose={close}
      >
        {() => (
          <div className={controls.menu} hidden={menu !== "season"} data-menu-panel="season">
            {SEASON_SLUGS.map((s) =>
              s === season ? (
                <span key={s} className={controls.opt} aria-current="page">
                  {seasonLabel(seasonEnum(s), lang)}
                  <CheckIcon />
                </span>
              ) : (
                <Link
                  key={s}
                  href={seasonHref(s, year, state)}
                  prefetch={false}
                  className={controls.opt}
                  onNavigate={() => onNavigate({ season: s, year })}
                >
                  {seasonLabel(seasonEnum(s), lang)}
                  <CheckIcon />
                </Link>
              ),
            )}
          </div>
        )}
      </MenuField>

      <MenuField
        menuKey="format"
        label={copy.format}
        value={state.format ? formatLabel(state.format, lang) : copy.any}
        isSet={Boolean(state.format)}
        open={menu === "format"}
        onToggle={toggle("format")}
        onClose={close}
        popup="listbox"
      >
        {({ labelId }) =>
          menu === "format" ? (
            <div className={controls.menu} role="listbox" aria-labelledby={labelId}>
              {["", ...FILTER_FORMATS].map((f) => (
                <button
                  key={f || "any"}
                  type="button"
                  role="option"
                  aria-selected={state.format === f}
                  className={controls.opt}
                  data-option={f || "any"}
                  onClick={() => {
                    onCommit({ ...state, format: f });
                    close();
                  }}
                >
                  {f ? formatLabel(f, lang) : copy.any}
                  <CheckIcon />
                </button>
              ))}
            </div>
          ) : null
        }
      </MenuField>

      <MoreFilters {...props} isSet={moreSet} onToggle={toggle("more")} onClose={close} />
    </div>
  );
}

interface MoreFiltersProps extends FilterBarProps {
  isSet: boolean;
  onToggle: () => void;
  onClose: () => void;
}

/** 更多筛选: the icon button and its panel of chip groups. */
function MoreFilters({ state, facets, menu, onCommit, lang, copy, isSet, onToggle, onClose }: MoreFiltersProps) {
  const open = menu === "more";
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || !open) return;
    e.stopPropagation();
    onClose();
    (e.currentTarget.querySelector("button") as HTMLButtonElement | null)?.focus({ preventScroll: true });
  };
  const status = (value: string) => onCommit({ ...state, status: state.status === value && value ? "" : value });
  const source = (value: SourceGroup | "") => onCommit({ ...state, source: state.source === value && value ? "" : value });
  const sequel = (value: SequelFilter) => onCommit({ ...state, seq: state.seq === value && value ? "" : value });

  return (
    <div className={controls.moreField} data-menu="more" data-field="more" onKeyDown={onKeyDown}>
      <button
        type="button"
        className={controls.moreBtn}
        aria-label={copy.more}
        aria-expanded={open}
        data-set={isSet ? "true" : undefined}
        onClick={onToggle}
      >
        <SlidersIcon />
      </button>
      {open ? (
        <div className={controls.extra} role="group" aria-label={copy.more}>
          <ChipGroup label={copy.status}>
            {["", ...FILTER_STATUSES].map((s) => (
              <Chip key={s || "all"} on={state.status === s} onPress={() => status(s)} value={s || "all"}>
                {s ? statusLabel(s, lang) : copy.all}
              </Chip>
            ))}
          </ChipGroup>
          {facets.source ? (
            <ChipGroup label={copy.source}>
              {(["", ...SOURCE_GROUPS] as const).map((g) => (
                <Chip key={g || "all"} on={state.source === g} onPress={() => source(g)} value={g || "all"}>
                  {g === "" ? copy.all : g === "OTHER" ? copy.sourceOther : (sourceLabel(g, lang) ?? g)}
                </Chip>
              ))}
            </ChipGroup>
          ) : null}
          {facets.sequel ? (
            <ChipGroup label={copy.sequel}>
              {(["", "new", "sequel"] as const).map((q) => (
                <Chip key={q || "all"} on={state.seq === q} onPress={() => sequel(q)} value={q || "all"}>
                  {q === "" ? copy.all : q === "new" ? copy.newOnly : copy.sequelOnly}
                </Chip>
              ))}
            </ChipGroup>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ChipGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={controls.extraGroup} role="group" aria-label={label}>
      <div className={controls.extraLabel} aria-hidden="true">
        {label}
      </div>
      <div className={controls.chips}>{children}</div>
    </div>
  );
}

function Chip({ on, onPress, value, children }: { on: boolean; onPress: () => void; value: string; children: ReactNode }) {
  return (
    <button type="button" className={controls.chip} aria-pressed={on} data-chip={value} onClick={onPress}>
      {children}
    </button>
  );
}
