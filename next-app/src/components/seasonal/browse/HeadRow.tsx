"use client";

// The heading, the count of what is on show, and the bar chart beside them:
// weekdays while the season airs, premiere months otherwise. A bar is a
// filter: pressing it shows that day (or month) and sorts by time.

import { fillTemplate } from "@/lib/home/time";
import type { Lang } from "@/lib/i18n/lang";
import type { Bar, BarMode } from "@/lib/seasonal/bars";
import { monthLongLabel, monthShortLabel, weekdayLongLabel, weekdayShortLabel } from "@/lib/seasonal/display";
import type { BrowseCopy } from "./useBrowseCopy";
import frame from "./frame.module.css";

interface HeadRowProps {
  heading: string;
  count: number;
  bars: readonly Bar[];
  mode: BarMode;
  lang: Lang;
  copy: BrowseCopy;
  onBar: (bar: Bar) => void;
}

export default function HeadRow({ heading, count, bars, mode, lang, copy, onBar }: HeadRowProps) {
  const label = mode === "weekday" ? copy.barsAiring : copy.barsPremiere;
  return (
    <div className={frame.head}>
      <div className={frame.h1row}>
        <h1 className={frame.h1}>{heading}</h1>
        <span className={frame.count} data-count>
          {fillTemplate(copy.count, { n: count })}
        </span>
      </div>
      {bars.length > 0 ? (
        <div className={frame.bars} role="group" aria-label={label} data-bars data-mode={mode}>
          <span className={frame.barsLabel} aria-hidden="true">
            {label}
          </span>
          <div className={frame.barRow}>
            {bars.map((bar) => (
              <BarButton key={bar.kind === "weekday" ? bar.weekday : bar.key} bar={bar} lang={lang} copy={copy} onBar={onBar} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function barText(bar: Bar, lang: Lang, copy: BrowseCopy): { axis: string; aria: string } {
  if (bar.kind === "weekday") {
    const day = weekdayLongLabel(bar.weekday, lang);
    return {
      axis: weekdayShortLabel(bar.weekday, lang),
      aria: fillTemplate(bar.today ? copy.barToday : copy.barDay, { day, n: bar.count }),
    };
  }
  if (bar.month === null) {
    return { axis: copy.tbd, aria: fillTemplate(copy.barTbd, { n: bar.count }) };
  }
  return {
    axis: monthShortLabel(bar.month, lang),
    aria: fillTemplate(copy.barMonth, { month: monthLongLabel(bar.month, lang), n: bar.count }),
  };
}

function BarButton({ bar, lang, copy, onBar }: { bar: Bar; lang: Lang; copy: BrowseCopy; onBar: (bar: Bar) => void }) {
  const { axis, aria } = barText(bar, lang, copy);
  const weekday = bar.kind === "weekday";
  return (
    <button
      type="button"
      className={frame.bar}
      aria-pressed={bar.selected}
      aria-label={aria}
      disabled={weekday && bar.disabled}
      data-bar={weekday ? `wd-${bar.weekday}` : `mon-${bar.key}`}
      data-today={weekday && bar.today ? "true" : undefined}
      onClick={() => onBar(bar)}
    >
      <em className={frame.barCount} aria-hidden="true">
        {bar.count}
      </em>
      <span className={frame.barTrack} aria-hidden="true">
        <i className={frame.barFill} style={{ height: bar.heightPx, animationDelay: `${bar.delayMs}ms` }} />
      </span>
      <b className={frame.barLabel} aria-hidden="true">
        {axis}
      </b>
    </button>
  );
}
