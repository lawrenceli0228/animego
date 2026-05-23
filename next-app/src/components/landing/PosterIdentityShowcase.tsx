"use client";

/**
 * Section 05 - Poster Identity Showcase - three tinted "detail pages" demonstrating
 * "color IS identity". Each frame is hue-accented from its real cover (posterAccent
 * -> OKLCH-normalized). Section 05 is an intentional multi-hue beat; it does NOT compete
 * with section 04 because the hue IS the message here.
 *
 * HUD upgrade:
 *  - shared SectionNum + SectionHeader
 *  - replace the 3-bar decoration with a 5-stop OKLCH palette row (the signal
 *    this section actually wants to expose)
 *  - keep the colorBand + hover interactions (sample points, pulses, OKLCH
 *    readout) - those are section 05's core demo and already HUD-shaped.
 */

import type { CSSProperties } from "react";
import { mono } from "./shared/hud-tokens";
import { SectionNum, SectionHeader } from "./shared/hud";
import type { Dict, Lang } from "@/lib/i18n";
import type { TrendingItem } from "@/lib/types";

interface PaletteStop {
  l: number;
  c: number;
}

interface Frame {
  hue: number;
  title: string;
  format: string;
  episodes: string;
  coverImageUrl: string | null;
}

const FALLBACK_FRAMES: Frame[] = [
  { hue: 330, title: "-", format: "TV", episodes: "-", coverImageUrl: null },
  { hue: 40,  title: "-", format: "TV", episodes: "-", coverImageUrl: null },
  { hue: 155, title: "-", format: "TV", episodes: "-", coverImageUrl: null },
];
const FRAME_HUE_FALLBACK: number[] = [330, 40, 155];

// 5 OKLCH lightness stops that sample the same hue - "identity in 5 tones".
const PALETTE_STOPS: PaletteStop[] = [
  { l: 28, c: 0.08 },
  { l: 46, c: 0.15 },
  { l: 62, c: 0.19 },
  { l: 76, c: 0.16 },
  { l: 90, c: 0.08 },
];

// Inline pickTitle (parity with legacy utils/formatters.js). zh-first project audience.
function pickTitle(obj: TrendingItem, lang: Lang): string {
  if (lang === "zh") {
    return obj.titleChinese || obj.titleNative || obj.titleRomaji || obj.titleEnglish || "";
  }
  return obj.titleEnglish || obj.titleRomaji || "";
}

// posterAccent on the API is a hex string (e.g. "#9b3d6a") whose hue we need
// numerically for OKLCH math. Fall back to a chapter-stable hue when missing
// or unparseable. The legacy code took `posterAccent` directly because the
// old client never type-narrowed; we keep behavior parity but coerce safely.
function accentToHue(accent: string | null, fallback: number): number {
  if (accent == null) return fallback;
  const trimmed = accent.trim();
  // numeric string ("330") - rare but supported.
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && asNum >= 0 && asNum <= 360) return asNum;
  // hex "#rrggbb" - convert to HSL hue.
  const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (hex.length !== 6) return fallback;
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  if ([r, g, b].some((v) => Number.isNaN(v))) return fallback;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return fallback;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = Math.round(h * 60);
  if (h < 0) h += 360;
  return h;
}

const s = {
  section: {
    position: "relative",
    padding: "clamp(80px, 7vw, 120px) 0",
    overflow: "hidden",
    background: "#000",
  } as CSSProperties,
  colorBand: {
    position: "absolute",
    top: 0, left: 0, right: 0,
    height: "60%",
    background: `linear-gradient(90deg,
      oklch(32% 0.16 355 / 0.35) 0%,
      oklch(32% 0.16 200 / 0.35) 50%,
      oklch(32% 0.16 150 / 0.35) 100%)`,
    filter: "blur(120px)",
    pointerEvents: "none",
  } as CSSProperties,
  inner: { position: "relative", zIndex: 1 } as CSSProperties,
  row: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 24,
    alignItems: "start",
  } as CSSProperties,
  frameCard: (hue: number, offsetY: number): CSSProperties & Record<string, string | number> => ({
    position: "relative",
    aspectRatio: "3/4",
    borderRadius: 18,
    overflow: "hidden",
    background: `
      linear-gradient(180deg, oklch(10% 0.03 ${hue}) 0%, oklch(6% 0.01 ${hue}) 100%),
      radial-gradient(60% 40% at 50% 20%, oklch(45% 0.18 ${hue} / 0.45) 0%, transparent 60%)
    `,
    border: `1px solid oklch(62% 0.19 ${hue} / 0.55)`,
    boxShadow: `
      0 24px 60px -12px oklch(62% 0.19 ${hue} / 0.55),
      0 0 40px -8px oklch(62% 0.19 ${hue} / 0.35)
    `,
    transform: `translateY(${offsetY}px)`,
    transition: "transform 300ms var(--ease-out-expo)",
    "--offset-y": `${offsetY}px`,
  }),
  coverWrap: {
    position: "relative",
    margin: "22px 22px 16px",
  } as CSSProperties,
  cover: (hue: number): CSSProperties => ({
    position: "relative",
    aspectRatio: "3/4",
    borderRadius: 10,
    overflow: "hidden",
    background: `oklch(10% 0.04 ${hue})`,
    boxShadow: `0 8px 28px -6px oklch(58% 0.2 ${hue} / 0.45)`,
    border: "1px solid rgba(255,255,255,0.06)",
  }),
  coverImg: {
    position: "absolute", inset: 0,
    width: "100%", height: "100%",
    objectFit: "cover",
    display: "block",
  } as CSSProperties,
  coverTint: (hue: number): CSSProperties => ({
    position: "absolute", inset: 0,
    background: `linear-gradient(180deg, transparent 40%, oklch(18% 0.08 ${hue} / 0.45) 100%)`,
    pointerEvents: "none",
  }),
  samplePoint: (xPct: number, yPct: number, hue: number): CSSProperties => ({
    position: "absolute",
    left: `${xPct}%`, top: `${yPct}%`,
    width: 14, height: 14,
    marginLeft: -7, marginTop: -7,
    borderRadius: "50%",
    background: `oklch(62% 0.19 ${hue})`,
    boxShadow: `0 0 0 2px rgba(0,0,0,0.5), 0 0 12px oklch(62% 0.19 ${hue} / 0.9)`,
    opacity: 0,
    transform: "scale(0.4)",
    transition: "opacity 200ms var(--ease-out-expo), transform 200ms var(--ease-out-expo)",
    pointerEvents: "none",
  }),
  samplePulse: (xPct: number, yPct: number, hue: number): CSSProperties => ({
    position: "absolute",
    left: `${xPct}%`, top: `${yPct}%`,
    width: 14, height: 14,
    marginLeft: -7, marginTop: -7,
    borderRadius: "50%",
    border: `1.5px solid oklch(62% 0.19 ${hue})`,
    opacity: 0,
    pointerEvents: "none",
  }),
  oklchReadout: (hue: number): CSSProperties => ({
    position: "absolute",
    left: 12, right: 12, bottom: 12,
    padding: "8px 12px",
    borderRadius: 6,
    background: "rgba(0,0,0,0.72)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    border: `1px solid oklch(62% 0.19 ${hue} / 0.45)`,
    ...mono,
    fontSize: 10,
    color: "#fff",
    display: "flex", alignItems: "center", gap: 8,
    opacity: 0,
    transform: "translateY(6px)",
    transition: "opacity 220ms var(--ease-out-expo) 80ms, transform 220ms var(--ease-out-expo) 80ms",
    pointerEvents: "none",
  }),
  oklchSwatch: (hue: number): CSSProperties => ({
    width: 10, height: 10, borderRadius: 3,
    background: `oklch(62% 0.19 ${hue})`,
    boxShadow: `0 0 6px oklch(62% 0.19 ${hue} / 0.9)`,
    flexShrink: 0,
  }),
  meta: { padding: "0 22px 20px" } as CSSProperties,
  metaLabel: (hue: number): CSSProperties => ({
    ...mono,
    fontSize: 10,
    letterSpacing: "0.12em",
    color: `oklch(78% 0.15 ${hue})`,
    marginBottom: 6,
  }),
  metaTitle: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 17,
    fontWeight: 700,
    color: "#fff",
    letterSpacing: "-0.01em",
    marginBottom: 12,
  } as CSSProperties,
  paletteLabel: {
    ...mono,
    fontSize: 9,
    letterSpacing: "0.16em",
    color: "rgba(235,235,245,0.30)",
    marginBottom: 8,
  } as CSSProperties,
  paletteRow: {
    display: "grid",
    gridTemplateColumns: "repeat(5, 1fr)",
    gap: 4,
  } as CSSProperties,
  paletteStop: (hue: number, stop: PaletteStop): CSSProperties => ({
    height: 10,
    borderRadius: 2,
    background: `oklch(${stop.l}% ${stop.c} ${hue})`,
    boxShadow: stop.l >= 62 ? `0 0 8px oklch(${stop.l}% ${stop.c} ${hue} / 0.4)` : "none",
  }),
  caption: {
    marginTop: 40,
    textAlign: "center",
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 14,
    color: "rgba(235,235,245,0.60)",
    fontStyle: "italic",
  } as CSSProperties,
};

interface PosterIdentityShowcaseProps {
  dict: Dict;
  posters: TrendingItem[];
}

export default function PosterIdentityShowcase({ dict, posters }: PosterIdentityShowcaseProps) {
  const identity = dict.landing.identity;
  // Stable Chinese sentinel: identity.airing is '放送中' (zh) vs 'Airing' (en).
  const lang: Lang = identity.airing === "放送中" ? "zh" : "en";
  const airing = identity.airing;
  const epSuffix = identity.episodesSuffix;
  const frames: Frame[] = posters.length >= 3
    ? posters.slice(0, 3).map((p, i): Frame => ({
        hue: accentToHue(p.posterAccent, FRAME_HUE_FALLBACK[i] ?? 330),
        title: pickTitle(p, lang),
        format: p.format || "TV",
        episodes: p.episodes ? `${p.episodes}${epSuffix}` : airing,
        coverImageUrl: p.coverImageUrl,
      }))
    : FALLBACK_FRAMES;
  return (
    <section style={s.section} aria-labelledby="identity-title">
      <style>{`
        @media (max-width: 880px) {
          .showcase-row { grid-template-columns: 1fr !important; }
          .showcase-frame { transform: none !important; }
        }
        .showcase-frame:hover {
          transform: translateY(calc(var(--offset-y, 0px) - 6px)) !important;
        }
        @keyframes samplePulseAnim {
          0%   { transform: scale(0.6); opacity: 0.9; }
          100% { transform: scale(2.4); opacity: 0; }
        }
        .showcase-frame:hover .sample-point {
          opacity: 1 !important;
          transform: scale(1) !important;
        }
        .showcase-frame:hover .sample-pulse {
          animation: samplePulseAnim 1.6s var(--ease-out-expo) infinite;
        }
        .showcase-frame .sample-pulse:nth-child(2) { animation-delay: 0s; }
        .showcase-frame .sample-pulse:nth-child(3) { animation-delay: 0.4s; }
        .showcase-frame .sample-pulse:nth-child(4) { animation-delay: 0.8s; }
        .showcase-frame:hover .oklch-readout {
          opacity: 1 !important;
          transform: translateY(0) !important;
        }
        @media (prefers-reduced-motion: reduce) {
          .showcase-frame:hover { transform: translateY(var(--offset-y, 0px)) !important; }
          .sample-pulse { animation: none !important; }
          .showcase-frame { transition: none !important; }
        }
      `}</style>
      <SectionNum n="05" />
      <div style={s.colorBand} aria-hidden />
      <div className="container" style={s.inner}>
        <SectionHeader
          eyebrow={identity.eyebrow}
          title={identity.title}
          sub={identity.sub}
          titleId="identity-title"
          style={{ marginBottom: 72 }}
        />

        <div className="showcase-row" style={s.row}>
          {frames.map((f, i) => (
            <div key={i} className="showcase-frame" style={s.frameCard(f.hue, i === 1 ? -24 : 0)}>
              <div style={s.coverWrap}>
                <div style={s.cover(f.hue)}>
                  {f.coverImageUrl ? (
                    <img src={f.coverImageUrl} alt={f.title} style={s.coverImg} loading="lazy" />
                  ) : null}
                  <div style={s.coverTint(f.hue)} aria-hidden />
                </div>
                <span className="sample-pulse" style={s.samplePulse(28, 28, f.hue)} aria-hidden />
                <span className="sample-pulse" style={s.samplePulse(62, 44, f.hue)} aria-hidden />
                <span className="sample-pulse" style={s.samplePulse(42, 72, f.hue)} aria-hidden />
                <span className="sample-point" style={s.samplePoint(28, 28, f.hue)} aria-hidden />
                <span className="sample-point" style={s.samplePoint(62, 44, f.hue)} aria-hidden />
                <span className="sample-point" style={s.samplePoint(42, 72, f.hue)} aria-hidden />
                <div className="oklch-readout" style={s.oklchReadout(f.hue)} aria-hidden>
                  <span style={s.oklchSwatch(f.hue)} />
                  <span>oklch(62% 0.19 {f.hue})</span>
                </div>
              </div>
              <div style={s.meta}>
                <div style={s.metaLabel(f.hue)}>{f.format} - {f.episodes}</div>
                <div style={s.metaTitle}>{f.title}</div>
                <div style={s.paletteLabel}>OKLCH - 5 STOPS</div>
                <div style={s.paletteRow} aria-hidden>
                  {PALETTE_STOPS.map((stop, idx) => (
                    <span key={idx} style={s.paletteStop(f.hue, stop)} />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>

        <p style={s.caption}>
          {identity.caption}
        </p>
      </div>
    </section>
  );
}
