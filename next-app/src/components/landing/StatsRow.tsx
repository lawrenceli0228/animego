"use client";

import type { CSSProperties } from "react";
import { motion as Motion, useReducedMotion } from "motion/react";
import {
  HUD_VIEWPORT,
  mono,
  useCountUp,
} from "./shared/hud-tokens";
import { SectionNum } from "./shared/hud";
import type { Dict } from "@/lib/i18n";

/* §02 · 四色数据流 — 每个 stat 独立取色，顺便回应下游章节：
 *   LIBRARY  → Blue 210   (数据根基,主色)
 *   DANMAKU  → Cyan 195   (§07 LIVE 回调)
 *   SOURCES  → Amber 40   (§03 Sources 回调)
 *   DAILY    → Chartreuse 85 (§08 清晨/每日抓取)
 * 色值均 gamut-safe (§07 青/§08 黄绿要拉高 L)。 */
const HUE_INDIGO = 255;
const HUE_BRASS = 75;
const BAR_CONTENT_OFFSET = 12;

type StatKey = "s1" | "s2" | "s3" | "s4";
type StatFormat = "comma" | "M" | "int" | "plus";

interface StatShape {
  num: number;
  format: StatFormat;
  key: StatKey;
  tag: string;
  span: 1 | 2;
  h: number;
  barL: number;
  barC: number;
  tagL: number;
  tagC: number;
}

const statShape: StatShape[] = [
  { num: 12480, format: "comma", key: "s1", tag: "LIBRARY", span: 2, h: 210, barL: 62, barC: 0.17, tagL: 72, tagC: 0.15 },
  { num: 3.2,   format: "M",     key: "s2", tag: "DANMAKU", span: 1, h: 195, barL: 68, barC: 0.13, tagL: 74, tagC: 0.11 },
  { num: 48,    format: "int",   key: "s3", tag: "SOURCES", span: 1, h: 40,  barL: 66, barC: 0.17, tagL: 74, tagC: 0.14 },
  { num: 200,   format: "plus",  key: "s4", tag: "DAILY",   span: 1, h: 85,  barL: 80, barC: 0.16, tagL: 84, tagC: 0.13 },
];

function formatVal(n: number | string, format: StatFormat): string {
  if (typeof n === "string") return n;
  if (format === "comma") return n.toLocaleString("en-US");
  if (format === "M") return n.toFixed(1) + "M";
  if (format === "plus") return n + "+";
  return n.toString();
}

const s = {
  section: {
    position: "relative",
    padding: "clamp(48px, 4vw, 80px) 0",
    borderBottom: "1px solid rgba(84,84,88,0.30)",
    background: "#000",
  } as CSSProperties,
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(5, 1fr)",
    gap: "clamp(20px, 2.4vw, 40px)",
  } as CSSProperties,
  cell: {
    position: "relative",
    paddingLeft: 20,
    paddingTop: 4,
  } as CSSProperties,
  cellHero: {
    paddingRight: 24,
    borderRight: `1px solid oklch(58% 0.11 ${HUE_INDIGO} / 0.28)`,
  } as CSSProperties,
  heroDot: {
    display: "inline-block",
    width: 5,
    height: 5,
    borderRadius: 9999,
    background: `oklch(80% 0.10 ${HUE_BRASS})`,
    boxShadow: `0 0 8px oklch(80% 0.10 ${HUE_BRASS} / 0.55)`,
    marginRight: 8,
    verticalAlign: "middle",
  } as CSSProperties,
  bar: (barL: number, barC: number, h: number): CSSProperties => ({
    position: "absolute",
    left: 0,
    top: 4,
    width: 3,
    height: 52,
    background: `oklch(${barL}% ${barC} ${h})`,
    borderRadius: 2,
    boxShadow: `0 0 20px oklch(${barL}% ${barC} ${h} / 0.48)`,
    transformOrigin: "top",
  }),
  readoutTag: (tagL: number, tagC: number, h: number): CSSProperties => ({
    ...mono,
    fontSize: 10,
    letterSpacing: "0.14em",
    color: `oklch(${tagL}% ${tagC} ${h})`,
    textTransform: "uppercase",
    marginLeft: BAR_CONTENT_OFFSET,
    marginBottom: 10,
  }),
  valueRow: {
    marginLeft: BAR_CONTENT_OFFSET,
  } as CSSProperties,
  value: {
    fontFamily: "'Sora', sans-serif",
    fontSize: "clamp(2.25rem, 1rem + 3.5vw, 4.25rem)",
    fontWeight: 800,
    letterSpacing: "-0.03em",
    lineHeight: 1,
    color: "#fff",
    fontVariantNumeric: "tabular-nums",
  } as CSSProperties,
  valueHero: {
    fontSize: "clamp(2.75rem, 1rem + 4.5vw, 5.5rem)",
  } as CSSProperties,
  label: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 13,
    color: "rgba(235,235,245,0.60)",
    marginTop: 10,
    letterSpacing: "0.02em",
  } as CSSProperties,
  note: {
    ...mono,
    fontSize: 11,
    color: "rgba(235,235,245,0.30)",
    marginTop: 6,
    letterSpacing: "0.04em",
  } as CSSProperties,
};

interface StatProps {
  stat: StatShape;
  index: number;
  label: string;
  note: string;
}

function Stat({ stat, index, label, note }: StatProps) {
  const reduced = useReducedMotion();
  const staggerDelay = 0.12 + index * 0.08;
  const isHero = stat.span === 2;
  const [ref, val] = useCountUp(stat.num, {
    duration: 1.6,
    delay: staggerDelay,
    format: (v) => (stat.format === "M" ? v : Math.round(v)),
  });
  return (
    <div
      ref={ref}
      style={{
        ...s.cell,
        ...(isHero ? s.cellHero : null),
        gridColumn: `span ${stat.span}`,
      }}
    >
      <Motion.span
        style={s.bar(stat.barL, stat.barC, stat.h)}
        initial={reduced ? false : { scaleY: 0 }}
        whileInView={reduced ? undefined : { scaleY: 1 }}
        viewport={HUD_VIEWPORT}
        transition={{ duration: 0.6, delay: staggerDelay - 0.04, ease: [0.16, 1, 0.3, 1] }}
        aria-hidden
      />
      <div style={s.readoutTag(stat.tagL, stat.tagC, stat.h)}>
        {isHero ? <span style={s.heroDot} aria-hidden /> : null}
        {stat.tag}
      </div>
      <div style={s.valueRow}>
        <div style={{ ...s.value, ...(isHero ? s.valueHero : null) }}>
          {formatVal(val, stat.format)}
        </div>
        <div style={s.label}>{label}</div>
        <div style={s.note}>{note}</div>
      </div>
    </div>
  );
}

interface StatsRowProps {
  dict: Dict;
}

export default function StatsRow({ dict }: StatsRowProps) {
  const stats = dict.landing.stats;
  // dict has typed keys `s1Label / s1Note / s2Label / ...`; index by stat.key.
  const labelFor = (key: StatKey): string => {
    const k = `${key}Label` as `${StatKey}Label`;
    return (stats as unknown as Record<string, string>)[k] ?? "";
  };
  const noteFor = (key: StatKey): string => {
    const k = `${key}Note` as `${StatKey}Note`;
    return (stats as unknown as Record<string, string>)[k] ?? "";
  };

  return (
    <section style={s.section} aria-label={stats.sectionLabel}>
      <style>{`
        @media (max-width: 1100px) {
          .stats-grid { grid-template-columns: repeat(2, 1fr) !important; gap: 28px !important; }
          .stats-grid > * { grid-column: span 1 !important; border-right: none !important; padding-right: 0 !important; }
        }
      `}</style>
      <SectionNum n="02" style={{ top: 20 }} />
      <div className="container">
        <div className="stats-grid" style={s.grid}>
          {statShape.map((stat, i) => (
            <Stat
              key={stat.key}
              stat={stat}
              index={i}
              label={labelFor(stat.key)}
              note={noteFor(stat.key)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
