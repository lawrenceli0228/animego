"use client";

/**
 * Section 04 - Seven things, done on purpose.
 * Asymmetric 12-col bento: hero band (7+5, row-span 2), mid shelf (4+4+4), bottom (6+6).
 * Each card has a chapter-bar lead-in, staggered entrance, hover spotlight, and a hue-scoped
 * visual that doubles as product proof (OKLCH readouts, live counters, failover logs).
 */

import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { motion as Motion, useReducedMotion } from "motion/react";
import { SectionNum } from "./shared/hud";
import {
  PosterVisual,
  DanmakuVisual,
  TorrentVisual,
  ManualVisual,
  ResumeVisual,
  ScheduleVisual,
  DropVisual,
  MemberPassVisual,
} from "./features/visuals";
import type { PosterSlotMap } from "./features/visuals";
import type { Dict, Lang } from "@/lib/i18n";

type CardSize = "heroL" | "heroR" | "md" | "lg" | "full";
type VisualType = "poster" | "danmaku" | "multi" | "manual" | "resume" | "schedule" | "drop" | "memberpass";
type FeatureKey = "f1" | "f2" | "f3" | "f4" | "f5" | "f6" | "f7" | "f8";

interface FeatureShape {
  key: FeatureKey;
  size: CardSize;
  hue: number;
  visual: VisualType;
  hasCta: boolean;
  /** Real destination for the card CTA; defaults to "#" (placeholder). */
  ctaHref?: string;
}

const featureShape: FeatureShape[] = [
  { key: "f1", size: "heroL", hue: 330, visual: "poster",   hasCta: true  },
  { key: "f2", size: "heroR", hue: 210, visual: "danmaku",  hasCta: false },
  { key: "f3", size: "md",    hue: 155, visual: "multi",    hasCta: true  },
  { key: "f4", size: "md",    hue: 40,  visual: "manual",   hasCta: true  },
  { key: "f5", size: "md",    hue: 260, visual: "resume",   hasCta: true  },
  { key: "f6", size: "lg",    hue: 195, visual: "schedule", hasCta: true  },
  { key: "f7", size: "lg",    hue: 70,  visual: "drop",     hasCta: true  },
  { key: "f8", size: "full",  hue: 300, visual: "memberpass", hasCta: true, ctaHref: "/settings" },
];

const ENTRANCE_DELAYS = [0, 0.08, 0.18, 0.24, 0.30, 0.38, 0.44, 0.50];

type FeaturesDict = Dict["landing"]["features"];

function fStr(features: FeaturesDict, key: string): string {
  return (features as unknown as Record<string, string>)[key] ?? "";
}

const s = {
  section: {
    position: "relative",
    padding: "clamp(80px, 7vw, 120px) 0",
    background: "#000",
    overflow: "hidden",
  } as CSSProperties,
  colorBand: {
    position: "absolute",
    top: -120, right: -120,
    width: 640, height: 640,
    background: "radial-gradient(50% 50% at 50% 50%, oklch(32% 0.18 330 / 0.28) 0%, transparent 70%)",
    filter: "blur(40px)",
    pointerEvents: "none",
  } as CSSProperties,
  colorBand2: {
    position: "absolute",
    bottom: -180, left: -160,
    width: 560, height: 560,
    background: "radial-gradient(50% 50% at 50% 50%, oklch(32% 0.18 210 / 0.22) 0%, transparent 70%)",
    filter: "blur(50px)",
    pointerEvents: "none",
  } as CSSProperties,
  header: { maxWidth: 720, marginBottom: 64, position: "relative", zIndex: 1 } as CSSProperties,
  sectionEyebrow: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    letterSpacing: "0.12em",
    color: "rgba(235,235,245,0.30)",
    textTransform: "uppercase",
    marginBottom: 16,
  } as CSSProperties,
  sectionTitle: {
    fontFamily: "'Sora', sans-serif",
    fontSize: "clamp(2rem, 1rem + 3vw, 3.5rem)",
    fontWeight: 800,
    color: "#fff",
    letterSpacing: "-0.03em",
    lineHeight: 1.1,
    marginBottom: 20,
  } as CSSProperties,
  sectionSub: {
    fontSize: 16,
    color: "rgba(235,235,245,0.60)",
    lineHeight: 1.6,
    maxWidth: 560,
  } as CSSProperties,
  gridWrap: {
    width: "min(1600px, 100% - 32px)",
    marginLeft: "auto",
    marginRight: "auto",
    paddingLeft: "clamp(16px, 3vw, 32px)",
    paddingRight: "clamp(16px, 3vw, 32px)",
    position: "relative",
    zIndex: 1,
  } as CSSProperties,
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(12, 1fr)",
    gridAutoRows: "minmax(240px, auto)",
    gap: 20,
  } as CSSProperties,
  card: (hue: number): CSSProperties & Record<string, string | number> => ({
    position: "relative",
    padding: 28,
    borderRadius: 18,
    background: "#0d0d0f",
    border: "1px solid rgba(84,84,88,0.35)",
    overflow: "hidden",
    cursor: "default",
    "--hue": hue,
    display: "flex",
    flexDirection: "column",
  }),
  chapterBar: (hue: number): CSSProperties => ({
    position: "absolute",
    top: 28, left: 28,
    width: 3, height: 52,
    background: `oklch(62% 0.19 ${hue})`,
    borderRadius: 2,
    boxShadow: `0 0 24px oklch(62% 0.19 ${hue} / 0.55)`,
    transformOrigin: "top",
  }),
  textColumn: {
    marginLeft: 18,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
  } as CSSProperties,
  cardEyebrow: {
    paddingTop: 4,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: "rgba(235,235,245,0.7)",
    letterSpacing: "0.08em",
    marginBottom: 18,
  } as CSSProperties,
  cardTitle: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 22,
    fontWeight: 700,
    color: "#fff",
    letterSpacing: "-0.02em",
    lineHeight: 1.22,
    marginBottom: 10,
  } as CSSProperties,
  cardTitleHero: {
    fontSize: 26,
  } as CSSProperties,
  cardBody: {
    fontSize: 13.5,
    color: "rgba(235,235,245,0.6)",
    lineHeight: 1.6,
    maxWidth: "42ch",
  } as CSSProperties,
  cta: (hue: number): CSSProperties => ({
    display: "inline-block",
    marginTop: 16,
    padding: "7px 12px",
    borderRadius: 8,
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 12.5,
    fontWeight: 500,
    color: `oklch(78% 0.18 ${hue})`,
    background: `oklch(28% 0.12 ${hue} / 0.2)`,
    border: `1px solid oklch(62% 0.19 ${hue} / 0.35)`,
    textDecoration: "none",
    transition: "all 200ms var(--ease-out-expo)",
    cursor: "pointer",
  }),
  pullQuote: (hue: number): CSSProperties => ({
    marginTop: 14,
    paddingLeft: 14,
    borderLeft: `2px solid oklch(62% 0.19 ${hue} / 0.55)`,
    fontFamily: "'Sora', sans-serif",
    fontStyle: "italic",
    fontSize: 15,
    color: "rgba(235,235,245,0.85)",
    lineHeight: 1.4,
    maxWidth: "32ch",
  }),
};

interface VisualProps {
  type: VisualType;
  hue: number;
  lang: Lang;
  posters: PosterSlotMap;
  features: FeaturesDict;
  memberCardArt: string | null;
  memberCardBanner: string | null;
}

function Visual({ type, hue, lang, posters, features, memberCardArt, memberCardBanner }: VisualProps) {
  if (type === "poster")   return <PosterVisual      hue={hue} lang={lang} posters={posters} features={features} />;
  if (type === "danmaku")  return <DanmakuVisual     hue={hue} features={features} />;
  if (type === "multi")    return <TorrentVisual     hue={hue} features={features} />;
  if (type === "manual")   return <ManualVisual      hue={hue} features={features} />;
  if (type === "resume")   return <ResumeVisual      hue={hue} features={features} />;
  if (type === "schedule") return <ScheduleVisual    hue={hue} features={features} />;
  if (type === "drop")     return <DropVisual        hue={hue} features={features} />;
  if (type === "memberpass") return <MemberPassVisual hue={hue} features={features} lang={lang} art={memberCardArt} banner={memberCardBanner} />;
  return null;
}

function handleSpotlight(e: ReactMouseEvent<HTMLElement>): void {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
}

interface BentoCardProps {
  feat: FeatureShape;
  index: number;
  lang: Lang;
  reduced: boolean;
  posters: PosterSlotMap;
  features: FeaturesDict;
  memberCardArt: string | null;
  memberCardBanner: string | null;
}

function BentoCard({ feat, index, lang, reduced, posters, features, memberCardArt, memberCardBanner }: BentoCardProps) {
  const isHero = feat.size === "heroL" || feat.size === "heroR";

  return (
    <Motion.article
      className="bento-card"
      data-size={feat.size}
      data-visual={feat.visual}
      style={s.card(feat.hue)}
      onMouseMove={handleSpotlight}
      initial={reduced ? false : { opacity: 0, y: 24, scale: 0.985 }}
      whileInView={reduced ? undefined : { opacity: 1, y: 0, scale: 1 }}
      viewport={{ once: true, margin: "0px 0px -15% 0px" }}
      transition={{
        duration: 0.7,
        delay: ENTRANCE_DELAYS[index] ?? 0,
        ease: [0.16, 1, 0.3, 1],
      }}
    >
      <Motion.span
        className="bento-chapter-bar"
        style={s.chapterBar(feat.hue)}
        initial={reduced ? false : { scaleY: 0 }}
        whileInView={reduced ? undefined : { scaleY: 1 }}
        viewport={{ once: true, margin: "0px 0px -15% 0px" }}
        transition={{
          duration: 0.5,
          delay: Math.max(0, (ENTRANCE_DELAYS[index] ?? 0) - 0.06),
          ease: [0.16, 1, 0.3, 1],
        }}
      />
      <div style={s.textColumn}>
        <div style={s.cardEyebrow}>{fStr(features, `${feat.key}Eyebrow`)}</div>
        <h3 style={{ ...s.cardTitle, ...(isHero ? s.cardTitleHero : null) }}>
          {fStr(features, `${feat.key}Title`)}
        </h3>
        <p style={s.cardBody}>{fStr(features, `${feat.key}Body`)}</p>

        {feat.key === "f1" && (
          <div style={s.pullQuote(feat.hue)}>{features.f1Quote}</div>
        )}
        {feat.key === "f2" && (
          <div style={s.pullQuote(feat.hue)}>{features.f2Quote}</div>
        )}
      </div>

      <Visual type={feat.visual} hue={feat.hue} lang={lang} posters={posters} features={features} memberCardArt={memberCardArt} memberCardBanner={memberCardBanner} />

      {feat.hasCta && (
        <div style={s.textColumn}>
          <a href={feat.ctaHref ?? "#"} style={s.cta(feat.hue)} className="bento-cta">
            {fStr(features, `${feat.key}Cta`)}
          </a>
        </div>
      )}
    </Motion.article>
  );
}

interface FeaturesBentoProps {
  dict: Dict;
  posters: PosterSlotMap;
  /** Random in-season anime cover used as the f8 Member Pass card face. */
  memberCardArt?: string | null;
  /** Random 16:9 banner used as the f8 profile-preview backdrop. */
  memberCardBanner?: string | null;
}

export default function FeaturesBento({ dict, posters, memberCardArt = null, memberCardBanner = null }: FeaturesBentoProps) {
  const features = dict.landing.features;
  // Detect lang via stable Chinese sentinel in identity.airing (zh: '放送中', en: 'Airing').
  // landing/* code path-locks lang via dict identity; no cookies/headers on the client side.
  const lang: Lang = dict.landing.identity.airing === "放送中" ? "zh" : "en";
  const reduced = useReducedMotion();

  return (
    <section style={s.section} aria-labelledby="features-title">
      <div style={s.colorBand} aria-hidden />
      <div style={s.colorBand2} aria-hidden />
      <SectionNum n="04" />
      <style>{`
        .bento-card[data-size="heroL"] { grid-column: span 7; grid-row: span 2; }
        .bento-card[data-size="heroR"] { grid-column: span 5; grid-row: span 2; }
        .bento-card[data-size="md"]    { grid-column: span 4; }
        .bento-card[data-size="lg"]    { grid-column: span 6; }
        .bento-card[data-size="full"]  { grid-column: span 12; }
        @media (max-width: 1180px) {
          .bento-card[data-size="heroL"] { grid-column: span 12; grid-row: auto; }
          .bento-card[data-size="heroR"] { grid-column: span 12; grid-row: auto; }
          .bento-card[data-size="md"]    { grid-column: span 6; }
          .bento-card[data-size="lg"]    { grid-column: span 12; }
        }
        @media (max-width: 720px) {
          .bento-grid { grid-template-columns: 1fr !important; grid-auto-rows: auto !important; }
          .bento-card { grid-column: 1 / -1 !important; grid-row: auto !important; padding: 22px !important; }
        }
        .bento-card {
          --mx: 50%;
          --my: 50%;
          transition: transform 320ms var(--ease-out-expo),
                      border-color 260ms var(--ease-out-expo),
                      box-shadow 320ms var(--ease-out-expo);
        }
        .bento-card::before {
          content: '';
          position: absolute;
          inset: 0;
          pointer-events: none;
          opacity: 0;
          transition: opacity 240ms var(--ease-out-expo);
          background: radial-gradient(420px circle at var(--mx) var(--my), oklch(62% 0.19 var(--hue) / 0.14), transparent 55%);
          z-index: 0;
        }
        .bento-card:hover::before { opacity: 1; }
        .bento-card > * { position: relative; z-index: 1; }
        .bento-card:hover {
          transform: translateY(-5px);
          border-color: oklch(62% 0.19 var(--hue) / 0.45) !important;
          box-shadow: 0 18px 48px -14px oklch(62% 0.19 var(--hue) / 0.28) !important;
        }
        .bento-cta:hover {
          background: oklch(32% 0.14 var(--hue) / 0.3) !important;
          border-color: oklch(62% 0.19 var(--hue) / 0.6) !important;
          transform: translateY(-1px);
        }
      `}</style>
      <div className="container">
        <header style={s.header}>
          <div style={s.sectionEyebrow}>{features.eyebrow}</div>
          <h2 id="features-title" style={s.sectionTitle}>
            {features.title}
          </h2>
          <p style={s.sectionSub}>{features.sub}</p>
        </header>
      </div>

      <div style={s.gridWrap}>
        <div className="bento-grid" style={s.grid}>
          {featureShape.map((feat, i) => (
            <BentoCard
              key={feat.key}
              feat={feat}
              index={i}
              lang={lang}
              reduced={!!reduced}
              posters={posters}
              features={features}
              memberCardArt={memberCardArt}
              memberCardBanner={memberCardBanner}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
