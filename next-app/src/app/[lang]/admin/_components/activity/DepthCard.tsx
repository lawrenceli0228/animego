// 近 N 天来过几天: how many distinct days each person active in the window
// came on. It shows what a single active-people figure cannot: how many of
// them came once, and how many of those came only on the day they signed up.
//
// Every row is a button that filters the user list below to that bucket
// (showUsersAtDepth: a window event the list listens for, then a scroll).

import {
  depthRows,
  formatCount,
  oneDayCount,
  showUsersAtDepth,
  type DepthLabel,
} from "@/lib/activityChart";
import { useLang } from "@/lib/lang-client";
import { fillTemplate, splitTemplate } from "@/lib/people/template";
import type { AdminActivityDepth } from "../../_types/activity";
import styles from "./activity.module.css";

type T = (key: string) => string;

/** The label printed in the row: 只来过 1 天 / 2 天 / 3–6 天. */
function rowLabel(label: DepthLabel, t: T): string {
  if (label.kind === "onlyOne") return t("admin.activity.depthOnlyOne");
  if (label.kind === "exact") return fillTemplate(t("admin.activity.depthDays"), { n: label.days });
  return fillTemplate(t("admin.activity.depthRange"), { min: label.min, max: label.max });
}

/** The same bucket inside a sentence, without the "only": 1 天 / 3–6 天. */
function rangeText(label: DepthLabel, t: T): string {
  return label.kind === "onlyOne" ? t("admin.activity.depthOneDay") : rowLabel(label, t);
}

export function DepthCard({ depth }: { depth: AdminActivityDepth }) {
  const { t } = useLang();
  const rows = depthRows(depth);
  const total = fillTemplate(t("admin.activity.depthTotal"), { n: formatCount(depth.total) });
  const [footBefore, footAfter] = splitTemplate(
    fillTemplate(t("admin.activity.depthFoot"), { one: formatCount(oneDayCount(depth)) }),
    "n",
  );

  return (
    <div className={styles.card} data-card="depth">
      <div className={styles.cardHead}>
        <span className={styles.cardTitle}>{fillTemplate(t("admin.activity.depthTitle"), { n: depth.days })}</span>
        <span className={styles.meta}>
          {depth.reconstructed ? fillTemplate(t("admin.activity.withReconstructed"), { text: total }) : total}
        </span>
      </div>
      <div className={styles.depthRows}>
        {rows.map((r) => (
          <button
            key={`${r.min}-${r.max}`}
            type="button"
            className={styles.depthRow}
            data-min={r.min}
            data-max={r.max}
            aria-label={fillTemplate(t("admin.activity.depthRowLabel"), {
              days: depth.days,
              range: rangeText(r.label, t),
              n: formatCount(r.count),
            })}
            onClick={() => showUsersAtDepth({ days: depth.days, min: r.min, max: r.max })}
          >
            <span>{rowLabel(r.label, t)}</span>
            <span className={styles.track}>
              <span className={styles.fill} style={{ width: `${r.barPct}%` }} />
            </span>
            <span className={styles.depthCount}>{formatCount(r.count)}</span>
            <span className={styles.depthShare}>{r.share}</span>
          </button>
        ))}
      </div>
      <div className={styles.sum}>
        <span>
          {footBefore}
          <b>{formatCount(depth.signupOnly)}</b>
          {footAfter}
        </span>
      </div>
    </div>
  );
}
