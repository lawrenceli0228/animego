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
import type { AdminStats } from "../_types";
import { EnrichmentActionError } from "../_actions/_shared";
import {
  healCn,
  pauseHealCn,
  reEnrich,
  resumeHealCn,
} from "../_actions/enrichment-queue";
import { useLang } from "@/lib/lang-client";

interface EnrichmentBarProps {
  initial: AdminStats;
}

// Polling cadence rules ported verbatim from useAdmin.js:12-20.
// Returns 0 when no polling is needed (idle).
function pickInterval(stats: AdminStats): number {
  const q = stats.queue;
  const prog = q.v3Progress;
  if (prog && prog.total > 0 && prog.processed < prog.total && !prog.paused) {
    return 2000;
  }
  if (q.phase1 + q.phase4 + q.v3 > 0) return 5000;
  return 0;
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

  const { v0, v1, v2, v3, noCn } = stats.enrichment;
  const total = v0 + v1 + v2 + v3;
  const prog = stats.queue.v3Progress;
  const v3Active = !!(prog && prog.total > 0 && prog.processed < prog.total);
  const v3Paused = !!prog?.paused;
  const v3Pct =
    prog && prog.total > 0
      ? Math.round((prog.processed / prog.total) * 100)
      : 0;

  const pct = (n: number): number => (total > 0 ? (n / total) * 100 : 0);

  return (
    <div style={styles.card}>
      <style>{stripeKeyframes}</style>

      <div style={styles.heading}>
        <span>{t("admin.enrichmentDistTitle")}</span>
        <span style={styles.headingMeta}>
          v3 {v3} · v2 {v2} · v1 {v1} · v0 {v0}
          {noCn > 0 ? ` · ${t("admin.missingCn").replace("{{n}}", String(noCn))}` : ""}
        </span>
      </div>

      <div
        style={styles.bar}
        role="img"
        aria-label={`${t("admin.enrichmentDistTitle")}: v3 ${v3}, v2 ${v2}, v1 ${v1}, v0 ${v0}`}
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
          return (
            <span key={color} style={styles.legendItem}>
              <span style={{ ...styles.legendDot, background: color }} />
              {label}
            </span>
          );
        })}
      </div>

      <div style={styles.actions}>
        <button
          type="button"
          style={styles.btnPrimary}
          disabled={pending}
          onClick={() => runAction("Heal CN", healCn)}
        >
          Heal CN{noCn > 0 ? ` (${noCn})` : ""}
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
  actions: { display: "flex", gap: 10, flexWrap: "wrap", marginTop: 4 },
  btnPrimary: {
    ...btnBase,
    background: "#2f5fdf",
    color: "#fff",
    border: "1px solid #3a6eef",
    fontWeight: 500,
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
