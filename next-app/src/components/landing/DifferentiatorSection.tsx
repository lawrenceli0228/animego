"use client";

/**
 * Section 06 - Differentiator. Three serif-italic manifesto claims + a MiniPicker demo.
 * HUD family: single hue=260 (violet), shared SectionNum/SectionHeader/ChapterBar,
 * MiniPicker reframed as an EP lock console with progress bar + LOCKED readout.
 * The section voice (magazine pull-quote claims) is intentionally preserved;
 * HUD chrome only wraps, never competes with the serif rhythm.
 */

import { useState } from "react";
import type { CSSProperties } from "react";
import { motion as Motion, useReducedMotion } from "motion/react";
import { mono, HUD_VIEWPORT } from "./shared/hud-tokens";
import { SectionNum, SectionHeader, ChapterBar } from "./shared/hud";
import type { Dict } from "@/lib/i18n";

const SECTION_HUE = 260;
// Harmony partners - see Phase A palette plan.
//   P2 Reticle Lime    -> [LOCKED] readout + dot (violet HUD borrows a lime arming signal)
//   P3 Gunmetal Whisper -> row dividers (cold-side structural tone)
const HUE_LIME = 100;
const HUE_GUN = 245;

type ClaimKey = "c1" | "c2" | "c3";

interface ItemKey {
  num: string;
  key: ClaimKey;
}

const itemKeys: ItemKey[] = [
  { num: "01", key: "c1" },
  { num: "02", key: "c2" },
  { num: "03", key: "c3" },
];

const s = {
  section: {
    position: "relative",
    padding: "clamp(80px, 7vw, 120px) 0",
    background: "#000",
    borderTop: "1px solid rgba(84,84,88,0.30)",
  } as CSSProperties,
  grid: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 0.8fr) minmax(0, 1fr)",
    gap: "clamp(32px, 5vw, 96px)",
    alignItems: "start",
  } as CSSProperties,
  stickyLeft: {
    position: "sticky",
    top: 96,
    paddingLeft: 20,
  } as CSSProperties,
  headerOverride: {
    marginBottom: 0,
  } as CSSProperties,
  list: { display: "flex", flexDirection: "column" } as CSSProperties,
  row: {
    display: "grid",
    gridTemplateColumns: "64px 1fr",
    gap: 24,
    padding: "32px 0",
    borderBottom: `1px solid oklch(55% 0.03 ${HUE_GUN} / 0.45)`,
  } as CSSProperties,
  rowLast: {
    borderBottom: "none",
  } as CSSProperties,
  num: {
    ...mono,
    fontSize: 11,
    color: `oklch(72% 0.15 ${SECTION_HUE} / 0.75)`,
    letterSpacing: "0.14em",
    paddingTop: 8,
  } as CSSProperties,
  claim: {
    // Serif italic breaks the page's Sora-only rhythm - magazine pull-quote feel.
    fontFamily: '"EB Garamond", Georgia, "Times New Roman", serif',
    fontStyle: "italic",
    fontSize: "clamp(1.625rem, 1rem + 1.2vw, 2.25rem)",
    fontWeight: 500,
    color: "#fff",
    letterSpacing: "-0.01em",
    lineHeight: 1.2,
    marginBottom: 14,
  } as CSSProperties,
  body: {
    fontSize: 15,
    color: "rgba(235,235,245,0.60)",
    lineHeight: 1.7,
    maxWidth: "58ch",
  } as CSSProperties,
  demoRow: {
    marginTop: 64,
    paddingTop: 32,
    borderTop: "1px solid rgba(84,84,88,0.30)",
  } as CSSProperties,
  demoHeader: {
    display: "flex",
    alignItems: "baseline",
    gap: 16,
    marginBottom: 24,
    flexWrap: "wrap",
  } as CSSProperties,
  demoChip: {
    ...mono,
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "5px 12px",
    borderRadius: 9999,
    background: `oklch(62% 0.19 ${SECTION_HUE} / 0.14)`,
    border: `1px solid oklch(62% 0.19 ${SECTION_HUE} / 0.35)`,
    fontSize: 11,
    letterSpacing: "0.14em",
    color: `oklch(82% 0.15 ${SECTION_HUE})`,
    textTransform: "uppercase",
  } as CSSProperties,
  demoHeadline: {
    fontFamily: "'Sora', sans-serif",
    fontSize: "clamp(1.25rem, 1rem + 0.6vw, 1.625rem)",
    fontWeight: 700,
    color: "#fff",
    letterSpacing: "-0.02em",
    lineHeight: 1.25,
    margin: 0,
  } as CSSProperties,
  demo: {
    position: "relative",
    padding: 24,
    borderRadius: 14,
    background: "rgba(255,255,255,0.02)",
    border: "1px solid rgba(84,84,88,0.35)",
  } as CSSProperties,
  demoEyebrow: {
    ...mono,
    fontSize: 10,
    letterSpacing: "0.14em",
    color: "rgba(235,235,245,0.30)",
    textTransform: "uppercase",
    marginBottom: 10,
  } as CSSProperties,
  demoTitle: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 15,
    fontWeight: 600,
    color: "#fff",
    marginBottom: 4,
  } as CSSProperties,
  demoHint: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 13,
    color: "rgba(235,235,245,0.60)",
    marginBottom: 16,
  } as CSSProperties,
  // EP lock console: mono readout + progress bar above the 12-cell grid
  console: {
    display: "grid",
    gridTemplateColumns: "auto 1fr auto",
    alignItems: "center",
    columnGap: 14,
    marginBottom: 14,
  } as CSSProperties,
  consoleLock: {
    ...mono,
    fontSize: 11,
    letterSpacing: "0.14em",
    color: `oklch(82% 0.13 ${HUE_LIME})`,
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
  } as CSSProperties,
  consoleLockDot: {
    width: 6,
    height: 6,
    borderRadius: 9999,
    background: `oklch(76% 0.15 ${HUE_LIME})`,
    boxShadow: `0 0 8px oklch(76% 0.15 ${HUE_LIME} / 0.6)`,
    animation: "hudBlink 2s var(--ease-out-expo) infinite",
  } as CSSProperties,
  consoleBarWrap: {
    position: "relative",
    height: 3,
    background: "rgba(235,235,245,0.08)",
    borderRadius: 2,
    overflow: "hidden",
  } as CSSProperties,
  consoleBarFill: {
    position: "absolute",
    inset: 0,
    background: `linear-gradient(90deg, oklch(62% 0.19 ${SECTION_HUE}) 0%, oklch(62% 0.19 ${SECTION_HUE} / 0.35) 100%)`,
    transformOrigin: "left",
    transition: "transform 240ms var(--ease-out-expo)",
  } as CSSProperties,
  consoleRatio: {
    ...mono,
    fontSize: 10,
    letterSpacing: "0.1em",
    color: "rgba(235,235,245,0.45)",
    fontVariantNumeric: "tabular-nums",
  } as CSSProperties,
  epGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(12, 1fr)",
    gap: 6,
  } as CSSProperties,
  ep: (active: boolean): CSSProperties => ({
    aspectRatio: "1",
    borderRadius: 6,
    background: active
      ? `oklch(68% 0.18 ${SECTION_HUE})`
      : "rgba(255,255,255,0.04)",
    border: active
      ? `1px solid oklch(82% 0.16 ${SECTION_HUE})`
      : "1px solid rgba(255,255,255,0.06)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    color: active ? "#000" : "rgba(235,235,245,0.60)",
    fontWeight: active ? 700 : 500,
    boxShadow: active
      ? `0 0 16px oklch(62% 0.19 ${SECTION_HUE} / 0.55)`
      : "none",
    transition: "all 180ms var(--ease-out-expo)",
    cursor: "pointer",
  }),
  demoCaption: {
    ...mono,
    marginTop: 14,
    fontSize: 11,
    color: "rgba(235,235,245,0.60)",
    letterSpacing: "0.04em",
  } as CSSProperties,
};

interface MiniPickerProps {
  dict: Dict;
}

function MiniPicker({ dict }: MiniPickerProps) {
  const differentiator = dict.landing.differentiator;
  const reduced = useReducedMotion();
  const [picked, setPicked] = useState<number>(5);
  const epLabelPrefix = differentiator.epLabelPrefix;
  const epLabelSuffix = differentiator.epLabelSuffix;
  const ratio = (picked + 1) / 12;
  return (
    <div style={s.demoRow}>
      <div style={s.demoHeader}>
        <span style={s.demoChip}>{differentiator.demoChip}</span>
        <h3 style={s.demoHeadline}>{differentiator.demoHeadline}</h3>
      </div>
      <div style={s.demo}>
        <div style={s.demoEyebrow}>{differentiator.demoEyebrow}</div>
        <div style={s.demoTitle}>{differentiator.demoTitle}</div>
        <div style={s.demoHint}>{differentiator.demoHint}</div>

        <div className="diff-console" style={s.console}>
          <span
            style={s.consoleLock}
            aria-live="polite"
            aria-atomic="true"
          >
            <span
              style={s.consoleLockDot}
              className="hud-blink"
              aria-hidden
            />
            LOCKED
          </span>
          <div style={s.consoleBarWrap}>
            <Motion.div
              style={s.consoleBarFill}
              initial={reduced ? false : { scaleX: 0 }}
              whileInView={reduced ? undefined : { scaleX: ratio }}
              animate={reduced ? { scaleX: ratio } : { scaleX: ratio }}
              viewport={HUD_VIEWPORT}
              transition={{ duration: 0.45, ease: [0.33, 1, 0.68, 1] }}
              aria-hidden
            />
          </div>
          <span style={s.consoleRatio}>
            {String(picked + 1).padStart(2, "0")} / 12
          </span>
        </div>

        <div style={s.epGrid}>
          {Array.from({ length: 12 }).map((_, i) => (
            <button
              key={i}
              type="button"
              style={s.ep(picked === i)}
              onClick={() => setPicked(i)}
              aria-label={`${epLabelPrefix}${i + 1}${epLabelSuffix}`}
              aria-pressed={picked === i}
            >
              {i + 1}
            </button>
          ))}
        </div>
        <div style={s.demoCaption}>
          {differentiator.demoCaptionPrefix}
          {String(picked + 1).padStart(2, "0")}
          {differentiator.demoCaptionSuffix}
        </div>
      </div>
    </div>
  );
}

interface DifferentiatorSectionProps {
  dict: Dict;
}

export default function DifferentiatorSection({
  dict,
}: DifferentiatorSectionProps) {
  const differentiator = dict.landing.differentiator;
  // dict carries typed `c1Claim / c1Body / c2Claim / ...` shapes; index via a string-keyed view.
  const diffMap = differentiator as unknown as Record<string, string>;
  return (
    <section style={s.section} aria-labelledby="diff-title">
      <style>{`
        @media (max-width: 880px) {
          .diff-grid { grid-template-columns: 1fr !important; gap: 40px !important; }
          .diff-sticky { position: static !important; }
        }
        @media (max-width: 560px) {
          .diff-console { grid-template-columns: 1fr !important; row-gap: 8px !important; }
        }
      `}</style>
      <SectionNum n="07" />
      <div className="container">
        <div className="diff-grid" style={s.grid}>
          <div className="diff-sticky" style={s.stickyLeft}>
            <ChapterBar hue={SECTION_HUE} style={{ top: 0, left: 0 }} />
            <SectionHeader
              eyebrow={differentiator.eyebrow}
              title={differentiator.title}
              sub={differentiator.sub}
              titleId="diff-title"
              style={s.headerOverride}
            />
          </div>
          <div style={s.list}>
            {itemKeys.map((it, i) => (
              <div
                key={it.num}
                style={{
                  ...s.row,
                  ...(i === itemKeys.length - 1 ? s.rowLast : null),
                }}
              >
                <div style={s.num}>{it.num}</div>
                <div>
                  <h3 style={s.claim}>{diffMap[`${it.key}Claim`]}</h3>
                  <p style={s.body}>{diffMap[`${it.key}Body`]}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <MiniPicker dict={dict} />
      </div>
    </section>
  );
}
