"use client";

// User activity, for the single /admin page.
//
// Everything else on the page counts things the site HAS — accounts,
// subscriptions, cached titles. This panel is the only one about whether
// people come back, so it is built around the two ways such numbers mislead:
//
//   1. A count of everyone active in a window mixes in signups: people who
//      registered and never came back are active on exactly one day, their
//      signup day, and a signup wave reads as engagement. So the headline
//      cards count RETURNING people (active on a day other than their signup
//      day) and say how many came only that once.
//   2. Part of the history was reconstructed (migration 0026) from what other
//      tables happened to witness, and undercounts real visits. Anything that
//      reaches back before per-request recording is marked as a floor —
//      hatched in the chart and the cohort table, "含回推" in text.
//
// Every number is keyed on a signed-in user, so logged-out readers are not in
// it at all; the meta line says so. Definitions: admin/_types/activity.ts.
// Arithmetic: @/lib/activityChart, unit-tested without a DOM. This file owns
// the fetch and the layout; the four parts live in ./activity/.

import { useEffect, useState } from "react";
import { clock08, isActivityPanel } from "@/lib/activityChart";
import { useLang } from "@/lib/lang-client";
import { fillTemplate } from "@/lib/people/template";
import type { AdminActivityPanel } from "../_types/activity";
import { CohortCard } from "./activity/CohortCard";
import { DailyChart } from "./activity/DailyChart";
import { DepthCard } from "./activity/DepthCard";
import { KpiCards } from "./activity/KpiCards";
import styles from "./activity/activity.module.css";

/** Selectable windows. Must stay inside the API's 7..90 clamp. */
const WINDOWS = [7, 30, 90] as const;
const DEFAULT_WINDOW = 30;

interface ActivitySectionProps {
  /** Null when the server-side fetch failed — see the error branch below. */
  initial: AdminActivityPanel | null;
}

/** Null on any failure: a non-2xx, a body that is not JSON, or the wrong shape. */
async function fetchActivity(days: number, signal: AbortSignal): Promise<AdminActivityPanel | null> {
  // Same-origin browser fetch — nginx proxies /api/* to go-api in prod and
  // Next dev rewrites it in dev. The session cookie attaches automatically.
  const res = await fetch(`/api/admin/activity?days=${days}`, {
    cache: "no-store",
    signal,
    credentials: "same-origin",
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: unknown };
  return isActivityPanel(body.data) ? body.data : null;
}

export function ActivitySection({ initial }: ActivitySectionProps) {
  const { t } = useLang();
  const [data, setData] = useState<AdminActivityPanel | null>(() => (isActivityPanel(initial) ? initial : null));
  const [days, setDays] = useState<number>(() => (isActivityPanel(initial) ? initial.days : DEFAULT_WINDOW));
  // The window whose fetch failed, while the panel keeps showing the last
  // good one. Null when nothing has failed since the last success.
  const [failedDays, setFailedDays] = useState<number | null>(null);
  // The window the payload on screen was fetched for. Compared against `days`
  // so the server-rendered payload does not trigger a refetch of itself.
  const loadedDays = data?.days;
  // Derived, never stored. The effect below has a request out exactly while
  // the picker and the payload disagree: a success makes them agree, and so
  // does a failure, which puts the picker back. A stored flag needed the
  // request to clear it, and a request superseded by a switch straight back
  // (30 → 90 → 30) is aborted and never reports, so "加载中…" stayed for good.
  // With no payload at all only the error box is drawn, so nothing reads it.
  const loading = data !== null && days !== loadedDays;

  // Standard fetch-effect shape: everything lives inside the effect and the
  // only dependencies are the things that should cause a refetch. Every
  // setState happens inside `run`, never synchronously in the effect body
  // (react-hooks/set-state-in-effect is a hard error under the lint ratchet).
  useEffect(() => {
    if (loadedDays === days) return;
    const ac = new AbortController();
    const run = async () => {
      let result: AdminActivityPanel | null = null;
      try {
        result = await fetchActivity(days, ac.signal);
      } catch {
        // A network error or an unreadable body: handled as a failure below.
        // An abort lands here too, and is ignored there — it is a newer
        // window (or an unmount) taking over, not a failure.
      }
      if (ac.signal.aborted) return;
      if (result) {
        setData(result);
        setFailedDays(null);
      } else {
        setFailedDays(days);
        // Put the picker back on the window that is actually on screen, so a
        // failed switch to 90 days never sits under 30 days of bars. Clicking
        // the failed window again retries.
        if (loadedDays !== undefined) setDays(loadedDays);
      }
    };
    void run();
    return () => ac.abort();
  }, [days, loadedDays]);

  if (!data) {
    // A failed fetch is never rendered as zeroes. Zero here reads as "nobody
    // used the site", which is the worst available lie.
    return (
      <section id="activity" aria-labelledby="activity-heading" className={styles.section}>
        <h2 id="activity-heading" className={styles.sectionTitle}>
          {t("admin.activity.title")}
        </h2>
        <div className={styles.errorBox}>{t("admin.activity.loadError")}</div>
      </section>
    );
  }

  // HH:mm only. The snapshot and `today` come from one transaction, so the
  // snapshot's date is always the payload's today and printing it adds nothing.
  const asOf = clock08(data.asOf)?.time ?? data.asOf;

  return (
    <section id="activity" aria-labelledby="activity-heading" aria-busy={loading} className={styles.section}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <h2 id="activity-heading" className={styles.sectionTitle}>
            {t("admin.activity.title")}
          </h2>
          <div className={styles.meta}>
            {fillTemplate(t("admin.activity.meta"), { asOf })}
            {loading ? ` · ${t("admin.activity.loading")}…` : null}
          </div>
        </div>
        <div className={styles.windowPicker} role="group" aria-label={t("admin.activity.windowLabel")}>
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={styles.windowBtn}
              aria-pressed={days === w}
              onClick={() => setDays(w)}
            >
              {fillTemplate(t("admin.activity.windowDays"), { n: w })}
            </button>
          ))}
        </div>
      </div>

      {failedDays !== null ? (
        <div className={styles.errorBox} role="alert">
          {fillTemplate(t("admin.activity.switchError"), { n: failedDays, m: data.days })}
        </div>
      ) : null}

      <KpiCards data={data} />
      <DailyChart data={data} />
      <div className={styles.two}>
        <DepthCard depth={data.depth} />
        <CohortCard cohorts={data.cohorts} instrumentedSince={data.instrumentedSince} />
      </div>
    </section>
  );
}
