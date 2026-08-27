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

import Link from "@/components/ui/LocaleLink";
import type { CSSProperties } from "react";
import { useRef, useState } from "react";
import { pickTitle } from "@/lib/formatters";
import FadeImage from "@/components/ui/FadeImage";
import type { Dict, Lang } from "@/lib/i18n";
import { nextTabIndex } from "./tabListNav";
import styles from "./WeeklySchedule.module.css";

// Static id prefix for the tab/panel wiring. The component renders once per
// page, so a constant is enough and it keeps the ids stable between the
// server and client renders - useId would be safer for a repeated component
// but produces a value that has to match across hydration for these
// relationships to resolve at all.
const TABS_ID = "weekly-schedule";

export interface ScheduleItem {
  scheduleId: number;
  airingAt: number;
  episode: number;
  anilistId: number;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
  titleChinese: string | null;
  // Traditional Chinese title channel (migration 0022). Optional rather than
  // `| null` for the same reason as everywhere in lib/types.ts: a go-api older
  // than that commit omits them entirely, and pickTitle's ladder already falls
  // through. See the hant-channel note at the top of lib/types.ts.
  titleHant?: string | null;
  titleHantSource?: string | null;
  /**
   * SERP-safe projection: null whenever titleHant is a machine conversion.
   * Nothing on this component reaches a search engine — the schedule renders
   * card link text, not a <title> or JSON-LD name — so pickTitle() reads
   * titleHant here. Any future metadata built from a ScheduleItem must read
   * this field instead.
   */
  titleHantSeo?: string | null;
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

// Keyed by Lang so a new language fails to compile here rather than silently
// falling back to one of the existing two. Inner key is Date#getDay(), 0=Sunday.
const DAY_LABELS: Record<Lang, Record<number, string>> = {
  zh: {
    0: "周日",
    1: "周一",
    2: "周二",
    3: "周三",
    4: "周四",
    5: "周五",
    6: "周六",
  },
  en: {
    0: "Sun",
    1: "Mon",
    2: "Tue",
    3: "Wed",
    4: "Thu",
    5: "Fri",
    6: "Sat",
  },
  // 周 -> 週 is a real word choice, not just a glyph: both characters exist
  // in Traditional, and 週 is what Taiwanese and Hong Kong writing uses for a
  // day of the week.
  "zh-Hant": {
    0: "週日",
    1: "週一",
    2: "週二",
    3: "週三",
    4: "週四",
    5: "週五",
    6: "週六",
  },
};

// localToday is locked to Asia/Shanghai because it picks which tab is
// "today" — and the upstream /api/anime/schedule "today" field is also
// CST-computed on the server. If we let localToday float to browser
// TZ, an AEST/UTC user crossing midnight would highlight a different
// tab than the one the API thinks is today, causing an off-by-one day
// in the rolling-week display.
const SCHEDULE_TZ = "Asia/Shanghai";

function localToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHEDULE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "00";
  const d = parts.find((p) => p.type === "day")?.value ?? "00";
  return `${y}-${m}-${d}`;
}

// Airing-time string follows the viewer's browser TZ (matches the
// legacy SPA's toLocaleTimeString default). Without an explicit
// timeZone the server (TZ=Asia/Shanghai) and a non-CST browser will
// emit different strings → React error #418 hydration mismatch on
// every card. The fix is suppressHydrationWarning on the rendered
// <span>: React keeps the SSR string in the HTML (good for SEO +
// noscript users) and silently lets the client first render replace
// it with the browser-local time, no console error.
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

// tabsStyle moved to the module alongside the tab rules it belongs with.

// tabStyle(active, isToday) lived here and ended with `outline: "none"`.
// Inline styles beat stylesheets, so that one line meant the tabs could
// never grow a focus ring no matter what CSS anyone wrote for them. The
// whole rule set is now in WeeklySchedule.module.css, keyed off the ARIA
// attributes the tablist pattern requires anyway.

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
  // `height: auto` is load-bearing since these went through next/image:
  // the width/height ATTRIBUTES it emits are presentational hints, i.e. real
  // CSS declarations, and an explicit height beats `aspect-ratio`. Without
  // this the box grows to the attribute value instead of the ratio.
  height: "auto",
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
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Hooks run before the early return below, which is why this sits here and
  // not next to the JSX that uses it.
  const active = selected ?? today;
  const activeDay = days.includes(active) ? active : days[0];

  /**
   * Arrow-key movement across the tablist.
   *
   * Selection follows focus, which is the right choice here specifically
   * because switching days is free — the data for all seven is already in
   * memory, so there is no cost to arrowing through them and no reason to
   * make someone press Enter as well. (For tabs whose panels load on
   * demand, the pattern would be manual activation instead.)
   *
   * Wraps at both ends, and Home/End jump to the edges. Both are part of
   * the pattern people already expect from every other tab control.
   */
  function onTabKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const next = nextTabIndex(e.key, days.indexOf(activeDay), days.length);
    // null means the key is not ours. Returning before preventDefault is the
    // point: a handler that swallows everything traps Tab inside the tablist.
    if (next === null) return;
    e.preventDefault();
    setSelected(days[next]);
    tabRefs.current[next]?.focus();
  }

  if (days.length === 0) return null;

  const items = groups[activeDay] ?? [];

  const dayMap = DAY_LABELS[lang];

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

      {/* A real tablist. Seven plain buttons were seven tab stops with no
          relationship to each other or to the grid they control, so a
          keyboard user tabbed through all of them to reach the content and
          a screen reader announced seven unlabelled buttons.
          Roving tabindex is what fixes the first half: exactly one tab is
          reachable by Tab, and Arrow keys move between them — the pattern
          every native tab control uses. */}
      <div
        className={styles.tabs}
        role="tablist"
        aria-label={dict.home.thisWeek}
        onKeyDown={onTabKeyDown}
      >
        {days.map((d, i) => {
          const isActive = d === activeDay;
          return (
            <button
              key={d}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${TABS_ID}-tab-${d}`}
              aria-selected={isActive}
              aria-controls={`${TABS_ID}-panel`}
              // The roving part. A non-selected tab stays focusable
              // programmatically (that is what -1 means) so the arrow-key
              // handler can move focus onto it.
              tabIndex={isActive ? 0 : -1}
              data-today={d === today ? "true" : "false"}
              className={styles.tab}
              onClick={() => setSelected(d)}
            >
              {formatDayLabel(d)}
              <span className={styles.tabCount}>{groups[d]?.length ?? 0}</span>
            </button>
          );
        })}
      </div>

      {/* The panel the tabs control. Named and labelled by the active tab, so
          the relationship the tablist claims actually resolves. */}
      {items.length === 0 ? (
        <p
          style={emptyStyle}
          id={`${TABS_ID}-panel`}
          role="tabpanel"
          aria-labelledby={`${TABS_ID}-tab-${activeDay}`}
        >
          {dict.home.noUpdates}
        </p>
      ) : (
        <div
          style={gridStyle}
          id={`${TABS_ID}-panel`}
          role="tabpanel"
          aria-labelledby={`${TABS_ID}-tab-${activeDay}`}
        >
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
                  <FadeImage
                    src={item.coverImageUrl}
                    alt={title}
                    width={180}
                    height={240}
                    style={coverStyle}
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
                      <span style={timeStyle} suppressHydrationWarning>
                        {formatTime(item.airingAt)}
                      </span>
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
