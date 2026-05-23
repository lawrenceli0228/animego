"use client";

// Phase 8.0 port of client/src/components/anime/WeeklySchedule.jsx.
//
// Needs 'use client' because the day-tab is local UI state with no URL
// representation in the legacy version. Schedule data still comes from
// the server via props; only the active-day pick lives on the client.
//
// ScheduleDay / ScheduleResponse are declared inline (NOT added to
// lib/types.ts) because lib/types.ts is the lockstep mirror of the Go
// API surface and this component is the only consumer in next-app so
// far. If a second consumer appears, lift these into lib/types.ts in
// the same commit as the Go-side mirror change.
//
// ASCII comments only - Unicode in source can panic Turbopack.

import Link from "next/link";
import type { CSSProperties } from "react";
import { useState } from "react";
import { pickTitle } from "@/lib/formatters";
import type { Dict, Lang } from "@/lib/i18n";

export interface ScheduleItem {
  scheduleId: number;
  airingAt: number;
  episode: number;
  anilistId: number;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
  titleChinese: string | null;
  coverImageUrl: string | null;
  coverImageColor: string | null;
  posterAccent: string | null;
  posterAccentRgb: string | null;
  posterAccentContrastOnBlack: number | null;
  format: string | null;
  averageScore: number | null;
  genres: string[];
}

export interface ScheduleResponse {
  today: string;
  groups: Record<string, ScheduleItem[]>;
}

// Public alias matching the subagent task spec.
export type ScheduleDay = {
  date: string;
  items: ScheduleItem[];
};

export interface WeeklyScheduleProps {
  // Accept either the raw Go envelope payload OR a pre-flattened day list.
  // The page passes whatever shape it already has; we normalize below.
  schedule: ScheduleResponse | ScheduleDay[];
  dict: Dict;
  lang: Lang;
}

const DAY_ZH: Record<number, string> = {
  0: "周日",
  1: "周一",
  2: "周二",
  3: "周三",
  4: "周四",
  5: "周五",
  6: "周六",
};

const DAY_EN: Record<number, string> = {
  0: "Sun",
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
};

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const sectionStyle: CSSProperties = { marginTop: 56 };
const headerStyle: CSSProperties = { marginBottom: 20 };

const labelStyle: CSSProperties = {
  color: "#0a84ff",
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: "2px",
  textTransform: "uppercase",
  marginBottom: 8,
};

const titleStyle: CSSProperties = {
  fontSize: "clamp(22px,3vw,32px)",
  color: "#ffffff",
};

const tabsStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  overflowX: "auto",
  paddingBottom: 8,
  marginBottom: 24,
  scrollbarWidth: "none",
};

function tabStyle(active: boolean, isToday: boolean): CSSProperties {
  return {
    padding: "6px 18px",
    minHeight: 44,
    borderRadius: 20,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    border: "none",
    whiteSpace: "nowrap",
    transition: "all 0.2s",
    background: active
      ? "#0a84ff"
      : isToday
        ? "rgba(10,132,255,0.12)"
        : "rgba(120,120,128,0.12)",
    color: active
      ? "#fff"
      : isToday
        ? "#0a84ff"
        : "rgba(235,235,245,0.60)",
    outline: "none",
  };
}

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
  gap: 14,
};

const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  borderRadius: 12,
  background: "#1c1c1e",
  border: "1px solid #38383a",
  overflow: "hidden",
  textDecoration: "none",
  color: "inherit",
  transition:
    "transform 0.25s cubic-bezier(0.4,0,0.2,1), box-shadow 0.25s cubic-bezier(0.4,0,0.2,1)",
};

const coverStyle: CSSProperties = {
  width: "100%",
  aspectRatio: "3/4",
  objectFit: "cover",
  display: "block",
  background: "#2c2c2e",
};

const cardBodyStyle: CSSProperties = { padding: "8px 10px 10px" };

const cardTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#ffffff",
  overflow: "hidden",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  lineHeight: 1.4,
  marginBottom: 6,
};

const metaStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const epStyle: CSSProperties = {
  fontSize: 11,
  color: "#0a84ff",
  fontWeight: 600,
  background: "rgba(10,132,255,0.15)",
  padding: "2px 7px",
  borderRadius: 4,
  alignSelf: "flex-start",
};

const timeScoreStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const timeStyle: CSSProperties = {
  fontSize: 11,
  color: "rgba(235,235,245,0.30)",
};

const scoreStyle: CSSProperties = {
  fontSize: 11,
  color: "#ff9f0a",
  fontWeight: 600,
  fontFamily: "'JetBrains Mono',monospace",
};

const emptyStyle: CSSProperties = {
  color: "rgba(235,235,245,0.30)",
  fontSize: 14,
  padding: "32px 0",
  textAlign: "center",
};

function normalize(
  schedule: ScheduleResponse | ScheduleDay[],
): { today: string; groups: Record<string, ScheduleItem[]> } {
  if (Array.isArray(schedule)) {
    const groups: Record<string, ScheduleItem[]> = {};
    for (const d of schedule) groups[d.date] = d.items;
    return { today: localToday(), groups };
  }
  return { today: schedule.today, groups: schedule.groups };
}

export default function WeeklySchedule({
  schedule,
  dict,
  lang,
}: WeeklyScheduleProps) {
  const { today: apiToday, groups } = normalize(schedule);
  const today = apiToday || localToday();
  const days = Object.keys(groups).sort();
  const [selected, setSelected] = useState<string | null>(null);

  if (days.length === 0) return null;

  const active = selected ?? today;
  const activeDay = days.includes(active) ? active : days[0];
  const items = groups[activeDay] ?? [];

  const dayMap = lang === "zh" ? DAY_ZH : DAY_EN;

  function formatDayLabel(dateStr: string): string {
    if (dateStr === today) return dict.home.today;
    const d = new Date(dateStr + "T00:00:00");
    return dayMap[d.getDay()];
  }

  function onCardEnter(e: React.MouseEvent<HTMLAnchorElement>) {
    e.currentTarget.style.transform = "translateY(-4px)";
    e.currentTarget.style.boxShadow = "0 8px 24px rgba(0,0,0,0.40)";
  }
  function onCardLeave(e: React.MouseEvent<HTMLAnchorElement>) {
    e.currentTarget.style.transform = "translateY(0)";
    e.currentTarget.style.boxShadow = "none";
  }

  return (
    <section style={sectionStyle}>
      <div style={headerStyle}>
        <p style={labelStyle}>{dict.home.scheduleLabel}</p>
        <h2 style={titleStyle}>{dict.home.thisWeek}</h2>
      </div>

      <div style={tabsStyle}>
        {days.map((d) => (
          <button
            key={d}
            style={tabStyle(d === activeDay, d === today)}
            onClick={() => setSelected(d)}
          >
            {formatDayLabel(d)}
            <span style={{ marginLeft: 4, opacity: 0.7, fontSize: 11 }}>
              {groups[d]?.length ?? 0}
            </span>
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <p style={emptyStyle}>{dict.home.noUpdates}</p>
      ) : (
        <div style={gridStyle}>
          {items.map((item) => {
            const title = pickTitle(item, lang);
            const score = item.averageScore ?? 0;
            return (
              <Link
                key={item.scheduleId}
                href={`/anime/${item.anilistId}`}
                prefetch={false}
                aria-label={title}
                style={cardStyle}
                onMouseEnter={onCardEnter}
                onMouseLeave={onCardLeave}
              >
                {item.coverImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.coverImageUrl}
                    alt={title}
                    style={coverStyle}
                    loading="lazy"
                  />
                ) : (
                  <div style={coverStyle} aria-hidden />
                )}
                <div style={cardBodyStyle}>
                  <div style={cardTitleStyle}>{title}</div>
                  <div style={metaStyle}>
                    <span style={epStyle}>
                      {dict.detail.ep} {item.episode} {dict.detail.epUnit}
                    </span>
                    <div style={timeScoreStyle}>
                      <span style={timeStyle}>{formatTime(item.airingAt)}</span>
                      {score > 0 ? (
                        <span style={scoreStyle}>
                          {"★ "}
                          {(score / 10).toFixed(1)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
