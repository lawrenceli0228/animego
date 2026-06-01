"use client";

/**
 * §09 - FinalCta - editorial "end of issue" closer.
 * HUD upgrade: shared SectionNum, mask-reveal title, HUD-style CTA frame
 * (CornerBrackets + mono readout + hue underline) replacing the white pill.
 * The 3px multi-hue gradient bar stays - it's |09's signature callback to the
 * four chapter hues (330/210/155/40).
 *
 * NOTE: ASCII-only comments. Turbopack code-frame highlighter panics on Unicode
 * box-drawing chars (see P4.1.0).
 */

import type { CSSProperties } from "react";
import Link from "next/link";
import { motion as Motion, useReducedMotion } from "motion/react";
import { mono, HUD_VIEWPORT } from "./shared/hud-tokens";
import { SectionNum, CornerBrackets } from "./shared/hud";
import type { Dict } from "@/lib/i18n";

const CTA_HUE = 40;

const s = {
  section: {
    position: "relative",
    padding: "clamp(96px, 10vw, 144px) 0 clamp(72px, 8vw, 112px)",
    overflow: "hidden",
    background: "#000",
    borderTop: "1px solid rgba(84,84,88,0.30)",
  } as CSSProperties,
  chapterBar: {
    position: "absolute",
    top: 0, left: 0, right: 0,
    height: 3,
    background: `linear-gradient(90deg,
      oklch(62% 0.19 330) 0%,
      oklch(62% 0.19 210) 33%,
      oklch(62% 0.19 155) 66%,
      oklch(62% 0.19 40) 100%)`,
    opacity: 0.85,
    transformOrigin: "left",
  } as CSSProperties,
  grid: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)",
    gap: "clamp(32px, 5vw, 96px)",
    alignItems: "end",
  } as CSSProperties,
  eyebrow: {
    ...mono,
    fontSize: 12,
    letterSpacing: "0.12em",
    color: "rgba(235,235,245,0.30)",
    textTransform: "uppercase",
    marginBottom: 20,
  } as CSSProperties,
  titleMask: {
    display: "block",
  } as CSSProperties,
  title: {
    fontFamily: "'Sora', sans-serif",
    fontSize: "clamp(3rem, 1rem + 5.5vw, 6rem)",
    fontWeight: 800,
    color: "#fff",
    letterSpacing: "-0.04em",
    lineHeight: 0.98,
    margin: 0,
  } as CSSProperties,
  period: {
    color: `oklch(68% 0.2 ${CTA_HUE})`,
    textShadow: `0 0 40px oklch(68% 0.2 ${CTA_HUE} / 0.5)`,
  } as CSSProperties,
  rightCol: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 28,
    paddingBottom: 12,
  } as CSSProperties,
  sub: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 16,
    color: "rgba(235,235,245,0.60)",
    lineHeight: 1.65,
    maxWidth: "38ch",
  } as CSSProperties,
  ctaWrap: {
    position: "relative",
    display: "inline-flex",
    flexDirection: "column",
    gap: 6,
    padding: "18px 24px 18px 20px",
    textDecoration: "none",
    border: `1px solid oklch(62% 0.19 ${CTA_HUE} / 0.45)`,
    borderRadius: 4,
    background: `oklch(14% 0.04 ${CTA_HUE} / 0.45)`,
    transition: "border-color 200ms var(--ease-out-expo), background 200ms var(--ease-out-expo), transform 200ms var(--ease-out-expo)",
  } as CSSProperties,
  ctaLabel: {
    ...mono,
    fontSize: 10,
    letterSpacing: "0.16em",
    color: `oklch(82% 0.15 ${CTA_HUE})`,
    textTransform: "uppercase",
  } as CSSProperties,
  ctaMain: {
    display: "inline-flex",
    alignItems: "center",
    gap: 16,
    fontFamily: "'Sora', sans-serif",
    fontSize: 18,
    fontWeight: 700,
    color: "#fff",
    letterSpacing: "-0.01em",
  } as CSSProperties,
  ctaArrow: {
    ...mono,
    fontSize: 16,
    color: `oklch(82% 0.15 ${CTA_HUE})`,
    transition: "transform 220ms var(--ease-out-expo)",
  } as CSSProperties,
  ctaUnderline: {
    position: "absolute",
    left: 20, right: 24, bottom: 14,
    height: 1,
    background: `linear-gradient(90deg, oklch(62% 0.19 ${CTA_HUE}) 0%, oklch(62% 0.19 ${CTA_HUE} / 0.15) 100%)`,
    transformOrigin: "left",
  } as CSSProperties,
  metaRow: {
    marginTop: 72,
    display: "grid",
    gridTemplateColumns: "auto 1fr auto",
    alignItems: "center",
    gap: 24,
    paddingTop: 24,
    borderTop: "1px solid rgba(84,84,88,0.30)",
    ...mono,
    fontSize: 11,
    color: "rgba(235,235,245,0.30)",
    letterSpacing: "0.10em",
  } as CSSProperties,
  metaCenter: {
    textAlign: "center",
    color: "rgba(235,235,245,0.22)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as CSSProperties,
  metaEnd: {
    color: `oklch(72% 0.15 ${CTA_HUE} / 0.65)`,
    whiteSpace: "nowrap",
  } as CSSProperties,
};

interface FinalCtaProps {
  dict: Dict;
}

export default function FinalCta({ dict }: FinalCtaProps) {
  const reduced = useReducedMotion();
  const finalCta = dict.landing.finalCta;
  // Cheap lang inference: zh dict uses the full-width period; en uses ASCII.
  // Legacy code adjusted the period sizing only on `en` because '.' is tiny
  // relative to a full-width '。'.
  const isEn = finalCta.period === ".";

  const titleReveal = reduced
    ? {}
    : {
        initial: { clipPath: "inset(0 0 100% 0)" },
        whileInView: { clipPath: "inset(0 0 0% 0)" },
        viewport: HUD_VIEWPORT,
        transition: { duration: 1.0, ease: [0.33, 1, 0.68, 1] as [number, number, number, number] },
      };

  return (
    <section style={s.section} aria-labelledby="finalcta-heading">
      <style>{`
        @media (max-width: 880px) {
          .finalcta-grid { grid-template-columns: 1fr !important; gap: 40px !important; align-items: start !important; }
          .finalcta-title { font-size: clamp(2.75rem, 1rem + 7vw, 4.5rem) !important; }
          .finalcta-meta { grid-template-columns: 1fr !important; text-align: left !important; gap: 8px !important; }
          .finalcta-meta .finalcta-meta-center { text-align: left !important; }
        }
        .finalcta-cta:hover { border-color: oklch(72% 0.19 ${CTA_HUE} / 0.75) !important; background: oklch(18% 0.06 ${CTA_HUE} / 0.65) !important; transform: translateY(-2px); }
        .finalcta-cta:hover .finalcta-arrow { transform: translateX(4px); }
        .finalcta-cta:focus-visible {
          outline: 2px solid oklch(62% 0.19 ${CTA_HUE});
          outline-offset: 3px;
        }
        @media (prefers-reduced-motion: reduce) {
          .finalcta-cta:hover { transform: none !important; }
          .finalcta-cta:hover .finalcta-arrow { transform: none !important; }
        }
      `}</style>

      <Motion.div
        style={s.chapterBar}
        aria-hidden
        initial={reduced ? false : { scaleX: 0 }}
        whileInView={reduced ? undefined : { scaleX: 1 }}
        viewport={HUD_VIEWPORT}
        transition={{ duration: 1.2, ease: [0.33, 1, 0.68, 1] as [number, number, number, number] }}
      />
      <SectionNum n="09" />

      <div className="container">
        <div className="finalcta-grid" style={s.grid}>
          <div>
            <div style={s.eyebrow}>{finalCta.eyebrow}</div>
            <h2 id="finalcta-heading" className="finalcta-title" style={s.title}>
              <Motion.span style={s.titleMask} {...titleReveal}>
                {finalCta.titleLine1}
              </Motion.span>
              <Motion.span
                style={s.titleMask}
                {...(reduced
                  ? {}
                  : {
                      initial: { clipPath: "inset(0 0 100% 0)" },
                      whileInView: { clipPath: "inset(0 0 0% 0)" },
                      viewport: HUD_VIEWPORT,
                      transition: { duration: 1.0, delay: 0.15, ease: [0.33, 1, 0.68, 1] as [number, number, number, number] },
                    })}
              >
                {finalCta.titleLine2}
                <span style={{
                  ...s.period,
                  fontSize: isEn ? "1.3em" : undefined,
                  marginLeft: isEn ? "0.05em" : undefined,
                }}>{finalCta.period}</span>
              </Motion.span>
            </h2>
          </div>

          <div style={s.rightCol}>
            <p style={s.sub}>
              {finalCta.sub}
            </p>
            <Link href="/" className="finalcta-cta" style={s.ctaWrap}>
              <CornerBrackets inset={6} size={7} opacity={0.35} />
              <span style={s.ctaLabel} aria-hidden="true">[ ENTER ]</span>
              <span style={s.ctaMain}>
                {finalCta.cta}
                <span className="finalcta-arrow" style={s.ctaArrow} aria-hidden>→</span>
              </span>
              <Motion.span
                style={s.ctaUnderline}
                aria-hidden
                initial={reduced ? false : { scaleX: 0 }}
                whileInView={reduced ? undefined : { scaleX: 1 }}
                viewport={HUD_VIEWPORT}
                transition={{ duration: 0.8, delay: 0.4, ease: [0.33, 1, 0.68, 1] as [number, number, number, number] }}
              />
            </Link>
          </div>
        </div>

        <div className="finalcta-meta" style={s.metaRow}>
          <span>AnimeGoClub · v1.0.14</span>
          <span className="finalcta-meta-center" style={s.metaCenter}>
            ─────────── {finalCta.metaMaintenance} ───────────
          </span>
          <span style={s.metaEnd}>§ 01 — 09 · EOF</span>
        </div>
      </div>
    </section>
  );
}
