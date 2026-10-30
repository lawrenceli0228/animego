// 新用户留存 · 按注册周: for each of the last ten signup weeks, how many came
// back within 1 / 7 / 14 / 30 days of signing up.
//
// The rule this table exists to keep: a rate is printed only for a horizon
// that is over for every member of the week (`eligible`). Until then the
// count is still growing, and a rate would be read as a result — the first
// open horizon shows "已 N 人" in a dashed cell instead, later ones a dash.
// cohortCells() decides; this file only draws.
//
// Weeks whose earliest possible return predates per-request recording are
// hatched: their returns were reconstructed and are floors.

import {
  COHORT_HORIZONS,
  cohortCells,
  cohortShade,
  cohortWeekLabel,
  formatCount,
  formatPercent,
  monthDayDash,
  monthDaySlash,
  type CohortCell,
  type CohortHorizonDays,
} from "@/lib/activityChart";
import { useLang } from "@/lib/lang-client";
import { fillTemplate } from "@/lib/people/template";
import type { AdminCohortWeek } from "../../_types/activity";
import styles from "./activity.module.css";
import { HATCH_CELL, PENDING_BORDER, cellShade, cx } from "./palette";

type T = (key: string) => string;

function horizonLabel(days: CohortHorizonDays, t: T): string {
  return days === 1
    ? t("admin.activity.cohortNextDay")
    : fillTemplate(t("admin.activity.cohortWithin"), { n: days });
}

interface CohortCardProps {
  cohorts: AdminCohortWeek[];
  instrumentedSince: string | null;
}

export function CohortCard({ cohorts, instrumentedSince }: CohortCardProps) {
  const { t } = useLang();
  const rows = cohorts.map((week) => ({ week, cells: cohortCells(week) }));
  const anyPending = rows.some((r) => r.cells.some((c) => c.state === "pending"));
  const anyReconstructed = cohorts.some((w) => w.reconstructed);
  const seam = instrumentedSince ? monthDayDash(instrumentedSince) : null;
  const floorNote = seam
    ? fillTemplate(t("admin.activity.cohortCellReconstructed"), { date: seam })
    : t("admin.activity.cohortCellReconstructedAll");

  return (
    <div className={styles.card} data-card="cohorts">
      <div className={styles.cardHead}>
        <span className={styles.cardTitle}>{t("admin.activity.cohortTitle")}</span>
        <span className={styles.meta}>{t("admin.activity.cohortMeta")}</span>
      </div>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={cx(styles.th, styles.thLeft)}>
                {t("admin.activity.cohortWeek")}
              </th>
              <th scope="col" className={cx(styles.th, styles.thRight)}>
                {t("admin.activity.cohortSignups")}
              </th>
              {COHORT_HORIZONS.map((h) => (
                <th key={h} scope="col" className={styles.th}>
                  {horizonLabel(h, t)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ week, cells }) => (
              <tr
                key={week.weekStart}
                data-week={week.weekStart}
                data-reconstructed={week.reconstructed ? "true" : undefined}
              >
                <th scope="row" className={styles.week}>
                  {cohortWeekLabel(week.weekStart)}
                </th>
                <td className={styles.signups}>{formatCount(week.signups)}</td>
                {cells.map((cell) => (
                  <Cell key={cell.days} cell={cell} week={week} floorNote={floorNote} t={t} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {anyPending || anyReconstructed ? (
        <div className={styles.legend}>
          {anyPending ? (
            <span className={styles.legendItem}>
              <span className={styles.legendBox} style={{ border: PENDING_BORDER }} />
              {t("admin.activity.cohortLegendPending")}
            </span>
          ) : null}
          {anyReconstructed ? (
            <span className={styles.legendItem}>
              <span
                className={styles.legendBox}
                style={{ backgroundColor: "rgba(61,144,221,0.2)", backgroundImage: HATCH_CELL }}
              />
              {seam
                ? fillTemplate(t("admin.activity.cohortLegendReconstructed"), { date: seam })
                : t("admin.activity.cohortLegendReconstructedAll")}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface CellProps {
  cell: CohortCell;
  week: AdminCohortWeek;
  floorNote: string;
  t: T;
}

function Cell({ cell, week, floorNote, t }: CellProps) {
  const hatch = week.reconstructed ? HATCH_CELL : undefined;

  if (cell.state === "eligible") {
    const title =
      fillTemplate(t("admin.activity.cohortCellTitle"), {
        week: monthDaySlash(week.weekStart),
        signups: formatCount(week.signups),
        returned: formatCount(cell.returned),
        horizon: horizonLabel(cell.days, t),
      }) + (week.reconstructed ? floorNote : "");
    return (
      <td
        className={styles.cell}
        data-state="eligible"
        title={title}
        style={{ backgroundColor: cellShade(cohortShade(cell.rate)), backgroundImage: hatch }}
      >
        <span className={styles.cellRate}>{formatPercent(cell.rate)}</span>
        <span className={styles.cellCount}>
          {fillTemplate(t("admin.activity.cohortCount"), { n: formatCount(cell.returned) })}
        </span>
      </td>
    );
  }

  if (cell.state === "pending") {
    return (
      <td
        className={cx(styles.cell, styles.cellPending)}
        data-state="pending"
        title={fillTemplate(t("admin.activity.cohortPendingTitle"), { n: cell.days })}
        style={{ border: PENDING_BORDER, backgroundImage: hatch }}
      >
        {fillTemplate(t("admin.activity.cohortPending"), { n: formatCount(cell.returned) })}
      </td>
    );
  }

  return (
    <td
      className={cx(styles.cell, styles.cellNone)}
      data-state="none"
      title={week.signups > 0 ? t("admin.activity.cohortNoneTitle") : t("admin.activity.cohortEmptyTitle")}
    >
      —
    </td>
  );
}
