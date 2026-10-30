// 每日活跃: one stacked bar per day — returning people at the bottom, people
// on their signup day on top — with a readout line that names the hovered or
// focused day.
//
// Three treatments keep the bars from lying:
//
//   - Today is not over. Its bar is half-strength with a dashed edge, it is
//     labelled 今天, and the readout never defaults to it: a half day next to
//     whole days reads as a collapse.
//   - Days before per-request recording were reconstructed from interaction
//     traces and undercount. They are hatched, named in the legend, and the
//     readout and the summary call them floors.
//   - The summary under the chart averages only the days that are over.
//
// Built from flex boxes rather than an SVG viewBox so bar corners and the gaps
// between bars stay crisp at any width.

import { useState, type CSSProperties } from "react";
import {
  calendarDay,
  clock08,
  dailySummary,
  formatCount,
  formatOneDecimal,
  monthDayDash,
  pctOf,
  readoutDefaultIndex,
  xAxisLabels,
  yScale,
} from "@/lib/activityChart";
import { useLang } from "@/lib/lang-client";
import { fillTemplate, splitTemplate } from "@/lib/people/template";
import type { AdminActivityDay, AdminActivityPanel } from "../../_types/activity";
import styles from "./activity.module.css";
import chart from "./DailyChart.module.css";
import {
  COLOR_RETURNING,
  COLOR_SIGNUP_DAY,
  HATCH_RETURNING,
  HATCH_SIGNUP_DAY,
  LIVE_STACK,
  LIVE_SWATCH,
  cx,
} from "./palette";

/** Above this many bars the gap between them narrows, so 90 days fit a phone. */
const DENSE_SERIES = 45;
const GAP_WIDE = 3;
const GAP_DENSE = 1;

type T = (key: string) => string;

/** "{{n}}" in `template` rendered bold, the way the canvas sets its numbers. */
function withBold(template: string, value: string) {
  const [before, after] = splitTemplate(template, "n");
  return (
    <>
      {before}
      <b>{value}</b>
      {after}
    </>
  );
}

function dateText(date: string, t: T): string {
  const c = calendarDay(date);
  return c ? fillTemplate(t("admin.activity.dateLabel"), { m: c.month, d: c.day }) : date;
}

function dayText(date: string, t: T): string {
  const c = calendarDay(date);
  if (!c) return date;
  const weekday = t("admin.activity.weekdays").split(",")[c.weekday] ?? "";
  return fillTemplate(t("admin.activity.dayLabel"), { date: dateText(date, t), wd: weekday });
}

function barLabel(p: AdminActivityDay, t: T): string {
  const main = fillTemplate(t("admin.activity.barLabel"), {
    date: dateText(p.date, t),
    total: formatCount(p.returning + p.signupDay),
    returning: formatCount(p.returning),
    signupDay: formatCount(p.signupDay),
  });
  return [
    main,
    p.partial ? t("admin.activity.barToday") : "",
    p.instrumented ? "" : t("admin.activity.barReconstructed"),
  ].join("");
}

export function DailyChart({ data }: { data: AdminActivityPanel }) {
  const { t } = useLang();
  // The picked day is kept by date, not index: a window switch replaces the
  // series, and a stale index would point at a different day.
  const [picked, setPicked] = useState<string | null>(null);

  const points = data.daily;
  const pickedIndex = picked === null ? -1 : points.findIndex((p) => p.date === picked);
  const shown = pickedIndex >= 0 ? pickedIndex : readoutDefaultIndex(points);
  const scale = yScale(Math.max(0, ...points.map((p) => p.returning + p.signupDay)));
  const labels = xAxisLabels(points);
  const summary = dailySummary(points);
  const anyReconstructed = points.some((p) => !p.instrumented);
  const gap = points.length > DENSE_SERIES ? GAP_DENSE : GAP_WIDE;

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardTitle}>{t("admin.activity.dailyTitle")}</span>
        <div className={styles.legend}>
          <Swatch style={{ background: COLOR_RETURNING }} label={t("admin.activity.legendReturning")} />
          <Swatch style={{ background: COLOR_SIGNUP_DAY }} label={t("admin.activity.legendSignupDay")} />
          <Swatch style={LIVE_SWATCH} label={t("admin.activity.legendToday")} />
          {anyReconstructed ? (
            <Swatch style={{ background: HATCH_RETURNING }} label={t("admin.activity.legendReconstructed")} />
          ) : null}
        </div>
      </div>

      {shown >= 0 ? <Readout point={points[shown]} data={data} t={t} /> : null}

      <div className={chart.chart}>
        <div className={chart.yAxis} aria-hidden="true">
          {scale.ticks.map((v) => (
            <span key={v} className={chart.yLabel} style={{ bottom: `${pctOf(v, scale.top)}%` }}>
              {formatCount(v)}
            </span>
          ))}
        </div>
        <div className={chart.plot}>
          {scale.ticks.map((v) => (
            <div
              key={v}
              className={cx(chart.gridLine, v === 0 && chart.gridLineZero)}
              style={{ bottom: `${pctOf(v, scale.top)}%` }}
            />
          ))}
          <div className={chart.cols} style={{ gap }}>
            {points.map((p, i) => {
              const total = p.returning + p.signupDay;
              const pick = () => setPicked(p.date);
              return (
                <button
                  key={p.date}
                  type="button"
                  className={cx(chart.col, i === shown && chart.colOn)}
                  aria-label={barLabel(p, t)}
                  data-date={p.date}
                  data-partial={p.partial ? "true" : undefined}
                  data-reconstructed={p.instrumented ? undefined : "true"}
                  onMouseEnter={pick}
                  onFocus={pick}
                  onClick={pick}
                >
                  <span
                    className={chart.stack}
                    style={{ height: `${pctOf(total, scale.top)}%`, ...(p.partial ? LIVE_STACK : null) }}
                  >
                    <span
                      className={chart.segment}
                      style={{
                        height: `${pctOf(p.signupDay, total)}%`,
                        background: p.instrumented ? COLOR_SIGNUP_DAY : HATCH_SIGNUP_DAY,
                      }}
                    />
                    <span
                      className={chart.segment}
                      style={{
                        height: `${pctOf(p.returning, total)}%`,
                        background: p.instrumented ? COLOR_RETURNING : HATCH_RETURNING,
                      }}
                    />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className={chart.xAxis} style={{ gap }} aria-hidden="true" data-axis="x">
        {points.map((p, i) => {
          const l = labels[i];
          return (
            <span key={p.date} className={chart.xLabel}>
              {l ? (l.kind === "today" ? t("admin.activity.today") : l.text) : ""}
            </span>
          );
        })}
      </div>

      {summary ? (
        <div className={styles.sum} data-summary="daily">
          <span>{withBold(t("admin.activity.sumAvgReturning"), formatOneDecimal(summary.avgReturning))}</span>
          <span>{withBold(t("admin.activity.sumAvgSignupDay"), formatOneDecimal(summary.avgSignupDay))}</span>
          <span>
            {withBold(
              fillTemplate(t("admin.activity.sumPeak"), { date: monthDayDash(summary.peak.date) }),
              formatCount(summary.peak.returning),
            )}
          </span>
          {summary.reconstructed ? <span>{t("admin.activity.sumReconstructed")}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function Swatch({ style, label }: { style: CSSProperties; label: string }) {
  return (
    <span className={styles.legendItem}>
      <span className={styles.swatch} style={style} />
      {label}
    </span>
  );
}

function Readout({ point, data, t }: { point: AdminActivityDay; data: AdminActivityPanel; t: T }) {
  const day = dayText(point.date, t);
  const title = point.partial
    ? fillTemplate(t("admin.activity.readoutToday"), { day, time: clock08(data.asOf)?.time ?? "—" })
    : day;
  const yesterday = data.todayActive.sameTimeYesterday;
  const lastWeek = data.todayActive.sameTimeLastWeek;
  return (
    <div className={chart.readout} aria-live="polite" data-readout={point.date}>
      <strong>{title}</strong>
      <span className={chart.readoutItem}>
        {withBold(t("admin.activity.readoutActive"), formatCount(point.returning + point.signupDay))}
      </span>
      <span className={chart.readoutItem}>
        <span className={styles.swatch} style={{ background: COLOR_RETURNING }} />
        {fillTemplate(t("admin.activity.readoutReturning"), { n: formatCount(point.returning) })}
      </span>
      <span className={chart.readoutItem}>
        <span className={styles.swatch} style={{ background: COLOR_SIGNUP_DAY }} />
        {fillTemplate(t("admin.activity.readoutSignupDay"), { n: formatCount(point.signupDay) })}
      </span>
      <span className={chart.readoutItem}>
        {fillTemplate(t("admin.activity.readoutRequests"), { n: formatCount(point.requests) })}
      </span>
      {point.partial ? (
        <span className={cx(chart.readoutItem, chart.readoutSameTime)}>
          {fillTemplate(t("admin.activity.sameTime"), {
            yesterday: yesterday === null ? "—" : formatCount(yesterday),
            lastWeek: lastWeek === null ? "—" : formatCount(lastWeek),
          })}
        </span>
      ) : null}
      {point.instrumented ? null : (
        <span className={chart.readoutItem}>{t("admin.activity.readoutReconstructed")}</span>
      )}
    </div>
  );
}
