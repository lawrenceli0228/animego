"use client";

import { useMemo } from "react";
import type { Lang } from "@/lib/i18n";
import type { SubscriptionListItem } from "./types";

// Status color palette — matches legacy STATUS_COLORS in AnimeStats.jsx.
const STATUS_COLORS: Record<string, string> = {
  watching: "#0a84ff",
  completed: "#30d158",
  plan_to_watch: "#ff9f0a",
  dropped: "#ff453a",
};

const STATUS_ORDER = ["watching", "completed", "plan_to_watch", "dropped"];

const STATUS_LABELS: Record<"zh" | "en", Record<string, string>> = {
  zh: { watching: "在看", completed: "看完", plan_to_watch: "想看", dropped: "抛弃" },
  en: { watching: "Watching", completed: "Completed", plan_to_watch: "Plan", dropped: "Dropped" },
};

const SEASON_LABELS: Record<"zh" | "en", Record<string, string>> = {
  zh: { WINTER: "冬季", SPRING: "春季", SUMMER: "夏季", FALL: "秋季" },
  en: { WINTER: "Winter", SPRING: "Spring", SUMMER: "Summer", FALL: "Fall" },
};

interface DonutSegment {
  value: number;
  color: string;
}

function DonutChart({ segments, size = 80 }: { segments: DonutSegment[]; size?: number }) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (!total) return null;

  const r = size / 2 - 7;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  let offset = 0;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {segments
        .filter((s) => s.value > 0)
        .map((seg, i) => {
          const pct = seg.value / total;
          const dash = circumference * pct;
          const gap = circumference - dash;
          const cur = offset;
          offset += pct * circumference;
          return (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke={seg.color}
              strokeWidth={10}
              strokeDasharray={`${dash} ${gap}`}
              strokeDashoffset={-cur}
              style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
            />
          );
        })}
      <text
        x={cx}
        y={cy + 6}
        textAnchor="middle"
        fill="#fff"
        style={{
          fontSize: 20,
          fontWeight: 700,
          fontFamily: "'Sora', sans-serif",
        }}
      >
        {total}
      </text>
    </svg>
  );
}

interface AnimeStatsPanelProps {
  /** All subscriptions across all statuses (no filter). */
  allSubs: SubscriptionListItem[];
  lang: Lang;
}

export default function AnimeStatsPanel({ allSubs, lang }: AnimeStatsPanelProps) {
  const stats = useMemo(() => {
    if (!allSubs.length) return null;

    const statusCounts: Record<string, number> = {
      watching: 0,
      completed: 0,
      plan_to_watch: 0,
      dropped: 0,
    };
    const seasonCounts: Record<string, number> = {};

    for (const item of allSubs) {
      const s = item.status as keyof typeof statusCounts;
      if (s in statusCounts) {
        statusCounts[s] = (statusCounts[s] ?? 0) + 1;
      }
      if (item.season && item.seasonYear) {
        const key = `${item.seasonYear}-${item.season}`;
        seasonCounts[key] = (seasonCounts[key] ?? 0) + 1;
      }
    }

    const statusSegments: DonutSegment[] = STATUS_ORDER.filter(
      (k) => (statusCounts[k] ?? 0) > 0,
    ).map((k) => ({
      value: statusCounts[k] ?? 0,
      color: STATUS_COLORS[k] ?? "#888",
    }));

    const topSeasonEntry = Object.entries(seasonCounts).sort(
      (a, b) => b[1] - a[1],
    )[0];

    return { statusCounts, statusSegments, topSeasonEntry };
  }, [allSubs]);

  if (!stats) return null;

  const sLabel = STATUS_LABELS[lang] ?? STATUS_LABELS.en;
  const seasonLabel = SEASON_LABELS[lang] ?? SEASON_LABELS.en;

  const topSeasonText = stats.topSeasonEntry
    ? (() => {
        const [key] = stats.topSeasonEntry;
        const [year, season] = key.split("-");
        return `${year} ${seasonLabel[season] ?? ""}`.trim();
      })()
    : null;

  const hasAnyCounts = STATUS_ORDER.some((k) => (stats.statusCounts[k] ?? 0) > 0);
  if (!hasAnyCounts) return null;

  return (
    <div
      style={{
        background: "#1c1c1e",
        border: "1px solid #38383a",
        borderRadius: 14,
        padding: "16px 20px",
        marginBottom: 28,
        display: "flex",
        alignItems: "center",
        gap: 24,
        flexWrap: "wrap",
      }}
    >
      {/* Donut chart */}
      <DonutChart segments={stats.statusSegments} />

      {/* Status legend */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {STATUS_ORDER.map((key) => {
          const count = stats.statusCounts[key] ?? 0;
          if (!count) return null;
          const color = STATUS_COLORS[key] ?? "#888";
          return (
            <span
              key={key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 13,
                color: "rgba(235,235,245,0.70)",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: color,
                  flexShrink: 0,
                }}
              />
              {sLabel[key]}
              <span
                style={{
                  fontWeight: 600,
                  color: "#fff",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {count}
              </span>
            </span>
          );
        })}
      </div>

      {/* Most active season — only when available */}
      {topSeasonText && (
        <>
          <div
            style={{
              width: 1,
              height: 48,
              background: "#38383a",
              flexShrink: 0,
            }}
          />
          <div>
            <p
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: "#fff",
                margin: 0,
                fontFamily: "'Sora', sans-serif",
              }}
            >
              {topSeasonText}
            </p>
            <p style={{ fontSize: 11, color: "rgba(235,235,245,0.30)", margin: 0 }}>
              {lang === "zh" ? "最活跃赛季" : "Most Active Season"}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
