"use client";

// Under the filter bar: the season's two fixed tags, one removable tag per
// active filter and 清除全部; on the right the hue dots, the sort menu and the
// view toggles. On a phone only the tags and two view toggles stay — sort
// moves into the sheet, the hue dots into their own row.

import type { KeyboardEvent, ReactNode } from "react";
import { formatLabel, genreLabel, seasonLabel, sourceLabel, statusLabel } from "@/lib/contentLabels";
import type { HueFamilyKey } from "@/lib/home/hueFamilies";
import { fillTemplate } from "@/lib/home/time";
import type { Lang } from "@/lib/i18n/lang";
import { activeTags, type ActiveTag, type HueOption } from "@/lib/seasonal/browse";
import { monthLongLabel, weekdayLongLabel } from "@/lib/seasonal/display";
import { seasonEnum, type SeasonSlug } from "@/lib/seasonal/links";
import { MONTH_TBD, type BrowseState, type SortKey, type ViewKey } from "@/lib/seasonal/state";
import HueDots from "./HueDots";
import type { MenuKey } from "./MenuField";
import { ChartIcon, CheckIcon, CloseIcon, GridIcon, ListIcon, SortIcon, TagsIcon } from "./icons";
import type { BrowseCopy } from "./useBrowseCopy";
import controls from "./controls.module.css";
import tags from "./tags.module.css";

interface TagRowProps {
  state: BrowseState;
  season: SeasonSlug;
  year: number;
  hues: readonly HueOption[];
  sorts: readonly SortKey[];
  /** The view on screen — a phone draws the grid where the table was asked for. */
  view: ViewKey;
  menu: MenuKey | null;
  onMenu: (menu: MenuKey | null) => void;
  onRemove: (tag: ActiveTag) => void;
  onClear: () => void;
  onHue: (key: HueFamilyKey) => void;
  onSort: (sort: SortKey) => void;
  onView: (view: ViewKey) => void;
  lang: Lang;
  copy: BrowseCopy;
}

export function sortLabel(sort: SortKey, copy: BrowseCopy): string {
  switch (sort) {
    case "pop":
      return copy.sortPop;
    case "score":
      return copy.sortScore;
    case "fav":
      return copy.sortFav;
    case "next":
      return copy.sortNext;
    case "time":
      return copy.sortTime;
    case "start":
      return copy.sortStart;
    case "title":
      return copy.sortTitle;
  }
}

/** What a tag says, and what removing it is called. */
function tagText(tag: ActiveTag, lang: Lang, copy: BrowseCopy): { label: string; aria: string } {
  const remove = (label: string) => fillTemplate(copy.tagRemove, { label });
  switch (tag.kind) {
    case "q":
      return { label: fillTemplate(copy.tagSearch, { q: tag.value }), aria: copy.tagRemoveSearch };
    case "genre": {
      const label = genreLabel(tag.value, lang);
      return { label, aria: remove(label) };
    }
    case "format": {
      const label = formatLabel(tag.value, lang);
      return { label, aria: remove(label) };
    }
    case "status": {
      const label = statusLabel(tag.value, lang);
      return { label, aria: remove(label) };
    }
    case "source": {
      const label = tag.value === "OTHER" ? copy.sourceOther : (sourceLabel(tag.value, lang) ?? tag.value);
      return { label, aria: remove(label) };
    }
    case "seq": {
      const label = tag.value === "new" ? copy.newOnly : copy.sequelOnly;
      return { label, aria: remove(label) };
    }
    case "wd": {
      const label = fillTemplate(copy.tagWeekday, { day: weekdayLongLabel(tag.value, lang) });
      return { label, aria: remove(label) };
    }
    case "mon": {
      const label =
        tag.value === MONTH_TBD
          ? copy.tagTbd
          : fillTemplate(copy.tagMonth, { month: monthLongLabel(Number(tag.value.slice(5, 7)), lang) });
      return { label, aria: copy.tagRemoveMonth };
    }
    case "hue": {
      const label = copy.hueFamily[tag.value];
      return { label, aria: remove(label) };
    }
  }
}

export default function TagRow(props: TagRowProps) {
  const { state, season, year, hues, view, onRemove, onClear, onHue, onView, lang, copy } = props;
  const active = activeTags(state);

  return (
    <div className={tags.tags} data-tag-row>
      <div className={tags.tagsLeft}>
        <TagsIcon className={tags.tagIcon} />
        <span className={`${tags.tag} ${tags.tagFixed}`}>{year}</span>
        <span className={`${tags.tag} ${tags.tagFixed}`}>{seasonLabel(seasonEnum(season), lang)}</span>
        {active.map((tag) => {
          const { label, aria } = tagText(tag, lang, copy);
          return (
            <button
              key={`${tag.kind}:${tag.value}`}
              type="button"
              className={tags.tag}
              aria-label={aria}
              data-tag={tag.kind}
              onClick={() => onRemove(tag)}
            >
              {label}
              <CloseIcon />
            </button>
          );
        })}
        {active.length > 0 ? (
          <button type="button" className={`${tags.tag} ${tags.tagClear}`} data-clear-all onClick={onClear}>
            {copy.clearAll}
            <CloseIcon />
          </button>
        ) : null}
      </div>
      <div className={tags.tagsRight}>
        <HueDots options={hues} selected={state.hue} onPick={onHue} copy={copy} />
        <SortMenu {...props} />
        <div className={tags.views} role="group" aria-label={copy.views}>
          <ViewToggle view="grid" current={view} label={copy.viewGrid} onView={onView}>
            <GridIcon />
          </ViewToggle>
          <ViewToggle view="chart" current={view} label={copy.viewChart} onView={onView}>
            <ChartIcon />
          </ViewToggle>
          <ViewToggle view="table" current={view} label={copy.viewTable} onView={onView}>
            <ListIcon />
          </ViewToggle>
        </div>
      </div>
    </div>
  );
}

function ViewToggle({
  view,
  current,
  label,
  onView,
  children,
}: {
  view: ViewKey;
  current: ViewKey;
  label: string;
  onView: (view: ViewKey) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={tags.view}
      aria-label={label}
      aria-pressed={current === view}
      data-view-toggle={view}
      onClick={() => {
        if (current !== view) onView(view);
      }}
    >
      {children}
    </button>
  );
}

/** 排序: a trigger and a listbox of the sorts this season's data can answer. */
function SortMenu({ state, sorts, menu, onMenu, onSort, copy }: TagRowProps) {
  const open = menu === "sort";
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || !open) return;
    e.stopPropagation();
    onMenu(null);
    (e.currentTarget.querySelector("button") as HTMLButtonElement | null)?.focus({ preventScroll: true });
  };
  return (
    <div className={tags.sortWrap} data-menu="sort" onKeyDown={onKeyDown}>
      <button
        type="button"
        className={tags.sort}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${copy.sort}: ${sortLabel(state.sort, copy)}`}
        data-sort-trigger
        onClick={() => onMenu(open ? null : "sort")}
      >
        <SortIcon />
        {sortLabel(state.sort, copy)}
      </button>
      {open ? (
        <div className={`${controls.menu} ${controls.menuRight}`} role="listbox" aria-label={copy.sort}>
          {sorts.map((key) => (
            <button
              key={key}
              type="button"
              role="option"
              aria-selected={state.sort === key}
              className={controls.opt}
              data-sort={key}
              onClick={() => {
                onSort(key);
                onMenu(null);
              }}
            >
              {sortLabel(key, copy)}
              <CheckIcon />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
