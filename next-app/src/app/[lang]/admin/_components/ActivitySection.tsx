"use client";

// User activity, for the single /admin page.
//
// WHAT THIS BLOCK IS FOR. Everything else on this page counts things the site
// HAS: accounts, subscriptions, follows, cached titles. None of that is
// activity. A reader who visits every evening, browses the catalogue and posts
// nothing was, until migration 0025, indistinguishable from somebody who
// registered once and never came back — not because the query was hard but
// because nothing recorded it.
//
// THE ONE THING THIS COMPONENT MUST NOT DO is let its two reliability tiers
// blur into one another:
//
//   1. Everything after `instrumentedSince` — server-side, derived from a
//      signed access token on a real request. Unforgeable, and nothing a
//      browser sends can move it. Decide on these.
//   2. Everything before it — reconstructed by migration 0026 from whatever
//      other tables happened to witness. Interaction days, a strict and small
//      subset of real visits.
//
// So tier 2 gets its own bar treatment (hatched, half-opacity, named in the
// legend) AND a sentence under the chart. Blended into one line with no
// divider, the tier-2→tier-1 changeover looks like the product suddenly took
// off — and six months from now, having forgotten, we would read it that way.
//
// What this panel cannot show at all is logged-out readers, who are most of
// this site's traffic. Every number here is keyed on a user id. The lede says
// so out loud rather than leaving "DAU 41" to be read as a measurement of the
// whole site.
//
// Shape follows HantDriftSection: same section header, same StatCard grid,
// same card wells, same client-side refetch. This file picks words and
// colours; every judgement it makes is in @/lib/activityChart, unit-tested
// without a DOM.

import { useEffect, useState } from "react";
import {
  axisTickIndices,
  barHeightPct,
  formatRate,
  instrumentationSplit,
  seriesMax,
  shortDate,
} from "@/lib/activityChart";
import { useLang } from "@/lib/lang-client";
import type { AdminActivity, AdminActivityDay, AdminRetentionBucket } from "../_types";
import { StatCard } from "./StatCard";

/**
 * The two series colours, validated against this page's card surface
 * (#15151f) for the dark-mode lightness band, chroma floor, adjacent-pair CVD
 * separation, normal-vision separation and contrast. Do not substitute by eye.
 *
 * Chosen to sit apart from every other palette on this page — the enrichment
 * bar's #5ac8fa/#30d158/#ff9f0a/#ff453a, the synopsis tiers' #bf5af2/#2dd4bf,
 * the zh-Hant block's #a78bfa/#818cf8 — so no bar here reads as a slice of
 * one of those.
 *
 * Red is deliberately not in this block at all: this page reserves it for
 * alarms, and an activity chart has nothing to alarm about.
 */
const COLOR_ACTIVE = "#3d90dd";
const COLOR_SIGNUP = "#e0559b";

/**
 * The pre-instrumentation treatment: the same hue, half strength, plus a 45°
 * hatch.
 *
 * Same hue because it is the same measure, not a second series — a different
 * colour would say "two things", when what is true is "one thing, two grades
 * of evidence". The hatch is what keeps the distinction from resting on colour
 * alone, which matters for the reader who cannot see the opacity difference at
 * all.
 */
const HATCH_RECONSTRUCTED =
  "repeating-linear-gradient(45deg, rgba(61,144,221,0.55) 0 2px, rgba(61,144,221,0.12) 2px 5px)";

/** Selectable windows. Must stay inside the API's 7..90 clamp. */
const WINDOWS = [7, 30, 90] as const;

interface ActivitySectionProps {
  /** Null when the server-side fetch failed — see the error branch below. */
  initial: AdminActivity | null;
}

async function fetchActivity(days: number, signal: AbortSignal): Promise<AdminActivity | null> {
  // Same-origin browser fetch — nginx proxies /api/* to go-api in prod and
  // Next dev rewrites it in dev. The session cookie attaches automatically.
  const res = await fetch(`/api/admin/activity?days=${days}`, {
    cache: "no-store",
    signal,
    credentials: "same-origin",
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: AdminActivity };
  return body.data ?? null;
}

export function ActivitySection({ initial }: ActivitySectionProps) {
  const { t } = useLang();
  const [data, setData] = useState<AdminActivity | null>(initial);
  const [days, setDays] = useState<number>(initial?.days ?? 30);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The window the currently-held payload was fetched for. Compared against
  // `days` to decide whether a fetch is needed at all, so the server-rendered
  // payload does not trigger an immediate refetch of the same thing.
  const loadedDays = data?.days;

  // Standard fetch-effect shape: everything lives inside the effect and the
  // only dependency is the thing that should actually cause a refetch.
  //
  // The previous version hoisted this into a memoised callback whose deps
  // included `error` — which the fetch itself writes. One failure changed
  // `error`, which changed that callback's identity, which re-ran the effect and
  // fired a second request. It stopped at two only because React bails out of a
  // re-render when setState is handed the identical string; one word of drift in
  // the message and it would have been a retry loop against an endpoint that had
  // just told us it was in trouble.
  //
  // Every setState lives inside `run`, never synchronously in the effect body —
  // same shape and same reason as Navbar's auth probe: a synchronous setState in
  // an effect body triggers a cascading render, and react-hooks/set-state-in-effect
  // is a hard error under the lint ratchet rather than a warning.
  useEffect(() => {
    if (loadedDays === days) return;
    const ac = new AbortController();
    const run = async () => {
      setLoading(true);
      try {
        const result = await fetchActivity(days, ac.signal);
        if (ac.signal.aborted) return;
        if (result) {
          setData(result);
          setError(null);
        } else {
          setError(t("admin.activity.loadError"));
        }
      } catch {
        // An abort is a window change, not a failure; leave the message alone
        // so switching quickly does not flash an error.
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    };
    void run();
    return () => ac.abort();
  }, [days, loadedDays, t]);

  if (!data) {
    // Matches Overview's handling of a failed stats fetch: name the section,
    // say the numbers are missing, and do not fall back to zeroes. Zero here
    // reads as "nobody used the site", which is the worst available lie.
    return (
      <section id="activity" aria-labelledby="activity-heading" style={styles.section}>
        <h2 id="activity-heading" style={styles.sectionTitle}>
          {t("admin.activity.title")}
        </h2>
        <div style={styles.errorBox}>{error ?? t("admin.activity.loadError")}</div>
      </section>
    );
  }

  const split = instrumentationSplit(data.daily);

  return (
    <section id="activity" aria-labelledby="activity-heading" style={styles.section}>
      <header style={styles.header}>
        <h2 id="activity-heading" style={styles.sectionTitle}>
          {t("admin.activity.title")}
        </h2>
        <div style={styles.windowPicker} role="group" aria-label={t("admin.activity.windowLabel")}>
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setDays(w)}
              aria-pressed={days === w}
              style={days === w ? styles.windowBtnActive : styles.windowBtn}
            >
              {t("admin.activity.windowDays").replace("{{n}}", String(w))}
            </button>
          ))}
        </div>
      </header>

      {/*
        The lede is not decoration. Without it "DAU 41" reads as a complete
        measurement of the site, when in fact every number keyed on a user id
        is blind to the logged-out majority — which on a search-led catalogue
        is most of the traffic.
      */}
      <p style={styles.lede}>{t("admin.activity.lede")}</p>

      <div style={styles.grid}>
        <StatCard
          label={t("admin.activity.dau")}
          value={data.dau}
          hint={t("admin.activity.dauHint")}
        />
        <StatCard
          label={t("admin.activity.wau")}
          value={data.wau}
          hint={t("admin.activity.wauHint")}
        />
        <StatCard
          label={t("admin.activity.mau")}
          value={data.mau}
          hint={t("admin.activity.mauHint")}
        />
        <StatCard
          label={t("admin.activity.stickiness")}
          value={formatRate(data.stickiness)}
          hint={t("admin.activity.stickinessHint")}
        />
      </div>

      <div style={styles.card}>
        <div style={styles.cardHead}>
          <span>{t("admin.activity.trendTitle")}</span>
          <span style={styles.cardMeta} suppressHydrationWarning>
            {loading ? `${t("admin.activity.loading")} …` : data.timezone}
          </span>
        </div>

        <TrendChart points={data.daily} t={t} />

        {/*
          Named out loud rather than left to the legend swatch. A reader who
          does not know the seam exists will read the step at the boundary as
          growth — and it is the single most misleading thing this panel can
          show.
        */}
        {split.reconstructed > 0 ? (
          <p style={styles.seamNote}>
            {data.instrumentedSince
              ? t("admin.activity.seamNote")
                  .replace("{{date}}", data.instrumentedSince)
                  .replace("{{n}}", String(split.reconstructed))
              : t("admin.activity.notInstrumented")}
          </p>
        ) : null}
      </div>

      <RetentionCard retention={data.retention} t={t} />
    </section>
  );
}

/**
 * Two facets, one x-axis: people active per day, and signups per day beneath
 * it.
 *
 * They are stacked rather than overlaid because they share a unit (people) but
 * not a scale — at this size a day with three signups against a peak of forty
 * actives would be a bar one pixel tall, i.e. indistinguishable from zero. Two
 * facets each with their own baseline is the honest version; a second y-axis
 * on one chart is never the answer.
 *
 * Built from flex boxes rather than an SVG viewBox on purpose: the bars have
 * to stay crisp and their corner radii circular at any container width, and a
 * scaled viewBox turns a 3px radius into an ellipse and a 2px gap into
 * whatever the scale factor makes of it.
 */
function TrendChart({
  points,
  t,
}: {
  points: AdminActivityDay[];
  t: (key: string) => string;
}) {
  const activeMax = seriesMax(points.map((p) => p.activeUsers));
  const signupMax = seriesMax(points.map((p) => p.newUsers));
  const ticks = new Set(axisTickIndices(points.length));

  return (
    <div>
      <div style={styles.legend}>
        <LegendSwatch background={COLOR_ACTIVE} label={t("admin.activity.legendActive")} />
        <LegendSwatch background={HATCH_RECONSTRUCTED} label={t("admin.activity.legendReconstructed")} />
        <LegendSwatch background={COLOR_SIGNUP} label={t("admin.activity.legendSignups")} />
      </div>

      {/*
        role="img" with a summary label, because the bars themselves are
        decorative divs. The per-bar title attributes carry the exact figures
        for anyone who can hover; this is what the rest get.
      */}
      <div
        style={styles.plotActive}
        role="img"
        aria-label={t("admin.activity.chartAlt")
          .replace("{{n}}", String(points.length))
          .replace("{{max}}", String(activeMax))}
      >
        {points.map((p) => (
          <div key={p.date} style={styles.slot} title={barTitle(p, t)}>
            <div
              style={{
                ...styles.bar,
                height: `${barHeightPct(p.activeUsers, activeMax)}%`,
                background: p.instrumented ? COLOR_ACTIVE : HATCH_RECONSTRUCTED,
              }}
            />
          </div>
        ))}
      </div>

      <div style={styles.plotSignup} aria-hidden="true">
        {points.map((p) => (
          <div key={p.date} style={styles.slot} title={barTitle(p, t)}>
            <div
              style={{
                ...styles.bar,
                height: `${barHeightPct(p.newUsers, signupMax)}%`,
                background: COLOR_SIGNUP,
              }}
            />
          </div>
        ))}
      </div>

      <div style={styles.axis} aria-hidden="true">
        {points.map((p, i) => (
          <div key={p.date} style={styles.axisSlot}>
            {ticks.has(i) ? shortDate(p.date) : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The hover text for one day.
 *
 * Every figure the bar encodes plus the two it does not, so a reader who wants
 * the exact numbers never has to guess them off a bar height — which is the
 * trade that lets the axis carry only three date labels.
 */
function barTitle(p: AdminActivityDay, t: (key: string) => string): string {
  const lines = [
    p.date,
    `${t("admin.activity.dau")}: ${p.activeUsers}`,
    `${t("admin.activity.legendSignups")}: ${p.newUsers}`,
    `${t("admin.activity.logins")}: ${p.logins}`,
    `${t("admin.activity.requests")}: ${p.requests}`,
  ];
  if (!p.instrumented) lines.push(t("admin.activity.reconstructedDay"));
  return lines.join("\n");
}

function LegendSwatch({ background, label }: { background: string; label: string }) {
  return (
    <span style={styles.legendItem}>
      <span style={{ ...styles.legendSwatch, background }} />
      {label}
    </span>
  );
}

function RetentionCard({
  retention,
  t,
}: {
  retention: AdminActivity["retention"];
  t: (key: string) => string;
}) {
  if (!retention) {
    // Null means the query failed. Rendering zeroes would say "nobody ever
    // came back", which is a claim, not an absence.
    return (
      <div style={styles.card}>
        <div style={styles.cardHead}>
          <span>{t("admin.activity.retentionTitle")}</span>
        </div>
        <div style={styles.errorBox}>{t("admin.activity.retentionUnavailable")}</div>
      </div>
    );
  }

  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span>{t("admin.activity.retentionTitle")}</span>
        <span style={styles.cardMeta}>
          {t("admin.activity.retentionWindow").replace("{{n}}", String(retention.windowDays))}
        </span>
      </div>
      {/*
        Spelled out because the three denominators genuinely differ and the
        difference looks like a bug. Somebody who registered this morning has
        not failed to return tomorrow.
      */}
      <p style={styles.factNote}>{t("admin.activity.retentionNote")}</p>
      <div style={styles.retentionRow}>
        <RetentionCell
          label={t("admin.activity.retentionD1")}
          bucket={retention.d1}
          hint={t("admin.activity.retentionD1Hint")}
          t={t}
        />
        <RetentionCell
          label={t("admin.activity.retentionD7")}
          bucket={retention.d7}
          hint={t("admin.activity.retentionD7Hint")}
          t={t}
        />
        <RetentionCell
          label={t("admin.activity.retentionEver")}
          bucket={retention.ever}
          hint={t("admin.activity.retentionEverHint")}
          t={t}
        />
      </div>
    </div>
  );
}

/**
 * One horizon.
 *
 * The rate is the big number but the fraction underneath it is never optional:
 * a cohort here can be three people, and "33.3%" of three is a coin flip
 * wearing a decimal point.
 */
function RetentionCell({
  label,
  bucket,
  hint,
  t,
}: {
  label: string;
  bucket: AdminRetentionBucket;
  hint: string;
  t: (key: string) => string;
}) {
  return (
    <div style={styles.retentionCell}>
      <div style={styles.retentionLabel}>{label}</div>
      <div style={styles.retentionValue}>
        {bucket.cohort > 0 ? formatRate(bucket.rate) : t("admin.activity.noCohort")}
      </div>
      <div style={styles.retentionFraction}>
        {bucket.returned} / {bucket.cohort}
      </div>
      <div style={styles.retentionHint}>{hint}</div>
    </div>
  );
}

const btnBase: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 12,
  fontWeight: 600,
  borderRadius: 6,
  cursor: "pointer",
  border: "1px solid #2a2a38",
  background: "transparent",
  color: "#a8a8b8",
};

const plotBase: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 2,
  background: "#0e0e16",
  border: "1px solid #1f1f2a",
  borderRadius: 6,
  padding: "6px 6px 0",
};

const styles: Record<string, React.CSSProperties> = {
  section: { display: "flex", flexDirection: "column", gap: 14 },
  header: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "#a8a8b8",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    margin: 0,
  },
  windowPicker: { display: "flex", gap: 6 },
  windowBtn: btnBase,
  windowBtnActive: {
    ...btnBase,
    background: "rgba(61,144,221,0.14)",
    border: "1px solid rgba(61,144,221,0.45)",
    color: "#8cc2f0",
  },
  lede: {
    margin: 0,
    maxWidth: "68ch",
    fontSize: 13,
    lineHeight: 1.65,
    color: "#8c8c9c",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 16,
  },
  card: {
    padding: "18px 22px",
    background: "#15151f",
    border: "1px solid #1f1f2a",
    borderRadius: 10,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  cardHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 12,
    flexWrap: "wrap",
    fontSize: 13,
    color: "#a8a8b8",
  },
  cardMeta: { fontSize: 12, color: "#7c7c8c", fontFeatureSettings: '"tnum"' },
  legend: {
    display: "flex",
    flexWrap: "wrap",
    gap: 14,
    fontSize: 11.5,
    color: "#8c8c9c",
    marginBottom: 8,
  },
  legendItem: { display: "inline-flex", alignItems: "center", gap: 6 },
  legendSwatch: {
    display: "inline-block",
    width: 10,
    height: 10,
    borderRadius: 2,
  },
  plotActive: { ...plotBase, height: 132 },
  plotSignup: { ...plotBase, height: 34, marginTop: 4, borderRadius: 6 },
  slot: {
    flex: 1,
    height: "100%",
    display: "flex",
    alignItems: "flex-end",
    minWidth: 2,
  },
  bar: {
    width: "100%",
    // Rounded only at the data end, anchored to the baseline.
    borderRadius: "3px 3px 0 0",
    minHeight: 0,
    transition: "height 0.3s ease",
  },
  axis: {
    display: "flex",
    gap: 2,
    marginTop: 6,
    fontSize: 10.5,
    color: "#6f6f7e",
    fontFeatureSettings: '"tnum"',
  },
  axisSlot: {
    flex: 1,
    minWidth: 2,
    textAlign: "center",
    whiteSpace: "nowrap",
    overflow: "visible",
  },
  seamNote: {
    margin: 0,
    maxWidth: "72ch",
    fontSize: 11.5,
    lineHeight: 1.6,
    color: "#6f6f7e",
  },
  factNote: {
    margin: 0,
    maxWidth: "72ch",
    fontSize: 11.5,
    lineHeight: 1.6,
    color: "#6f6f7e",
  },
  emptyNote: { margin: 0, fontSize: 12.5, color: "#7c7c8c" },
  retentionRow: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 16,
  },
  retentionCell: {
    padding: "12px 14px",
    background: "#0e0e16",
    border: "1px solid #1f1f2a",
    borderRadius: 8,
  },
  retentionLabel: {
    fontSize: 11.5,
    color: "#9090a0",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  retentionValue: {
    fontSize: 24,
    fontWeight: 600,
    color: "#f4f4f8",
    fontFeatureSettings: '"tnum"',
  },
  retentionFraction: {
    marginTop: 2,
    fontSize: 12,
    color: "#8c8c9c",
    fontFeatureSettings: '"tnum"',
  },
  retentionHint: { marginTop: 6, fontSize: 11, lineHeight: 1.5, color: "#6f6f7e" },
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    textAlign: "left",
    padding: "6px 10px",
    fontSize: 11,
    fontWeight: 600,
    color: "#7c7c8c",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    borderBottom: "1px solid #1f1f2a",
  },
  thNum: { textAlign: "right" },
  td: {
    padding: "8px 10px",
    fontSize: 12.5,
    color: "#cfcfdc",
    borderBottom: "1px solid #1a1a24",
    verticalAlign: "middle",
  },
  tdNum: { textAlign: "right", fontFeatureSettings: '"tnum"', color: "#a8a8b8" },
  tdStrong: { color: "#f4f4f8", fontWeight: 600 },
  surfaceName: { marginBottom: 4 },
  surfaceBarTrack: {
    height: 4,
    borderRadius: 2,
    background: "#0e0e16",
    overflow: "hidden",
    maxWidth: 220,
  },
  surfaceBarFill: {
    height: "100%",
    borderRadius: 2,
    background: COLOR_ACTIVE,
  },
  errorBox: {
    background: "#3a0d0d",
    border: "1px solid #663030",
    color: "#ffb4b4",
    padding: "12px 14px",
    borderRadius: 6,
    fontSize: 13,
  },
};
