// The four headline cards: today so far, returning people over 7 and 30 days,
// and signups over 30 days.
//
// Each card compares against a base of the same shape — today against the
// same moment yesterday (not against yesterday's whole day, which is the
// misreading the old DAU card invited), a window against the window of the
// same length right before it. These windows are fixed: the 7 / 30 / 90 picker
// changes the chart and the depth card, not these.
//
// A base that reaches back before per-request recording is a floor, so its
// line says so. A missing base (null) gets no delta at all rather than one
// computed against nothing.

import { clock08, formatCount, formatDelta, type Delta } from "@/lib/activityChart";
import { useLang } from "@/lib/lang-client";
import { fillTemplate } from "@/lib/people/template";
import type { AdminActivityPanel, AdminActivityWindow } from "../../_types/activity";
import styles from "./activity.module.css";
import { DELTA_COLOR } from "./palette";

interface Kpi {
  id: string;
  label: string;
  value: number;
  delta: Delta | null;
  base: string;
  hint: string;
}

export function KpiCards({ data }: { data: AdminActivityPanel }) {
  const { t } = useLang();
  const flat = t("admin.activity.deltaFlat");
  const time = clock08(data.asOf)?.time ?? "—";
  const markFloor = (text: string, floor: boolean) =>
    floor ? fillTemplate(t("admin.activity.withReconstructed"), { text }) : text;
  const count = (n: number | null) => (n === null ? "—" : formatCount(n));

  const today = data.todayActive;
  // Null means yesterday predates instrumentation (see the wire type), which
  // also makes yesterday's whole-day total a reconstruction.
  const yesterdayIsFloor = today.sameTimeYesterday === null;

  const returning = (w: AdminActivityWindow): Kpi => ({
    id: `returning-${w.days}`,
    label: fillTemplate(t("admin.activity.kpiReturning"), { n: w.days }),
    value: w.returning,
    delta: formatDelta(w.returning, w.prevReturning, flat),
    base: markFloor(
      fillTemplate(t("admin.activity.kpiPrev"), { n: w.days, count: formatCount(w.prevReturning) }),
      w.reconstructed || w.prevReconstructed,
    ),
    hint: markFloor(
      fillTemplate(t("admin.activity.kpiReturningHint"), {
        active: formatCount(w.active),
        signupOnly: formatCount(w.signupOnly),
      }),
      w.reconstructed,
    ),
  });

  const signups = data.signups30;
  const kpis: Kpi[] = [
    {
      id: "today",
      label: t("admin.activity.kpiToday"),
      value: today.active,
      delta: formatDelta(today.active, today.sameTimeYesterday, flat),
      base: fillTemplate(t("admin.activity.sameTime"), {
        yesterday: count(today.sameTimeYesterday),
        lastWeek: count(today.sameTimeLastWeek),
      }),
      hint: markFloor(
        fillTemplate(t("admin.activity.kpiTodayHint"), { time, total: formatCount(today.yesterdayTotal) }),
        yesterdayIsFloor,
      ),
    },
    returning(data.windows.d7),
    returning(data.windows.d30),
    {
      id: "signups",
      label: fillTemplate(t("admin.activity.kpiSignups"), { n: 30 }),
      value: signups.count,
      delta: formatDelta(signups.count, signups.prevCount, flat),
      // Signups are counted from accounts and never undercount; only the
      // "came back afterwards" figure can.
      base: fillTemplate(t("admin.activity.kpiPrev"), { n: 30, count: formatCount(signups.prevCount) }),
      hint: markFloor(
        fillTemplate(t("admin.activity.kpiSignupsHint"), { n: formatCount(signups.returnedAfter) }),
        signups.reconstructed,
      ),
    },
  ];

  return (
    <div className={styles.grid}>
      {kpis.map((k) => (
        <div key={k.id} className={styles.stat} data-kpi={k.id}>
          <div className={styles.statLabel}>{k.label}</div>
          <div className={styles.kpiTop}>
            <span className={styles.statValue}>{formatCount(k.value)}</span>
            {k.delta ? (
              <span className={styles.delta} data-delta={k.delta.kind} style={{ color: DELTA_COLOR[k.delta.kind] }}>
                {k.delta.text}
              </span>
            ) : null}
          </div>
          <div className={styles.kpiBase}>{k.base}</div>
          <div className={styles.kpiHint}>{k.hint}</div>
        </div>
      ))}
    </div>
  );
}
