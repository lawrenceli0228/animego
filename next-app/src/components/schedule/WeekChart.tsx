"use client";

// 本周更新 — the week as seven bars. Pressing one selects its day, exactly
// like its tab: the list, the page colour and the tab row follow. Heights are
// against the week's busiest day (lib/schedule/week.ts barHeight).

import type { CSSProperties } from "react";
import { fillTemplate } from "@/lib/home/time";
import { barHeight } from "@/lib/schedule/week";
import type { ScheduleDayView } from "@/lib/schedule/viewModels";
import { useLang } from "@/lib/lang-client";
import { panelId } from "./ids";
import aside from "./aside.module.css";
import styles from "./WeekChart.module.css";

interface WeekChartProps {
  days: ScheduleDayView[];
  selected: number;
  onSelect: (index: number) => void;
}

export default function WeekChart({ days, selected, onSelect }: WeekChartProps) {
  const { t } = useLang();
  const max = Math.max(0, ...days.map((d) => d.items.length));

  return (
    <section className={`${aside.box} ${styles.chart}`} aria-labelledby="schedule-week">
      <div className={aside.head}>
        <h3 id="schedule-week" className={aside.title}>
          {t("home.thisWeek")}
        </h3>
        <span className={styles.hint} aria-hidden>
          {t("schedule.chartHint")}
        </span>
      </div>
      <div className={styles.bars} role="group" aria-labelledby="schedule-week">
        {days.map((d, i) => (
          <button
            key={d.key}
            type="button"
            className={styles.bar}
            aria-pressed={i === selected}
            aria-controls={panelId(i)}
            aria-label={fillTemplate(t("schedule.dayCount"), { day: `${d.label} ${d.md}`, n: d.items.length })}
            onClick={() => onSelect(i)}
          >
            <span className={styles.count}>{d.items.length}</span>
            <span
              className={styles.fill}
              style={{ "--bar-h": `${barHeight(d.items.length, max)}px` } as CSSProperties}
            />
            <span className={styles.day}>{d.short}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
