"use client";

// The week's day tabs: a real tablist with roving tabindex. Arrow keys move
// along it (wrapping), Home/End jump to the ends, and selection follows focus —
// all seven days are already in the page, so switching costs nothing.
//
// Presentational: ScheduleBoard owns the selection and what a selection does
// (re-colour the page, reveal the pill in its row). Each tab controls its own
// panel; the panels are all rendered, inactive ones `hidden`.

import type { KeyboardEvent, RefObject } from "react";
import { nextTabIndex } from "@/components/anime/tabListNav";
import { fillTemplate } from "@/lib/home/time";
import type { ScheduleDayView } from "@/lib/schedule/viewModels";
import { useLang } from "@/lib/lang-client";
import { panelId, tabId } from "./ids";
import styles from "./DayTabs.module.css";

interface DayTabsProps {
  days: ScheduleDayView[];
  selected: number;
  /** `viaKeyboard` moves focus to the newly selected tab as well. */
  onSelect: (index: number, viaKeyboard: boolean) => void;
  rowRef: RefObject<HTMLDivElement | null>;
  tabRefs: RefObject<Array<HTMLButtonElement | null>>;
}

export default function DayTabs({ days, selected, onSelect, rowRef, tabRefs }: DayTabsProps) {
  const { t } = useLang();

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const next = nextTabIndex(e.key, selected, days.length);
    // null: not a tablist key. Returning before preventDefault keeps Tab
    // (and everything else) working.
    if (next === null) return;
    e.preventDefault();
    onSelect(next, true);
  }

  return (
    <div ref={rowRef} className={styles.tabs} role="tablist" aria-label={t("schedule.dayTabs")} onKeyDown={onKeyDown}>
      {days.map((d, i) => {
        const on = i === selected;
        return (
          <button
            key={d.key}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={tabId(i)}
            aria-selected={on}
            aria-controls={panelId(i)}
            aria-label={fillTemplate(t("schedule.dayCount"), { day: `${d.label} ${d.md}`, n: d.items.length })}
            tabIndex={on ? 0 : -1}
            className={styles.tab}
            data-today={d.isToday}
            onClick={() => onSelect(i, false)}
          >
            <span className={styles.text}>
              <span className={styles.label}>
                {d.isToday ? <span className={styles.todayDot} aria-hidden /> : null}
                {d.label}
              </span>
              <span className={styles.date}>{d.md}</span>
            </span>
            <span className={styles.count}>{d.items.length}</span>
          </button>
        );
      })}
    </div>
  );
}
