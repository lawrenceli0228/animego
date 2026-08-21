"use client";

// Traditional-Chinese drift, for the single /admin page.
//
// What it is watching, in one breath: the river enrichment workers keep
// filling anime_cache's SIMPLIFIED columns; `title_hant` and
// `description_hant` only move when the backfill runs. So they fall behind and
// never self-heal — and the symptom is invisible from the outside, because the
// render ladder falls back rather than blanking. A row that is behind does not
// show an empty synopsis to a Traditional reader; it shows the SIMPLIFIED one,
// under a Traditional URL. "2 behind" means two anime are lying about what
// language they are in.
//
// There is a quarterly job as the automatic floor. This block exists to show
// the drift between runs and to let an operator run it sooner.
//
// Shape follows EnrichmentBar deliberately — same card, same coverage bar,
// same two-tier "big verdict + small facts" reading order, same Server-Action
// mutation path with an immediate refetch afterwards. Every judgement it makes
// is in @/lib/hantDrift or @/lib/backfillStatus, unit-tested without a DOM;
// this file picks colours and words.

import { useCallback, useEffect, useState, useTransition } from "react";
import type { HantDriftStats } from "../_types";
import { EnrichmentActionError } from "../_actions/_shared";
import { runHantBackfill } from "../_actions/hant-backfill";
import { coveragePct, formatCoveragePct, relativeAge } from "@/lib/backfillStatus";
import {
  hasDrift,
  isBackfillDisabled,
  machineConvertedTitles,
  pickHantInterval,
} from "@/lib/hantDrift";
import { StatCard } from "./StatCard";
import { useLang } from "@/lib/lang-client";

interface HantDriftSectionProps {
  /** Null when the server-side fetch failed — see the error branch below. */
  initial: HantDriftStats | null;
}

// Thousand separators at five-figure counts, with the locale pinned so the SSR
// render and the hydrated render agree. Node's default locale is not the
// browser's. Same choice, and the same reason, as EnrichmentBar's.
const fmt = (n: number): string => n.toLocaleString("en-US");

/**
 * How often the block re-reads the wall clock. Fires no request; it only
 * re-renders the "last run" age.
 *
 * pickHantInterval deliberately returns 0 once the job is idle, and idle is
 * this block's steady state. Without a local tick, `now` freezes at page load
 * and a tab left open keeps printing the age it had on arrival. 60s is coarse
 * enough that the "N 分钟前" text stays right and costs nothing.
 */
const CLOCK_TICK_MS = 60_000;

/**
 * Wording for the last-run age.
 *
 * All the arithmetic is relativeAge's, in @/lib/backfillStatus, where it is
 * unit-tested. This turns a {value, unit} into a sentence, and it is spelled
 * out per branch rather than looked up from a unit→key map because
 * locales/spaDictCoverage.test.ts finds missing dictionary entries by scanning
 * for literal `t("…")` call sites — a computed key is invisible to it, which
 * is exactly how `library.overflow.rescan` once shipped as visible UI text.
 *
 * It duplicates EnrichmentBar's formatAge, and that is the price of the
 * scanner: hoisting it into a shared module would move these four literal keys
 * into a file with no `useLang(` in it, where the scanner does not look, and
 * silently drop them out of coverage in all three dictionaries.
 */
function formatAge(
  t: (key: string) => string,
  at: string | null,
  now: Date,
): string {
  const rel = relativeAge(at, now);
  // null covers both "never ran" and a timestamp the runtime cannot parse.
  if (!rel) return t("admin.backfill.never");
  const n = String(rel.value);
  switch (rel.unit) {
    case "minute":
      return t("admin.backfill.ageMinutes").replace("{{n}}", n);
    case "hour":
      return t("admin.backfill.ageHours").replace("{{n}}", n);
    case "day":
      return t("admin.backfill.ageDays").replace("{{n}}", n);
    default:
      return t("admin.backfill.ageJustNow");
  }
}

interface EnvelopeResponse {
  data?: HantDriftStats;
}

async function fetchHantStats(
  signal: AbortSignal,
): Promise<HantDriftStats | null> {
  // Same-origin browser fetch — nginx proxies /api/* to go-api in prod and
  // Next dev rewrites it in dev. The session cookie attaches automatically.
  const res = await fetch("/api/admin/hant/stats", {
    cache: "no-store",
    signal,
    credentials: "same-origin",
  });
  if (!res.ok) return null;
  const body = (await res.json()) as EnvelopeResponse;
  return body.data ?? null;
}

export function HantDriftSection({ initial }: HantDriftSectionProps) {
  const { t } = useLang();
  const [stats, setStats] = useState<HantDriftStats | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // The clock the age is measured against. Held in state, not read as
  // `new Date()` during render: a render-time clock read is impure and gives
  // the SSR pass and the hydration pass different text for the same node.
  const [now, setNow] = useState(() => new Date());

  const running = stats?.running ?? false;

  // Reset the polling timer whenever `stats` changes, so the poller switches
  // itself off on the cycle that reports `running: false`.
  useEffect(() => {
    const interval = pickHantInterval(running);
    if (!interval) return;
    const ac = new AbortController();
    const id = window.setTimeout(async () => {
      try {
        const next = await fetchHantStats(ac.signal);
        if (next) {
          setStats(next);
          setError(null); // implicit clear on a successful refresh
        }
      } catch {
        // Network blip — swallow; the next tick retries.
      }
    }, interval);
    return () => {
      window.clearTimeout(id);
      ac.abort();
    };
  }, [stats, running]);

  // Advance the age clock independently of the fetch above, which stops
  // entirely while the job is idle. See CLOCK_TICK_MS.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const runNow = useCallback(() => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await runHantBackfill();
        // go-api's own sentence, verbatim — "already running" and "queued"
        // are different facts and both belong on screen.
        setNotice(result.message || t("admin.hant.enqueued"));
        // Refresh immediately so `running` flips without waiting for a tick.
        const ac = new AbortController();
        const next = await fetchHantStats(ac.signal);
        if (next) setStats(next);
      } catch (err) {
        setError(
          err instanceof EnrichmentActionError || err instanceof Error
            ? err.message
            : t("admin.loadError"),
        );
      }
    });
  }, [t]);

  if (!stats) {
    // Matches Overview's handling of a failed stats fetch: name the section,
    // say the numbers are missing, and do not pretend to zeroes. A zero here
    // is the all-clear, so rendering one on a failed fetch would be the worst
    // available lie.
    return (
      <section id="hant" aria-labelledby="hant-heading" style={styles.section}>
        <h2 id="hant-heading" style={styles.sectionTitle}>
          {t("admin.hant.title")}
        </h2>
        <div style={styles.errorBox}>{t("admin.hant.loadError")}</div>
      </section>
    );
  }

  const drift = hasDrift(stats);
  const titlePct = coveragePct(stats.titleHant, stats.total);
  const descPct = coveragePct(stats.descHant, stats.total);
  const machineTitles = machineConvertedTitles(stats.titleHant, stats.serpEligible);

  return (
    <section id="hant" aria-labelledby="hant-heading" style={styles.section}>
      <header style={styles.header}>
        <h2 id="hant-heading" style={styles.sectionTitle}>
          {t("admin.hant.title")}
        </h2>
        <span
          suppressHydrationWarning
          style={running ? styles.runningTag : styles.headerMeta}
        >
          {running
            ? `${t("admin.hant.runningNow")} …`
            : `${t("admin.hant.lastRun")} ${formatAge(t, stats.lastRunAt, now)}`}
        </span>
      </header>

      {/*
        The lede is not decoration. Without it, "落后 2" reads as "2 rows are
        missing text", which is the one reading that makes the number look
        harmless — the rows are not empty, they are serving the wrong language.
      */}
      <p style={styles.lede}>{t("admin.hant.lede")}</p>

      {/*
        The two numbers an operator actually reads to decide whether to act,
        given the same weight as the overview's own counters — same StatCard,
        same grid — and tinted when they are non-zero.
      */}
      <div style={styles.grid}>
        <StatCard
          label={t("admin.hant.titleBehind")}
          value={stats.titleBehind}
          hint={t("admin.hant.titleBehindHint")}
          tone={stats.titleBehind > 0 ? "warn" : "default"}
        />
        <StatCard
          label={t("admin.hant.descBehind")}
          value={stats.descBehind}
          hint={t("admin.hant.descBehindHint")}
          tone={stats.descBehind > 0 ? "warn" : "default"}
        />
      </div>

      <div style={styles.card}>
        {/*
          A zero needs saying out loud. Two grey zeroes with no sentence beside
          them read just as easily as "this panel is broken" — which is the
          same misreading in the opposite direction, and it trains an operator
          to distrust the block on exactly the days it is telling the truth.
        */}
        {drift ? null : (
          <div style={styles.inSync}>✓ {t("admin.hant.inSync")}</div>
        )}

        {/*
          Coverage, as context for the zeroes above. Both bars share one
          denominator (anime_cache), so unlike the two synopsis tiers in
          EnrichmentBar they really are two facets of one measurement — hence
          two shades of one hue rather than two unrelated colours.
        */}
        <div>
          <div style={styles.heading}>
            <span>{t("admin.hant.titlesRow")}</span>
            <span style={styles.headingMeta}>
              {fmt(stats.titleHant)} / {fmt(stats.total)} (
              {formatCoveragePct(titlePct)}%)
            </span>
          </div>
          <div
            style={styles.bar}
            role="img"
            aria-label={`${t("admin.hant.titlesRow")}: ${stats.titleHant}/${stats.total} (${formatCoveragePct(titlePct)}%)`}
          >
            <div style={{ ...styles.segTitle, width: `${titlePct}%` }} />
          </div>
          <div style={styles.facts}>
            <span>
              {t("admin.hant.serpEligible")}{" "}
              <strong style={styles.factNum}>{fmt(stats.serpEligible)}</strong>
            </span>
            <span>
              {t("admin.hant.machineConverted")}{" "}
              <strong style={styles.factNum}>{fmt(machineTitles)}</strong>
            </span>
          </div>
          {/*
            Spelled out because the gap between those two numbers is the one
            thing on this panel that looks like a bug and is not.
          */}
          <p style={styles.factNote}>{t("admin.hant.serpHint")}</p>
        </div>

        <div>
          <div style={styles.heading}>
            <span>{t("admin.hant.descsRow")}</span>
            <span style={styles.headingMeta}>
              {fmt(stats.descHant)} / {fmt(stats.total)} (
              {formatCoveragePct(descPct)}%)
            </span>
          </div>
          <div
            style={styles.bar}
            role="img"
            aria-label={`${t("admin.hant.descsRow")}: ${stats.descHant}/${stats.total} (${formatCoveragePct(descPct)}%)`}
          >
            <div style={{ ...styles.segDesc, width: `${descPct}%` }} />
          </div>
        </div>

        <div style={styles.actions}>
          <button
            type="button"
            style={
              isBackfillDisabled(running, pending)
                ? styles.btnPrimaryDisabled
                : styles.btnPrimary
            }
            disabled={isBackfillDisabled(running, pending)}
            onClick={runNow}
          >
            {running ? `${t("admin.hant.runningNow")} …` : t("admin.hant.runNow")}
          </button>
          {notice ? <span style={styles.notice}>{notice}</span> : null}
        </div>

        {error ? (
          <div role="alert" style={styles.error}>
            {error}
          </div>
        ) : null}
      </div>
    </section>
  );
}

// Two shades of one violet: the bars measure the same catalogue, so they must
// not read as two unrelated metrics. Distinct from the enrichment palette
// (#5ac8fa / #30d158 / #ff9f0a / #ff453a) and from the synopsis tiers
// (#bf5af2 / #2dd4bf) so no bar on the page reads as a slice of another.
const COLOR_TITLE = "#a78bfa";
const COLOR_DESC = "#818cf8";

const btnBase: React.CSSProperties = {
  padding: "8px 14px",
  fontSize: 13,
  borderRadius: 6,
  cursor: "pointer",
};
const segBase: React.CSSProperties = { transition: "width 0.4s ease" };

const styles: Record<string, React.CSSProperties> = {
  section: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
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
  headerMeta: {
    fontSize: 12,
    color: "#7c7c8c",
    fontFeatureSettings: '"tnum"',
  },
  runningTag: {
    fontSize: 12,
    color: COLOR_TITLE,
    fontWeight: 600,
    fontFeatureSettings: '"tnum"',
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
    padding: "20px 24px",
    background: "#15151f",
    border: "1px solid #1f1f2a",
    borderRadius: 10,
    display: "flex",
    flexDirection: "column",
    gap: 18,
  },
  inSync: {
    fontSize: 13,
    color: "#30d158",
  },
  heading: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    fontSize: 13,
    color: "#a8a8b8",
    gap: 12,
    flexWrap: "wrap",
    marginBottom: 8,
  },
  headingMeta: {
    fontSize: 12,
    color: "#7c7c8c",
    fontFeatureSettings: '"tnum"',
  },
  bar: {
    display: "flex",
    height: 10,
    borderRadius: 5,
    overflow: "hidden",
    background: "#0e0e16",
    border: "1px solid #1f1f2a",
  },
  segTitle: { ...segBase, background: COLOR_TITLE },
  segDesc: { ...segBase, background: COLOR_DESC },
  facts: {
    display: "flex",
    flexWrap: "wrap",
    gap: 16,
    fontSize: 12,
    color: "#8c8c9c",
    marginTop: 10,
  },
  factNum: {
    color: "#dcdce8",
    fontWeight: 600,
    fontFeatureSettings: '"tnum"',
  },
  factNote: {
    margin: "6px 0 0",
    maxWidth: "68ch",
    fontSize: 11.5,
    lineHeight: 1.6,
    color: "#6f6f7e",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  },
  notice: {
    fontSize: 12,
    color: "#8c8c9c",
  },
  btnPrimary: {
    ...btnBase,
    background: "#2f5fdf",
    color: "#fff",
    border: "1px solid #3a6eef",
    fontWeight: 500,
  },
  btnPrimaryDisabled: {
    ...btnBase,
    background: "#1a1a28",
    color: "#4a4a5a",
    border: "1px solid #2a2a38",
    fontWeight: 500,
    cursor: "not-allowed",
  },
  errorBox: {
    background: "#3a0d0d",
    border: "1px solid #663030",
    color: "#ffb4b4",
    padding: "12px 14px",
    borderRadius: 6,
    fontSize: 13,
  },
  error: {
    padding: "10px 12px",
    background: "#321515",
    border: "1px solid #5e2424",
    borderRadius: 6,
    color: "#ff8a8a",
    fontSize: 12,
  },
};
