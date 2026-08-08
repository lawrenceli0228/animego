"use client";

// EnrichmentBar — ports `client/src/pages/AdminDashboard.jsx:148-237`
// (legacy SPA) to a Next 16 Client Component. State here is genuinely
// client-only: polling cadence depends on live queue counters and the
// V3 striped progress animation only makes sense in the browser.
//
// Mutations go through Server Actions in ../_actions/enrichment-queue.ts
// — no React Query. revalidatePath("/admin") inside each action keeps
// the RSC StatCard grid (rendered by the parent page) in sync after
// the next navigation, while in-page polling drives this bar's UI.

import { useCallback, useEffect, useState, useTransition } from "react";
import type {
  AdminStats,
  BackfillQueue,
  DescriptionCnLlmStats,
  DescriptionCnStats,
} from "../_types";
import { EnrichmentActionError } from "../_actions/_shared";
import {
  healCn,
  pauseHealCn,
  reEnrich,
  resumeHealCn,
} from "../_actions/enrichment-queue";
import {
  BACKFILL_POLL_MS,
  backfillHealth,
  coveragePct,
  formatCoveragePct,
  heartbeatState,
  ineligibleCount,
  relativeAge,
  writeHeartbeatState,
  type HeartbeatState,
} from "@/lib/backfillStatus";
import { useLang } from "@/lib/lang-client";

interface EnrichmentBarProps {
  initial: AdminStats;
}

// Rolling deploys can serve a stats payload from a go-api that predates
// these fields. Render zeroes rather than throwing on `.done` of
// undefined — a stale shape must not take the whole /admin page down.
const NO_DESCRIPTION_CN: DescriptionCnStats = {
  eligible: 0,
  done: 0,
  rejected: 0,
  pending: 0,
};
const NO_BACKFILL_QUEUE: BackfillQueue = {
  queued: 0,
  retrying: 0,
  discarded: 0,
  lastScanAt: null,
  lastWriteAt: null,
};
const NO_DESCRIPTION_CN_LLM: DescriptionCnLlmStats = {
  remit: 0,
  done: 0,
  rejected: 0,
  pending: 0,
};

/**
 * Polling cadence. The first three rules are ported verbatim from
 * useAdmin.js:12-20; returns 0 when no polling is needed (idle).
 *
 * Exported for unit test — every cadence decision in the panel lives
 * here, and it is the one piece of this component worth pinning down.
 */
export function pickInterval(stats: AdminStats): number {
  const q = stats.queue;
  const prog = q.v3Progress;
  if (prog && prog.total > 0 && prog.processed < prog.total && !prog.paused) {
    return 2000;
  }
  if (q.phase1 + q.phase4 + q.v3 > 0) return 5000;
  // Description backfill gets its own, much slower tier. The sweep is
  // perpetual: on the first pass its queue stays non-empty for ~31h, so
  // borrowing the 5s tier above would be 22,320 requests for a number
  // that moves a few rows an hour. Checked last on purpose — a live
  // enrichment run still claims the 2s/5s tiers.
  //
  // `discarded` is deliberately excluded: those jobs are terminal, they
  // are an alarm to look at, not work that will change the counters.
  const backfill = q.descriptionBackfill;
  if (backfill && backfill.queued + backfill.retrying > 0) return BACKFILL_POLL_MS;
  return 0;
}

// Thousand separators at five-figure counts. The locale is pinned so the
// server render and the hydrated render agree — Node's default locale is
// not the browser's.
const fmt = (n: number): string => n.toLocaleString("en-US");

/**
 * How often the block re-reads the wall clock. Not a poller — it fires no
 * request; it only re-renders the two heartbeat ages.
 *
 * It exists because pickInterval deliberately returns 0 once every queue
 * is empty (the design's "全空 → 0"), and empty is the steady state of a
 * perpetual sweep. Without a clock tick, `now` freezes at page load, so a
 * tab left open on /admin keeps printing "上次扫描 8 分钟前 ✓" hours after
 * the scan died — the panel's own liveness signal frozen in the healthy
 * position, which is the exact failure this block was built to prevent.
 *
 * Ticking locally makes a stale heartbeat cross its threshold on its own,
 * at zero cost to the 337ms stats endpoint. It errs toward a false ⚠ (a
 * page nobody has refreshed in two hours flags itself) rather than a false
 * ✓, which is the correct direction for an alarm.
 *
 * 60s is well under the 2h stale budget, so the flip is never late enough
 * to matter, and it is coarse enough that the "N 分钟前" text stays right.
 */
const CLOCK_TICK_MS = 60_000;

/**
 * Wording for a heartbeat's age.
 *
 * All the arithmetic — bucketing, flooring, clamping a future timestamp,
 * "never" for a null or unparseable value — is relativeAge's, in
 * @/lib/backfillStatus, where it is unit-tested. The *verdict* on the age
 * (fresh / stale / never, and whether to warn) is heartbeatState's. This
 * function only turns a {value, unit} into a sentence, and it has to live
 * here because that is the one part the two dictionaries disagree about
 * ("8 分钟前" vs "8m ago").
 *
 * The keys are spelled out literally in each branch rather than looked up
 * from a unit→key map: locales/spaDictCoverage.test.ts finds missing
 * dictionary entries by scanning for literal `t("…")` call sites, and a
 * computed key is invisible to it — which is precisely how
 * `library.overflow.rescan` once shipped as visible UI text.
 */
function formatAge(
  t: (key: string) => string,
  at: string | null,
  now: Date,
): string {
  const rel = relativeAge(at, now);
  // null covers both "never ran" and a timestamp the runtime cannot
  // parse; relativeAge and heartbeatState agree on that, so the text and
  // the ⚠ can never disagree about whether a heartbeat exists.
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

/**
 * The glyph for one heartbeat verdict.
 *
 * ✓ is only printed for `fresh` — a heartbeat with a timestamp inside its
 * budget. `never` and a quiet-but-stale write heartbeat get nothing: the
 * panel has no evidence to tick, and "从未 ✓" reassures about the one
 * state that has produced no proof of anything. Absence of an alarm is not
 * the same claim as an all-clear, and only one of them is true here.
 */
function glyph(state: HeartbeatState): string {
  if (state.warn) return "⚠";
  return state.kind === "fresh" ? "✓" : "";
}

interface EnvelopeResponse {
  data?: AdminStats;
}

async function fetchStats(signal: AbortSignal): Promise<AdminStats | null> {
  // Same-origin browser fetch — nginx proxies /api/* to go-api in prod
  // and Next dev rewrites it in dev. The session cookie attaches
  // automatically, matching how legacy axiosClient was wired.
  const res = await fetch("/api/admin/stats", {
    cache: "no-store",
    signal,
    credentials: "same-origin",
  });
  if (!res.ok) return null;
  const body = (await res.json()) as EnvelopeResponse;
  return body.data ?? null;
}

export function EnrichmentBar({ initial }: EnrichmentBarProps) {
  const { t } = useLang();
  const [stats, setStats] = useState<AdminStats>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // The clock the two heartbeat ages are measured against. Held in state,
  // not read as `new Date()` during render: a render-time clock read is
  // impure, gives the SSR pass and the hydration pass different text for
  // the same node, and — worse — only advances when something else
  // happens to re-render. See CLOCK_TICK_MS.
  const [now, setNow] = useState(() => new Date());

  // Reset the polling timer every time `stats` changes — the legacy
  // React Query refetchInterval re-evaluates on each cycle, so a state
  // change (e.g. queue drains to zero) flips polling off mid-cycle.
  useEffect(() => {
    const interval = pickInterval(stats);
    if (!interval) return;
    const ac = new AbortController();
    const id = window.setTimeout(async () => {
      try {
        const next = await fetchStats(ac.signal);
        if (next) {
          setStats(next);
          setError(null); // implicit clear on successful refresh
        }
      } catch {
        // Network blip — swallow; next tick retries.
      }
    }, interval);
    return () => {
      window.clearTimeout(id);
      ac.abort();
    };
  }, [stats]);

  // Advance the heartbeat clock independently of the fetch above, which
  // stops entirely when the queues drain. No dependency on `stats`, so it
  // survives every poll and keeps ticking on an idle page.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const runAction = useCallback(
    (label: string, fn: () => Promise<unknown>) => {
      setError(null);
      startTransition(async () => {
        try {
          await fn();
          // Refresh stats immediately so the bar reflects the new
          // queue state without waiting for the next polling tick.
          const ac = new AbortController();
          const next = await fetchStats(ac.signal);
          if (next) setStats(next);
        } catch (err) {
          const message =
            err instanceof EnrichmentActionError
              ? `${label}: ${err.message}`
              : err instanceof Error
                ? `${label}: ${err.message}`
                : `${label}: ${t("admin.loadError")}`;
          setError(message);
        }
      });
    },
    [],
  );

  const { v0, v1, v2, v3, noCn, hasCn, healCnReal, cnStuck } = stats.enrichment;
  const total = v0 + v1 + v2 + v3;
  const prog = stats.queue.v3Progress;
  const v3Active = !!(prog && prog.total > 0 && prog.processed < prog.total);
  const v3Paused = !!prog?.paused;
  const v3Pct =
    prog && prog.total > 0
      ? Math.round((prog.processed / prog.total) * 100)
      : 0;

  const pct = (n: number): number => (total > 0 ? (n / total) * 100 : 0);

  // Chinese-synopsis backfill. Every number and every alarm below is
  // decided in @/lib/backfillStatus so it can be unit-tested without a
  // DOM stack; this component only picks colours and words.
  const cn = stats.descriptionCn ?? NO_DESCRIPTION_CN;
  const backfill = stats.queue.descriptionBackfill ?? NO_BACKFILL_QUEUE;
  const cnPct = coveragePct(cn.done, cn.eligible);
  // "Not eligible" is everything outside the description_cn_eligible
  // view: rows whose bgm binding is not trustworthy enough to copy from.
  // It belongs on screen so the coverage denominator cannot be mistaken
  // for the catalogue size — 100% of 13 eligible rows out of a 285-row
  // catalogue is a very different report from 100% of 285. It is a
  // backlog by design, not a failure.
  const cnIneligible = ineligibleCount(stats.anime, cn.eligible);
  const queueHealth = backfillHealth(backfill);
  // Both heartbeats are judged against the same `now`, so the two rows
  // are always internally consistent.
  const scanState = heartbeatState(backfill.lastScanAt, now);
  // The write heartbeat is NOT judged on age alone. Once coverage
  // saturates, every eligible row is either done or inside its 30-day
  // cooldown, so the next write is legitimately weeks away — running it
  // through the scan's 2h budget would leave the panel amber for 29 days
  // out of 30 and train the operator to ignore it. `pending` is the
  // discriminator: silence with nothing to write is the job working as
  // designed; silence with work waiting is a wedged writer.
  const writeState = writeHeartbeatState(
    backfill.lastWriteAt,
    now,
    cn.pending,
  );

  // Machine-translation tier. Same four helpers, same two heartbeats —
  // the block is structurally identical to the Bangumi one above so an
  // operator reads them the same way. What differs is the denominator:
  // `remit` is Bangumi's leftovers, NOT the eligible view and NOT the
  // catalogue, so the two coverage percentages answer different
  // questions and must never be added or compared.
  const llm = stats.descriptionCnLlm ?? NO_DESCRIPTION_CN_LLM;
  const llmQueue = stats.queue.descriptionLlm ?? NO_BACKFILL_QUEUE;
  const llmPct = coveragePct(llm.done, llm.remit);
  const llmQueueHealth = backfillHealth(llmQueue);
  const llmScanState = heartbeatState(llmQueue.lastScanAt, now);
  const llmWriteState = writeHeartbeatState(
    llmQueue.lastWriteAt,
    now,
    llm.pending,
  );

  return (
    <div style={styles.card}>
      <style>{stripeKeyframes}</style>

      <div style={styles.heading}>
        <span>{t("admin.enrichmentDistTitle")}</span>
        <span style={styles.headingMeta}>
          v3 {v3} · v2 {v2} · v1 {v1} · v0 {v0}
          {(healCnReal > 0 || cnStuck > 0)
            ? ` · 缺中文 可修 ${healCnReal} · 卡死 ${cnStuck}`
            : noCn > 0 ? ` · ${t("admin.missingCn").replace("{{n}}", String(noCn))}` : ""}
        </span>
      </div>

      <div
        style={styles.bar}
        role="img"
        aria-label={`${t("admin.enrichmentDistTitle")}: v3 ${v3}, v2 ${v2}, v1 ${v1}, v0 ${v0}; 中文覆盖 ${hasCn}/${total}`}
      >
        <div style={{ ...styles.segV3, width: `${pct(v3)}%` }}>
          {v3Active && !v3Paused ? <div style={styles.stripeOverlay} /> : null}
        </div>
        <div style={{ ...styles.segV2, width: `${pct(v2)}%` }} />
        <div style={{ ...styles.segV1, width: `${pct(v1)}%` }} />
        <div style={{ ...styles.segV0, width: `${pct(v0)}%` }} />
      </div>

      {v3Active ? (
        <div style={styles.progressRow}>
          <span>
            V3 Heal: {prog!.processed}/{prog!.total} ({v3Pct}%)
            {v3Paused ? <span style={styles.pausedTag}> · PAUSED</span> : null}
          </span>
        </div>
      ) : null}

      <div style={styles.legend} aria-hidden>
        {LEGEND_COLORS.map((color, i) => {
          const key = LEGEND_LABEL_KEYS[i];
          const label = key.startsWith("admin.") ? t(key) : key;
          const isV3 = i === 0;
          return (
            <span key={color} style={styles.legendItem}>
              <span style={{ ...styles.legendDot, background: color }} />
              {label}
              {isV3 && cnStuck > 0
                ? <span style={styles.legendSub}> 其中 {cnStuck} 无中文</span>
                : null}
            </span>
          );
        })}
      </div>

      <div style={styles.cnCoverage}>
        中文覆盖{" "}
        <span style={{ fontFeatureSettings: '"tnum"' }}>
          {hasCn}/{total}
          {total > 0 ? ` (${Math.round((hasCn / total) * 100)}%)` : ""}
        </span>
      </div>

      <div style={styles.actions}>
        <button
          type="button"
          style={healCnReal === 0 ? styles.btnPrimaryDisabled : styles.btnPrimary}
          disabled={pending || healCnReal === 0}
          onClick={() => runAction("Heal CN", healCn)}
        >
          Heal CN ({healCnReal})
        </button>

        {v3Active && !v3Paused ? (
          <button
            type="button"
            style={styles.btnWarn}
            disabled={pending}
            onClick={() => runAction("Pause", pauseHealCn)}
          >
            Pause
          </button>
        ) : null}

        {v3Active && v3Paused ? (
          <button
            type="button"
            style={styles.btnPrimary}
            disabled={pending}
            onClick={() => runAction("Resume", resumeHealCn)}
          >
            Resume
          </button>
        ) : null}

        <button
          type="button"
          style={styles.btnGhost}
          disabled={pending || v1 === 0}
          onClick={() => runAction("Re-enrich v1", () => reEnrich(1))}
        >
          Re-enrich v1{v1 > 0 ? ` (${v1})` : ""}
        </button>
        <button
          type="button"
          style={styles.btnGhost}
          disabled={pending || v2 === 0}
          onClick={() => runAction("Re-enrich v2", () => reEnrich(2))}
        >
          Re-enrich v2{v2 > 0 ? ` (${v2})` : ""}
        </button>
      </div>

      <section style={styles.cnSection} aria-labelledby="backfill-cn-heading">
        <div style={styles.heading}>
          <span id="backfill-cn-heading">{t("admin.backfill.title")}</span>
          <span style={styles.headingMeta}>
            {fmt(cn.done)} / {fmt(cn.eligible)} ({formatCoveragePct(cnPct)}%)
          </span>
        </div>

        <div
          style={styles.bar}
          role="img"
          aria-label={`${t("admin.backfill.title")}: ${cn.done}/${cn.eligible} (${formatCoveragePct(cnPct)}%)`}
        >
          <div style={{ ...styles.segCn, width: `${cnPct}%` }} />
        </div>

        <div style={styles.cnFacts}>
          <span>
            {t("admin.backfill.pending")}{" "}
            <strong style={styles.factNum}>{fmt(cn.pending)}</strong>
          </span>
          <span>
            {t("admin.backfill.rejected")}{" "}
            <strong style={styles.factNum}>{fmt(cn.rejected)}</strong>
          </span>
          <span>
            {t("admin.backfill.ineligible")}{" "}
            <strong style={styles.factNum}>{fmt(cnIneligible)}</strong>
          </span>
        </div>

        <div style={queueHealth.warn ? styles.cnFactsWarn : styles.cnFacts}>
          <span>
            {t("admin.backfill.queueLabel")}{" "}
            <strong style={styles.factNum}>{fmt(backfill.queued)}</strong>{" "}
            {t("admin.backfill.queued")}
          </span>
          {backfill.retrying > 0 ? (
            <span style={styles.alarm}>
              <strong style={styles.factNum}>{fmt(backfill.retrying)}</strong>{" "}
              {t("admin.backfill.retrying")} ⚠
            </span>
          ) : null}
          {backfill.discarded > 0 ? (
            <span style={styles.alarm}>
              <strong style={styles.factNum}>{fmt(backfill.discarded)}</strong>{" "}
              {t("admin.backfill.discarded")} ⚠
            </span>
          ) : null}
        </div>

        {/*
          Both heartbeats, side by side, because neither answers the
          question alone: a fresh scan with an old write means the sweep
          is alive and finding nothing, while a stale scan means it is
          not running at all. Collapsing them would make "no work to do"
          and "dead" render identically.
        */}
        <div style={styles.cnFacts}>
          <span
            suppressHydrationWarning
            style={scanState.warn ? styles.alarm : undefined}
          >
            {t("admin.backfill.lastScan")} {formatAge(t, backfill.lastScanAt, now)}{" "}
            {glyph(scanState)}
          </span>
          <span
            suppressHydrationWarning
            style={writeState.warn ? styles.alarm : undefined}
          >
            {t("admin.backfill.lastWrite")}{" "}
            {formatAge(t, backfill.lastWriteAt, now)}{" "}
            {glyph(writeState)}
          </span>
        </div>
      </section>

      {/*
        Machine-translation tier — a sibling section, not a row inside the
        one above, because its denominator is a different set of rows.
        Stacked rather than side-by-side so the two coverage bars are never
        read as two halves of one total.
      */}
      <section style={styles.cnSection} aria-labelledby="backfill-llm-heading">
        <div style={styles.heading}>
          <span id="backfill-llm-heading">{t("admin.llm.title")}</span>
          <span style={styles.headingMeta}>
            {fmt(llm.done)} / {fmt(llm.remit)} ({formatCoveragePct(llmPct)}%)
          </span>
        </div>

        <div
          style={styles.bar}
          role="img"
          aria-label={`${t("admin.llm.title")}: ${llm.done}/${llm.remit} (${formatCoveragePct(llmPct)}%)`}
        >
          <div style={{ ...styles.segLlm, width: `${llmPct}%` }} />
        </div>

        <div style={styles.cnFacts}>
          <span>
            {t("admin.backfill.pending")}{" "}
            <strong style={styles.factNum}>{fmt(llm.pending)}</strong>
          </span>
          <span>
            {t("admin.llm.rejected")}{" "}
            <strong style={styles.factNum}>{fmt(llm.rejected)}</strong>
          </span>
          <span>
            {t("admin.llm.remit")}{" "}
            <strong style={styles.factNum}>{fmt(llm.remit)}</strong>
          </span>
        </div>

        <div style={llmQueueHealth.warn ? styles.cnFactsWarn : styles.cnFacts}>
          <span>
            {t("admin.llm.queueLabel")}{" "}
            <strong style={styles.factNum}>{fmt(llmQueue.queued)}</strong>{" "}
            {t("admin.backfill.queued")}
          </span>
          {/*
            Retrying matters more here than in the Bangumi block: a rate
            limit, an expired key and an exhausted balance all land as
            retryable, and this is where they surface before the sweep
            goes quiet.
          */}
          {llmQueue.retrying > 0 ? (
            <span style={styles.alarm}>
              <strong style={styles.factNum}>{fmt(llmQueue.retrying)}</strong>{" "}
              {t("admin.backfill.retrying")} ⚠
            </span>
          ) : null}
          {llmQueue.discarded > 0 ? (
            <span style={styles.alarm}>
              <strong style={styles.factNum}>{fmt(llmQueue.discarded)}</strong>{" "}
              {t("admin.backfill.discarded")} ⚠
            </span>
          ) : null}
        </div>

        <div style={styles.cnFacts}>
          <span
            suppressHydrationWarning
            style={llmScanState.warn ? styles.alarm : undefined}
          >
            {t("admin.backfill.lastScan")}{" "}
            {formatAge(t, llmQueue.lastScanAt, now)} {glyph(llmScanState)}
          </span>
          <span
            suppressHydrationWarning
            style={llmWriteState.warn ? styles.alarm : undefined}
          >
            {t("admin.backfill.lastWrite")}{" "}
            {formatAge(t, llmQueue.lastWriteAt, now)} {glyph(llmWriteState)}
          </span>
        </div>
      </section>

      {error ? (
        <div role="alert" style={styles.error}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

// V3 stripe animation — kept inline so the keyframe ships only when
// the bar mounts. Legacy used the same `v3-stripe` name.
const stripeKeyframes = `
@keyframes v3-stripe {
  0% { background-position: 0 0; }
  100% { background-position: 20px 0; }
}
`;

const COLOR_V3 = "#5ac8fa";
const COLOR_V2 = "#30d158";
const COLOR_V1 = "#ff9f0a";
const COLOR_V0 = "#ff453a";
// Distinct from the four version colours — the CN-synopsis bar measures a
// different thing and must not read as another slice of the same scale.
const COLOR_CN = "#bf5af2";
// Teal against the Bangumi block's purple: adjacent bars that mean
// different things must not read as two shades of one metric.
const COLOR_LLM = "#2dd4bf";

// Labels are resolved at render time via t() — see legendItems() in the component.
const LEGEND_COLORS = [COLOR_V3, COLOR_V2, COLOR_V1, COLOR_V0] as const;
const LEGEND_LABEL_KEYS = [
  "admin.v3FullEnrich",
  "v2",
  "v1",
  "v0",
] as const;

const btnBase: React.CSSProperties = {
  padding: "8px 14px",
  fontSize: 13,
  borderRadius: 6,
  cursor: "pointer",
};
const segBase: React.CSSProperties = { transition: "width 0.4s ease" };

const styles: Record<string, React.CSSProperties> = {
  card: {
    padding: "20px 24px",
    background: "#15151f",
    border: "1px solid #1f1f2a",
    borderRadius: 10,
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  heading: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    fontSize: 13,
    color: "#a8a8b8",
    gap: 12,
    flexWrap: "wrap",
  },
  headingMeta: { fontSize: 12, color: "#7c7c8c", fontFeatureSettings: '"tnum"' },
  bar: {
    display: "flex",
    height: 10,
    borderRadius: 5,
    overflow: "hidden",
    background: "#0e0e16",
    border: "1px solid #1f1f2a",
  },
  segV3: { ...segBase, background: COLOR_V3, position: "relative" },
  segV2: { ...segBase, background: COLOR_V2 },
  segV1: { ...segBase, background: COLOR_V1 },
  segV0: { ...segBase, background: COLOR_V0 },
  stripeOverlay: {
    position: "absolute",
    inset: 0,
    backgroundImage:
      "linear-gradient(135deg, rgba(255,255,255,0.18) 25%, transparent 25%, transparent 50%, rgba(255,255,255,0.18) 50%, rgba(255,255,255,0.18) 75%, transparent 75%)",
    backgroundSize: "20px 20px",
    animation: "v3-stripe 0.6s linear infinite",
  },
  progressRow: { fontSize: 12, color: "#cfcfdc", fontFeatureSettings: '"tnum"' },
  pausedTag: { color: COLOR_V1, fontWeight: 600 },
  legend: { display: "flex", flexWrap: "wrap", gap: 16, fontSize: 11, color: "#7c7c8c" },
  legendItem: { display: "inline-flex", alignItems: "center", gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: "50%", display: "inline-block" },
  legendSub: { color: "#5c5c6e", fontFeatureSettings: '"tnum"' },
  cnCoverage: { fontSize: 12, color: "#8c8c9c", fontFeatureSettings: '"tnum"' },
  actions: { display: "flex", gap: 10, flexWrap: "wrap", marginTop: 4 },
  cnSection: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    paddingTop: 16,
    marginTop: 4,
    borderTop: "1px solid #1f1f2a",
  },
  segCn: { ...segBase, background: COLOR_CN },
  segLlm: { ...segBase, background: COLOR_LLM },
  cnFacts: {
    display: "flex",
    flexWrap: "wrap",
    gap: 16,
    fontSize: 12,
    color: "#8c8c9c",
  },
  cnFactsWarn: {
    display: "flex",
    flexWrap: "wrap",
    gap: 16,
    fontSize: 12,
    color: "#8c8c9c",
    padding: "6px 10px",
    margin: "-6px -10px",
    borderRadius: 6,
    background: "#2a1a08",
    border: `1px solid ${COLOR_V1}`,
  },
  factNum: {
    color: "#dcdce8",
    fontWeight: 600,
    fontFeatureSettings: '"tnum"',
  },
  alarm: { color: "#ffb967", fontFeatureSettings: '"tnum"' },
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
  btnWarn: {
    ...btnBase,
    background: "#5a3a0e",
    color: "#ffb967",
    border: `1px solid ${COLOR_V1}`,
    fontWeight: 500,
  },
  btnGhost: {
    ...btnBase,
    background: "transparent",
    color: "#c8c8d4",
    border: "1px solid #2a2a38",
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
