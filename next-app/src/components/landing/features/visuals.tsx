"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  animate as animateValue,
  useInView,
  useReducedMotion,
} from "motion/react";
import { mono, label } from "../shared/hud-tokens";
import { CornerBrackets } from "../shared/hud";
import FadeImage from "@/components/ui/FadeImage";
import MemberPass from "@/components/profile/MemberPass";
import type { Dict, Lang } from "@/lib/i18n";
import type { LandingPoster } from "@/lib/types";

export { CornerBrackets };

// Shared poster slot map used by FeaturesBento -> PosterVisual.
// LandingPoster widens to TrendingItem | AnimeDetail so the page can fall
// back to the lighter trending row when detail enrichment lags. PosterVisual
// only reads fields common to both shapes.
export type PosterSlotMap = {
  frieren: LandingPoster | null;
  apoth: LandingPoster | null;
  losing: LandingPoster | null;
};

type FeaturesDict = Dict["landing"]["features"];

// f-block dict lookup by string key. Each feature string lives at
// dict.landing.features.<key>. Centralizing the cast keeps the visuals
// readable and bounded.
function fStr(features: FeaturesDict, key: string): string {
  return (features as unknown as Record<string, string>)[key] ?? "";
}

// --- f1 Poster Identity ------------------------------------------------

interface PosterRosterEntry {
  slot: keyof PosterSlotMap;
  title: string;
  titleEn: string;
  hue: number;
  rotate: number;
  z: number;
  x: number;
  y: number;
}

const POSTER_ROSTER: PosterRosterEntry[] = [
  { slot: "frieren", title: "葬送的芙莉莲", titleEn: "Frieren",     hue: 330, rotate: -4, z: 1, x: 0,   y: 16 },
  { slot: "apoth",   title: "药屋少女的呢喃", titleEn: "Apothecary", hue: 20,  rotate: 0,  z: 3, x: 92,  y: 0  },
  { slot: "losing",  title: "败犬女主太多了", titleEn: "Losing",     hue: 340, rotate: 3,  z: 2, x: 184, y: 24 },
];

interface PosterVisualProps {
  hue: number;
  lang: Lang;
  posters: PosterSlotMap;
  features: FeaturesDict;
}

export function PosterVisual({ hue, lang, posters, features }: PosterVisualProps) {
  return (
    <div style={{ position: "relative", marginTop: 20 }}>
      <div style={{ position: "relative", height: 220, marginBottom: 16 }}>
        <FadeImage
          src="/mascot-wink.png"
          alt=""
          aria-hidden="true"
          className="f1-mascot"
        />
        {POSTER_ROSTER.map((p, i) => {
          const cover = posters?.[p.slot]?.coverImageUrl ?? null;
          return (
          <div
            key={i}
            className="poster-tile"
            style={{
              position: "absolute", left: p.x, top: p.y, width: 136,
              aspectRatio: "3/4", borderRadius: 8,
              overflow: "hidden",
              background: `
                linear-gradient(165deg, oklch(58% 0.2 ${p.hue}) 0%, oklch(28% 0.12 ${p.hue}) 60%, oklch(10% 0.04 ${p.hue}) 100%),
                radial-gradient(70% 50% at 30% 25%, oklch(70% 0.2 ${p.hue} / 0.55) 0%, transparent 60%)
              `,
              border: "1px solid rgba(255,255,255,0.08)",
              boxShadow: `0 18px 40px -12px oklch(58% 0.2 ${p.hue} / 0.5), inset 0 1px 0 rgba(255,255,255,0.08)`,
              transform: `rotate(${p.rotate}deg)`,
              zIndex: p.z,
              transition: "transform 400ms var(--ease-out-expo)",
            }}
          >
            {cover ? (
              <FadeImage
                src={cover}
                alt={p.title}
                style={{
                  position: "absolute", inset: 0,
                  width: "100%", height: "100%", objectFit: "cover",
                  filter: "saturate(1.05)",
                }}
              />
            ) : null}
            {cover ? (
              <div style={{
                position: "absolute", inset: 0,
                background: `linear-gradient(180deg, oklch(58% 0.2 ${p.hue} / 0.0) 40%, oklch(10% 0.04 ${p.hue} / 0.85) 100%)`,
                pointerEvents: "none",
              }} />
            ) : null}
            <div style={{
              position: "absolute", top: 6, right: 6,
              display: "flex", alignItems: "center", gap: 4,
              padding: "3px 5px", borderRadius: 4,
              background: "rgba(0,0,0,0.72)",
              ...mono, fontSize: 8.5, color: "#fff",
            }}>
              <span style={{ width: 6, height: 6, borderRadius: 2, background: `oklch(62% 0.19 ${p.hue})` }} />
              {p.hue}°
            </div>
            <div style={{
              position: "absolute", left: 6, right: 6, bottom: 6,
              fontFamily: "'Sora', sans-serif", fontSize: 9, fontWeight: 700,
              color: "#fff", textShadow: "0 1px 2px rgba(0,0,0,0.85)", letterSpacing: "-0.01em",
            }}>{lang === "en" ? p.titleEn : p.title}</div>
          </div>
          );
        })}
      </div>

      {/* OKLCH spec block */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12,
        padding: "12px 14px", borderRadius: 8,
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,255,255,0.06)",
        ...mono, fontSize: 10.5, marginBottom: 12,
      }}>
        <div>
          <div style={{ color: "rgba(235,235,245,0.3)", marginBottom: 4 }}>INPUT</div>
          <div style={{ color: "rgba(235,235,245,0.85)", lineHeight: 1.7 }}>
            cover.jpg<br />dominant k=5<br />k-means + Lab
          </div>
        </div>
        <div>
          <div style={{ color: `oklch(78% 0.18 ${hue})`, marginBottom: 4 }}>OUTPUT</div>
          <div style={{ color: "rgba(235,235,245,0.85)", lineHeight: 1.7 }}>
            oklch(62% .19 {hue})<br />deltaE vs bg: 2.1<br />AA 7.4:1
          </div>
        </div>
      </div>

      {/* deltaE contrast bar */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ ...label, marginBottom: 6 }}>{features.f1DeltaLabel}</div>
        <div style={{
          position: "relative", height: 10, borderRadius: 3,
          background: "linear-gradient(90deg, oklch(62% 0.2 150 / 0.35) 0%, oklch(62% 0.2 60 / 0.35) 45%, oklch(62% 0.2 25 / 0.35) 100%)",
          border: "1px solid rgba(255,255,255,0.06)",
        }}>
          <div style={{
            position: "absolute", top: "50%", left: "30%",
            width: 1, height: 18, marginTop: -9, marginLeft: -0.5,
            background: "rgba(255,255,255,0.22)", borderLeft: "1px dashed rgba(255,255,255,0.35)",
          }} />
          {/* OKLCH dot (low deltaE, safe) */}
          <div style={{
            position: "absolute", top: "50%", left: "18%",
            width: 12, height: 12, marginTop: -6, marginLeft: -6, borderRadius: "50%",
            background: `oklch(68% 0.19 ${hue})`,
            boxShadow: `0 0 0 2px rgba(0,0,0,0.6), 0 0 10px oklch(68% 0.19 ${hue})`,
          }} />
          {/* raw dot (high deltaE) */}
          <div style={{
            position: "absolute", top: "50%", left: "72%",
            width: 10, height: 10, marginTop: -5, marginLeft: -5, borderRadius: "50%",
            background: "oklch(60% 0.22 28)",
            boxShadow: "0 0 0 2px rgba(0,0,0,0.6)",
          }} />
        </div>
        <div style={{
          display: "flex", justifyContent: "space-between",
          ...mono, fontSize: 9.5, marginTop: 6, color: "rgba(235,235,245,0.55)",
        }}>
          <span>
            <span style={{
              display: "inline-block", width: 6, height: 6, borderRadius: 2, marginRight: 5,
              background: `oklch(68% 0.19 ${hue})`, verticalAlign: "middle",
            }} />
            {features.f1DeltaOk} - 2.1
          </span>
          <span style={{ color: "rgba(235,235,245,0.4)" }}>{features.f1AaNote}</span>
          <span>
            {features.f1DeltaRaw} - 6.8
            <span style={{
              display: "inline-block", width: 6, height: 6, borderRadius: 2, marginLeft: 5,
              background: "oklch(60% 0.22 28)", verticalAlign: "middle",
            }} />
          </span>
        </div>
      </div>

      <div style={{ ...mono, fontSize: 10, color: "rgba(235,235,245,0.45)" }}>
        {features.f1Caption}
      </div>
    </div>
  );
}

// --- f2 Danmaku --------------------------------------------------------

interface DanmakuBullet {
  t: string;
  x: number;
  y: number;
  size: number;
  op: number;
  pin?: boolean;
}

const DANMAKU_BULLETS: DanmakuBullet[] = [
  { t: "这帧神了",      x: 8,  y: 18, size: 13, op: 1,   pin: false },
  { t: "前方高能 !",    x: 38, y: 12, size: 14, op: 1,   pin: true  },
  { t: "OP 又来了泪目", x: 64, y: 22, size: 12, op: 0.85 },
  { t: "芙莉莲 yyds",  x: 12, y: 42, size: 12, op: 0.75 },
  { t: "这 BGM 是神",  x: 52, y: 38, size: 13, op: 0.95 },
  { t: "第三次循环",    x: 24, y: 58, size: 11, op: 0.6  },
  { t: "预告杀",        x: 70, y: 52, size: 13, op: 1,   pin: true },
  { t: "+1",           x: 84, y: 62, size: 11, op: 0.7  },
  { t: "这分镜绝了",    x: 6,  y: 72, size: 12, op: 0.8  },
  { t: "今年最佳",      x: 42, y: 78, size: 12, op: 0.75 },
];

// 60-cell density strip; values sampled from a pseudo-real curve with 3 peaks
const DENSITY_CELLS: number[] = Array.from({ length: 60 }, (_, i) => {
  const peak1 = Math.exp(-((i - 10) ** 2) / 14) * 0.95;    // 04:10 incoming
  const peak2 = Math.exp(-((i - 30) ** 2) / 22) * 0.75;    // mid
  const peak3 = Math.exp(-((i - 47) ** 2) / 10) * 1.0;     // 18:42 surge
  const base = 0.18 + (Math.sin(i * 0.7) + 1) * 0.06;
  return Math.min(1, base + peak1 + peak2 + peak3);
});

interface DanmakuVisualProps {
  hue: number;
  features: FeaturesDict;
}

export function DanmakuVisual({ hue, features }: DanmakuVisualProps) {
  return (
    <div style={{ marginTop: 20 }}>
      {/* frozen frame */}
      <div style={{
        position: "relative", aspectRatio: "16/10", borderRadius: 10,
        background: `
          radial-gradient(70% 50% at 35% 25%, oklch(25% 0.12 ${hue} / 0.55) 0%, transparent 60%),
          linear-gradient(180deg, #0a1020 0%, #05070d 100%)
        `,
        border: "1px solid rgba(255,255,255,0.06)", overflow: "hidden",
      }}>
        <div style={{
          position: "absolute", left: "38%", top: 0, bottom: 0, width: 1,
          background: `oklch(70% 0.16 ${hue} / 0.45)`,
          boxShadow: `0 0 6px oklch(70% 0.16 ${hue})`,
        }} />
        {DANMAKU_BULLETS.map((b, i) => (
          <span key={i} style={{
            position: "absolute", left: `${b.x}%`, top: `${b.y}%`,
            fontFamily: "'DM Sans', sans-serif", fontSize: b.size,
            fontWeight: b.pin ? 600 : 400,
            color: b.pin ? `oklch(85% 0.14 ${hue})` : "#fff",
            opacity: b.op, textShadow: "0 1px 2px rgba(0,0,0,0.92)",
            whiteSpace: "nowrap", pointerEvents: "none",
          }}>{b.t}</span>
        ))}
        <div style={{
          position: "absolute", right: 10, bottom: 10,
          display: "flex", alignItems: "center", gap: 8,
          padding: "4px 8px", borderRadius: 6,
          background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)",
          ...mono, fontSize: 9.5, color: "#fff",
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: 9999,
            background: `oklch(70% 0.18 ${hue})`,
            animation: "hudBlink 2.4s ease-in-out infinite",
          }} />
          EP 04 - 12:34 / 23:40
        </div>
      </div>

      {/* density timeline */}
      <div style={{ marginTop: 16 }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "baseline",
          marginBottom: 8,
        }}>
          <span style={label}>{features.f2TimelineLabel}</span>
          <span style={{ ...mono, fontSize: 10, color: `oklch(82% 0.14 ${hue})` }}>
            {features.f2Counter}
          </span>
        </div>
        <div className="density-strip" style={{
          position: "relative",
          display: "grid", gridTemplateColumns: `repeat(${DENSITY_CELLS.length}, 1fr)`, gap: 1,
          height: 28, padding: 2,
          background: "rgba(255,255,255,0.025)",
          borderRadius: 4, border: "1px solid rgba(255,255,255,0.05)",
        }}>
          {DENSITY_CELLS.map((v, i) => (
            <span key={i} style={{
              alignSelf: "end",
              height: `${10 + v * 90}%`,
              background: `oklch(${50 + v * 25}% ${0.08 + v * 0.14} ${hue} / ${0.4 + v * 0.55})`,
              borderRadius: 1,
            }} />
          ))}
          {/* playhead rail: full strip width - animates translateX so the 1px line scrubs
              41% -> 57% of strip (compositor-friendly, left-biased through the density peak) */}
          <div className="f2-playhead" style={{
            position: "absolute", top: -2, bottom: -2, left: 0, right: 0,
            pointerEvents: "none",
          }}>
            <div style={{
              position: "absolute", top: 0, bottom: 0, left: "41%",
              width: 1, background: `oklch(85% 0.15 ${hue})`,
              boxShadow: `0 0 6px oklch(85% 0.15 ${hue} / 0.7)`,
            }} />
          </div>
        </div>
      </div>

      {/* top-3 surge quotes */}
      <div style={{ marginTop: 14 }}>
        <div style={{ ...label, marginBottom: 6 }}>{features.f2SurgeLabel}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {[
            { k: "f2Surge1", n: 412 },
            { k: "f2Surge2", n: 287 },
            { k: "f2Surge3", n: 201 },
          ].map((row, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center",
              padding: "5px 8px", borderRadius: 5,
              background: "rgba(255,255,255,0.025)",
              border: "1px solid rgba(255,255,255,0.04)",
              ...mono, fontSize: 10.5,
            }}>
              <span style={{
                width: 14, textAlign: "center",
                color: "rgba(235,235,245,0.4)",
                marginRight: 8,
              }}>{i + 1}</span>
              <span style={{ flex: 1, color: "rgba(235,235,245,0.88)" }}>{fStr(features, row.k)}</span>
              <span style={{ color: `oklch(82% 0.16 ${hue})` }}>x{row.n}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- f3 Fansub / torrent lookup ---------------------------------------

interface AggSource {
  label: string;
  count: number;
}

const AGG_SOURCES: AggSource[] = [
  { label: "动漫花园", count: 72 },
  { label: "Nyaa",     count: 86 },
  { label: "ACG.RIP",  count: 20 },
];

interface Release {
  group: string;
  res: string;
  size: string;
  source: string;
  age: string;
}

const RELEASES: Release[] = [
  { group: "SubsPlease", res: "1080p", size: "1.4 GB", source: "花园", age: "2d" },
  { group: "LoliHouse",  res: "1080p", size: "2.1 GB", source: "Nyaa", age: "2d" },
  { group: "桜都字幕组",  res: "1080p", size: "1.8 GB", source: "花园", age: "3d" },
  { group: "VCB-Studio", res: "BD 1080p", size: "3.4 GB", source: "Nyaa", age: "batch" },
];

interface MagnetIconProps {
  hue: number;
}

function MagnetIcon({ hue }: MagnetIconProps) {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M3 2 v5 a4 4 0 0 0 8 0 v-5 h-2 v5 a2 2 0 0 1 -4 0 v-5 z"
        stroke={`oklch(78% 0.18 ${hue})`} strokeWidth="1.1" fill="none" strokeLinejoin="round" />
      <path d="M3 2 h2 M9 2 h2" stroke={`oklch(78% 0.18 ${hue})`} strokeWidth="1.1" />
    </svg>
  );
}

interface TorrentVisualProps {
  hue: number;
  features: FeaturesDict;
}

export function TorrentVisual({ hue, features }: TorrentVisualProps) {
  const total = AGG_SOURCES.reduce((a, b) => a + b.count, 0);
  const ref = useRef<HTMLDivElement | null>(null);
  const inView = useInView(ref, { once: true, margin: "-20% 0px" });
  const reduced = useReducedMotion();
  const animate = inView && !reduced;

  // count-up on total count; 1.0s duration aligns with cascade completion (490ms + 600ms ~= 1090ms)
  const [totalDisplay, setTotalDisplay] = useState<number>(reduced ? total : 0);
  useEffect(() => {
    if (!animate) return;
    const controls = animateValue(0, total, {
      duration: 1.0,
      delay: 0.1,
      ease: [0.33, 1, 0.68, 1],
      onUpdate: (v: number) => setTotalDisplay(Math.round(v)),
    });
    return () => controls.stop();
  }, [animate, total]);

  return (
    <div ref={ref} style={{ marginTop: 18 }}>
      {/* aggregator chip row */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        marginBottom: 12, flexWrap: "wrap",
      }}>
        <span style={{ ...label, marginRight: 4 }}>{features.f3AggLabel}</span>
        {AGG_SOURCES.map((src, i) => (
          <span key={i} style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "3px 8px", borderRadius: 5,
            background: `oklch(22% 0.07 ${hue} / 0.4)`,
            border: `1px solid oklch(62% 0.19 ${hue} / 0.3)`,
            ...mono, fontSize: 10, color: "rgba(235,235,245,0.9)",
          }}>
            {src.label}
            <span style={{ color: `oklch(82% 0.16 ${hue})` }}>{src.count}</span>
          </span>
        ))}
        <span style={{ ...mono, fontSize: 10, color: "rgba(235,235,245,0.45)", marginLeft: "auto" }}>
          {totalDisplay}{features.f3TotalSuffix}
        </span>
      </div>

      {/* release rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 12 }}>
        {RELEASES.map((r, i) => {
          const rowStyle: CSSProperties & Record<string, string | number> = {
            display: "flex", alignItems: "center", gap: 8,
            padding: "7px 10px", borderRadius: 7,
            background: "rgba(255,255,255,0.025)",
            border: "1px solid rgba(255,255,255,0.05)",
            ...mono, fontSize: 10.5, color: "rgba(235,235,245,0.85)",
          };
          if (animate) {
            rowStyle["--row-delay"] = `${0.22 + i * 0.09}s`;
          }
          return (
          <div key={i}
            className={animate ? "torrent-row" : undefined}
            style={rowStyle}>
            <span style={{
              padding: "2px 6px", borderRadius: 4,
              background: `oklch(22% 0.08 ${hue} / 0.5)`,
              border: `1px solid oklch(62% 0.19 ${hue} / 0.3)`,
              color: `oklch(85% 0.14 ${hue})`,
              fontSize: 9.5,
              letterSpacing: "0.04em",
              maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{r.group}</span>
            <span style={{
              padding: "1px 5px", borderRadius: 3,
              background: "rgba(255,255,255,0.06)",
              color: "rgba(235,235,245,0.7)",
              fontSize: 9,
            }}>{r.res}</span>
            <span style={{ flex: 1, color: "rgba(235,235,245,0.55)", textAlign: "right" }}>{r.size}</span>
            <span style={{ color: "rgba(235,235,245,0.4)", minWidth: 36, textAlign: "right" }}>{r.source}</span>
            <span style={{ color: "rgba(235,235,245,0.4)", minWidth: 32, textAlign: "right" }}>{r.age}</span>
            <MagnetIcon hue={hue} />
          </div>
          );
        })}
      </div>

      {/* filter tail */}
      <div style={{
        ...mono, fontSize: 10, color: "rgba(235,235,245,0.5)",
        letterSpacing: "0.04em",
      }}>
        {features.f3FilterLabel}
      </div>
    </div>
  );
}

// --- f4 Manual pick ---------------------------------------------------

type FlowState = "bad" | "pick" | "locked";

interface FlowTone {
  border: string;
  text: string;
  bg: string;
}

interface FlowCardProps {
  hue: number;
  state: FlowState;
  label: string;
  titleZh: string;
  sub: string;
}

function FlowCard({ hue, state, label: lbl, titleZh, sub }: FlowCardProps) {
  const tones: Record<FlowState, FlowTone> = {
    bad:    { border: "oklch(50% 0.18 25 / 0.55)",        text: "oklch(78% 0.18 25)",  bg: "oklch(20% 0.08 25 / 0.35)" },
    pick:   { border: "oklch(50% 0.18 230 / 0.45)",       text: "oklch(80% 0.14 230)", bg: "oklch(20% 0.06 230 / 0.35)" },
    locked: { border: `oklch(62% 0.19 ${hue} / 0.7)`,     text: `oklch(82% 0.18 ${hue})`, bg: `oklch(22% 0.08 ${hue} / 0.4)` },
  };
  const tone = tones[state];
  const locked = state === "locked";
  return (
    <div
      className={locked ? "flow-card-locked" : undefined}
      style={{
        flex: 1, padding: "12px 12px", borderRadius: 8,
        background: tone.bg, border: `1px solid ${tone.border}`,
        // when locked, box-shadow is owned by CSS (pulses in sync with arrow-dot-2 handoff)
        boxShadow: locked ? undefined : "none",
        minHeight: 84, display: "flex", flexDirection: "column", justifyContent: "space-between",
      }}
    >
      <div style={{ ...mono, fontSize: 9.5, color: tone.text, textTransform: "uppercase" }}>{lbl}</div>
      <div>
        <div style={{
          fontFamily: "'Sora', sans-serif", fontSize: 12.5, fontWeight: 700, color: "#fff",
          letterSpacing: "-0.01em", marginBottom: 2,
        }}>{titleZh}</div>
        <div style={{ ...mono, fontSize: 9, color: "rgba(235,235,245,0.55)" }}>{sub}</div>
      </div>
    </div>
  );
}

interface ManualVisualProps {
  hue: number;
  features: FeaturesDict;
}

export function ManualVisual({ hue, features }: ManualVisualProps) {
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{
        display: "flex", alignItems: "stretch", gap: 6, marginBottom: 14,
        position: "relative",
      }}>
        <FlowCard hue={hue} state="bad"    label="api"   titleZh={features.f4StepMatched} sub="ep.3 -> actually ep.4 X" />
        <div className="flow-arrow" style={{
          alignSelf: "center", ...mono, fontSize: 14, color: "rgba(235,235,245,0.35)",
          width: 16, textAlign: "center", position: "relative",
        }}>
          <span className="arrow-dot arrow-dot-1" style={{
            position: "absolute", top: "50%", left: 0, width: 4, height: 4, marginTop: -2,
            borderRadius: 9999, background: "oklch(80% 0.2 230)",
            boxShadow: "0 0 8px oklch(80% 0.2 230)",
            opacity: 0,
          }} />
          {String.fromCharCode(8594)}
        </div>
        <FlowCard hue={hue} state="pick"   label="user"  titleZh={features.f4StepPick}    sub="ep.4 - locked" />
        <div className="flow-arrow" style={{
          alignSelf: "center", ...mono, fontSize: 14, color: "rgba(235,235,245,0.35)",
          width: 16, textAlign: "center", position: "relative",
        }}>
          <span className="arrow-dot arrow-dot-2" style={{
            position: "absolute", top: "50%", left: 0, width: 4, height: 4, marginTop: -2,
            borderRadius: 9999, background: `oklch(82% 0.18 ${hue})`,
            boxShadow: `0 0 8px oklch(82% 0.18 ${hue})`,
            opacity: 0,
          }} />
          {String.fromCharCode(8594)}
        </div>
        <FlowCard hue={hue} state="locked" label="saved" titleZh={features.f4StepLocked}  sub={`oklch 62% 0.19 ${hue}`} />
      </div>

      <div style={{
        padding: "9px 11px", borderRadius: 7,
        background: `oklch(22% 0.08 ${hue} / 0.3)`,
        border: `1px solid oklch(62% 0.19 ${hue} / 0.3)`,
        ...mono, fontSize: 10.5, color: "rgba(235,235,245,0.88)",
        letterSpacing: "0.04em", marginBottom: 10,
      }}>
        {features.f4WeekStat}
      </div>

      <div style={{ ...mono, fontSize: 10, color: "rgba(235,235,245,0.5)", letterSpacing: "0.04em" }}>
        {features.f4KbdHint}
      </div>
    </div>
  );
}

// Bridge: FlowCard takes `label` as 2nd-name through rest-prop destructuring above.
// (Kept as a no-op symbol here to keep diff minimal vs legacy.)

// --- f5 Continue watching ---------------------------------------------

interface ResumeRow {
  key: string;
  hue: number;
  pct: number;
}

const RESUME_ROWS: ResumeRow[] = [
  { key: "f5Row1", hue: 330, pct: 0.796 },
  { key: "f5Row2", hue: 20,  pct: 0.214 },
  { key: "f5Row3", hue: 340, pct: 0.947 },
];

interface ProgressRingProps {
  pct: number;
  hue: number;
  animate: boolean;
  reduced: boolean;
  delay?: number;
}

function ProgressRing({ pct, hue, animate, reduced, delay = 0 }: ProgressRingProps) {
  const r = 12;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - pct);
  const target = Math.round(pct * 100);
  // reduced-motion: static filled. otherwise: start empty, let CSS + JS draw in on enter.
  const initialOffset = reduced ? offset : c;

  // count-up on the numeric readout, synced with ringDraw curve + delay
  const [display, setDisplay] = useState<number>(reduced ? target : 0);
  useEffect(() => {
    if (!animate) return;
    const controls = animateValue(0, target, {
      duration: 1.1,
      delay,
      ease: [0.33, 1, 0.68, 1],
      onUpdate: (v: number) => setDisplay(Math.round(v)),
    });
    return () => controls.stop();
  }, [animate, target, delay]);

  const ringStyle: CSSProperties & Record<string, string | number> | undefined = animate
    ? {
        "--ring-c": c,
        "--ring-offset": offset,
        "--ring-delay": `${delay}s`,
      }
    : undefined;

  return (
    <svg width="30" height="30" viewBox="0 0 30 30" style={{ flexShrink: 0 }} aria-hidden="true">
      <circle cx="15" cy="15" r={r} stroke="rgba(255,255,255,0.08)" strokeWidth="2.5" fill="none" />
      <circle cx="15" cy="15" r={r} stroke={`oklch(72% 0.17 ${hue})`} strokeWidth="2.5" fill="none"
        strokeDasharray={c} strokeDashoffset={initialOffset} strokeLinecap="round"
        transform="rotate(-90 15 15)"
        className={animate ? "ring-draw" : undefined}
        style={ringStyle}
      />
      <text x="15" y="18" textAnchor="middle" fill="#fff" fontSize="8" fontFamily="'JetBrains Mono', monospace">
        {display}
      </text>
    </svg>
  );
}

interface ResumeVisualProps {
  hue: number;
  features: FeaturesDict;
}

export function ResumeVisual({ hue, features }: ResumeVisualProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inView = useInView(ref, { once: true, margin: "-20% 0px" });
  const reduced = useReducedMotion();
  const animate = inView && !reduced;
  return (
    <div ref={ref} style={{ marginTop: 18 }}>
      <div style={{
        marginBottom: 12, padding: "8px 10px", borderRadius: 6,
        background: `oklch(22% 0.08 ${hue} / 0.35)`,
        border: `1px solid oklch(62% 0.19 ${hue} / 0.3)`,
        ...mono, fontSize: 10, color: `oklch(82% 0.14 ${hue})`, letterSpacing: "0.04em",
      }}>
        {features.f5NextDrop}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {RESUME_ROWS.map((row, i) => (
          <div key={i} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "8px 10px", borderRadius: 8,
            background: "rgba(255,255,255,0.025)",
            border: "1px solid rgba(255,255,255,0.05)",
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: 6, flexShrink: 0,
              background: `
                linear-gradient(155deg, oklch(55% 0.2 ${row.hue}) 0%, oklch(22% 0.1 ${row.hue}) 100%),
                radial-gradient(80% 50% at 30% 20%, oklch(70% 0.2 ${row.hue} / 0.5) 0%, transparent 60%)
              `,
              border: "1px solid rgba(255,255,255,0.06)",
            }} />
            <div style={{
              flex: 1, ...mono, fontSize: 11, color: "rgba(235,235,245,0.88)",
            }}>{fStr(features, row.key)}</div>
            <ProgressRing pct={row.pct} hue={row.hue} animate={animate} reduced={!!reduced} delay={0.14 + i * 0.14} />
          </div>
        ))}
      </div>
    </div>
  );
}

// --- f6 Weekly schedule -----------------------------------------------

interface WeekDay {
  key: string;
  dots: number;
  today?: boolean;
}

const WEEK: WeekDay[] = [
  { key: "f6Mon", dots: 2 },
  { key: "f6Tue", dots: 3 },
  { key: "f6Wed", dots: 4 },
  { key: "f6Thu", dots: 6 },
  { key: "f6Fri", dots: 5, today: true },
  { key: "f6Sat", dots: 4 },
  { key: "f6Sun", dots: 3 },
];

interface ScheduleVisualProps {
  hue: number;
  features: FeaturesDict;
}

export function ScheduleVisual({ hue, features }: ScheduleVisualProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inView = useInView(ref, { once: true, margin: "-20% 0px" });
  const reduced = useReducedMotion();
  const animate = inView && !reduced;
  return (
    <div ref={ref} style={{ marginTop: 18 }}>
      <div style={{
        position: "relative",
        display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8,
        marginBottom: 14,
      }}>
        {/* today-lock rail: sweeps across, locks on Fri (~64%), exits right.
            rail is full-width so translateX % maps to grid width, not line width. */}
        {animate && (
          <div className="schedule-sweep" style={{
            position: "absolute", top: -4, bottom: -4, left: 0, right: 0,
            pointerEvents: "none", zIndex: 2,
          }}>
            <div style={{
              position: "absolute", top: 0, bottom: 0, left: 0,
              width: 1, background: `oklch(88% 0.15 ${hue})`,
              boxShadow: `0 0 6px oklch(88% 0.15 ${hue} / 0.7)`,
            }} />
          </div>
        )}
        {WEEK.map((d, i) => {
          const active = d.today;
          return (
            <div key={i} style={{
              position: "relative",
              padding: "10px 6px 12px",
              borderRadius: 8, textAlign: "center",
              background: active ? `oklch(22% 0.08 ${hue} / 0.45)` : "rgba(255,255,255,0.025)",
              border: active
                ? `1px solid oklch(62% 0.19 ${hue} / 0.6)`
                : "1px solid rgba(255,255,255,0.05)",
              boxShadow: active ? `0 0 16px oklch(62% 0.19 ${hue} / 0.25)` : "none",
            }}>
              <div style={{
                ...mono, fontSize: 10,
                color: active ? `oklch(85% 0.14 ${hue})` : "rgba(235,235,245,0.55)",
                marginBottom: 8, letterSpacing: "0.06em",
              }}>{fStr(features, d.key)}</div>
              <div style={{
                display: "flex", justifyContent: "center", gap: 3,
                height: 18, alignItems: "flex-end",
              }}>
                {Array.from({ length: d.dots }).map((_, j) => (
                  <span key={j} style={{
                    width: 4,
                    height: 6 + j * 2,
                    borderRadius: 1,
                    background: active
                      ? `oklch(${70 + j * 3}% 0.17 ${hue})`
                      : "rgba(235,235,245,0.35)",
                  }} />
                ))}
              </div>
              {active && (
                <div style={{
                  position: "absolute", top: 4, right: 4,
                  width: 4, height: 4, borderRadius: 9999,
                  background: `oklch(80% 0.18 ${hue})`,
                  boxShadow: `0 0 6px oklch(80% 0.18 ${hue})`,
                }} aria-hidden />
              )}
              {active && (
                <div style={{
                  position: "absolute", left: 6, right: 6, bottom: 2,
                  fontSize: 8.5, color: `oklch(85% 0.14 ${hue})`,
                  ...mono,
                }}>{features.f6Today}</div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "10px 12px", borderRadius: 8,
        background: `linear-gradient(90deg, oklch(22% 0.08 ${hue} / 0.4) 0%, rgba(0,0,0,0) 100%)`,
        border: `1px solid oklch(62% 0.19 ${hue} / 0.25)`,
      }}>
        <div style={{
          ...mono, fontSize: 9.5,
          color: `oklch(80% 0.14 ${hue})`,
          letterSpacing: "0.08em", textTransform: "uppercase",
          flexShrink: 0,
        }}>{features.f6NextAiringLabel}</div>
        <div style={{
          ...mono, fontSize: 11,
          color: "rgba(235,235,245,0.88)",
          letterSpacing: "0.04em",
        }}>{features.f6NextAiring}</div>
      </div>
    </div>
  );
}

// --- f7 Drop-to-play --------------------------------------------------

const ACCEPTED_EXT = [".mkv", ".mp4", ".webm", ".avi", ".srt", ".ass"];

interface DropVisualProps {
  hue: number;
  features: FeaturesDict;
}

export function DropVisual({ hue, features }: DropVisualProps) {
  return (
    <div style={{ marginTop: 18 }}>
      {/* drop zone tile - dashed border is rest state; SVG cursor scans the perimeter */}
      <div className="drop-zone" style={{
        position: "relative",
        padding: "28px 20px",
        borderRadius: 10,
        background: `radial-gradient(60% 80% at 50% 50%, oklch(22% 0.08 ${hue} / 0.35) 0%, transparent 70%)`,
        border: `1.5px dashed oklch(62% 0.19 ${hue} / 0.45)`,
        textAlign: "center",
        marginBottom: 14,
        overflow: "hidden",
      }}>
        {/* contour-scan cursor: a single bright segment laps the perimeter
            (inset 1.25 so the 2.5-wide stroke sits fully inside and isn't clipped) */}
        <svg className="drop-scan" aria-hidden="true"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 0 }}>
          <rect x="1.25" y="1.25"
            style={{ width: "calc(100% - 2.5px)", height: "calc(100% - 2.5px)" }}
            rx="8.75" ry="8.75"
            fill="none"
            stroke={`oklch(85% 0.16 ${hue})`}
            strokeWidth="2.5"
            strokeDasharray="28 9999"
            vectorEffect="non-scaling-stroke" />
        </svg>
        {/* file-icon SVG (off-axis -4deg for anti-template pop) */}
        <svg width="36" height="44" viewBox="0 0 36 44" fill="none"
          style={{ marginBottom: 8, transform: "rotate(-4deg)", position: "relative", zIndex: 1 }}
          aria-hidden>
          <path d="M4 4 h18 l10 10 v26 a2 2 0 0 1 -2 2 h-26 a2 2 0 0 1 -2 -2 v-34 a2 2 0 0 1 2 -2 z"
            stroke={`oklch(70% 0.15 ${hue})`} strokeWidth="1.5" fill={`oklch(18% 0.06 ${hue} / 0.35)`} />
          <path d="M22 4 v10 h10" stroke={`oklch(70% 0.15 ${hue})`} strokeWidth="1.5" fill="none" />
          <text x="18" y="32" textAnchor="middle" fontSize="8" fill={`oklch(85% 0.14 ${hue})`}
            fontFamily="'JetBrains Mono', monospace" letterSpacing="0.08em">MKV</text>
        </svg>
        <div style={{
          fontFamily: "'Sora', sans-serif", fontSize: 13, color: "#fff", marginBottom: 4,
          position: "relative", zIndex: 1,
        }}>{features.f7DropHint}</div>
      </div>

      {/* parser preview */}
      <div style={{
        padding: "10px 12px", borderRadius: 7,
        background: "rgba(0,0,0,0.45)",
        border: "1px solid rgba(255,255,255,0.05)",
        marginBottom: 10,
      }}>
        <div style={{ ...mono, fontSize: 10, color: "rgba(235,235,245,0.5)", marginBottom: 5 }}>
          {features.f7ParseIn}
        </div>
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          ...mono, fontSize: 11, color: `oklch(82% 0.16 ${hue})`,
        }}>
          <span style={{ color: "rgba(235,235,245,0.35)" }}>{String.fromCharCode(8627)}</span>
          {features.f7ParseOut}
        </div>
      </div>

      {/* accepts row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ ...mono, fontSize: 10, color: "rgba(235,235,245,0.4)", letterSpacing: "0.08em" }}>
          {features.f7AcceptsLabel.toUpperCase()}
        </span>
        {ACCEPTED_EXT.map((ext, i) => (
          <span key={i} style={{
            ...mono, fontSize: 10,
            padding: "3px 7px",
            borderRadius: 4,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            color: "rgba(235,235,245,0.75)",
          }}>{ext}</span>
        ))}
      </div>
    </div>
  );
}

// --- f8 Member Pass ----------------------------------------------------

interface MemberPassVisualProps {
  hue: number;
  features: FeaturesDict;
  lang: Lang;
  /** Portrait cover used as the card face / avatar. */
  art: string | null;
  /** Wide 16:9 banner used as the profile-preview backdrop (covers crop badly
   *  in a wide header). Falls back to `art` when no banner is available. */
  banner: string | null;
}

// Swatch hues for the "pick a backdrop" row - varied so it reads as a
// gallery of different shows, not a monochrome set.
const BACKDROP_HUES = [20, 200, 320, 95];

export function MemberPassVisual({ hue, features, lang, art, banner }: MemberPassVisualProps) {
  const zh = lang === "zh";
  const backdrop = banner ?? art; // wide banner preferred for the profile header
  return (
    <div style={{ marginTop: 20, display: "flex", gap: "clamp(24px, 3vw, 44px)", flexWrap: "wrap", alignItems: "center" }}>
      {/* 1) the real Member Pass card, identical to the profile / settings
            preview. artUrl = a random in-season cover; photoUrl null so the
            show art is the card face until the user uploads their own. */}
      <div style={{ flexShrink: 0 }}>
        <MemberPass
          username="@you"
          memberNo="AGC-000142"
          since="SINCE 2026"
          watchedCount={42}
          topSeason={zh ? "2026 春季" : "2026 Spring"}
          artUrl={art}
          photoUrl={null}
          lang={lang}
          lazy
        />
      </div>

      {/* 2) what YOU set: the two customizations + where the identity shows up */}
      <div style={{ flex: "0 1 280px", minWidth: 220, display: "flex", flexDirection: "column", gap: 20 }}>
        {/* (1) card photo */}
        <div>
          <div style={{ ...label, marginBottom: 9 }}>
            <span style={{ color: `oklch(80% 0.12 ${hue})` }}>{String.fromCharCode(9312)} </span>
            {fStr(features, "f8PhotoLabel")}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <div style={{
              position: "relative", width: 40, height: 40, borderRadius: 9999, flexShrink: 0,
              background: `conic-gradient(from 140deg, oklch(70% 0.16 ${hue}), oklch(60% 0.14 ${(hue + 60) % 360}), oklch(70% 0.16 ${hue}))`,
              border: "1.5px solid rgba(255,255,255,0.25)",
            }}>
              <span style={{
                position: "absolute", right: -3, bottom: -3, width: 17, height: 17, borderRadius: 9999,
                background: `oklch(64% 0.17 ${hue})`, display: "flex", alignItems: "center", justifyContent: "center",
                border: "1.5px solid #0d0d0f",
              }}>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#0a0a0e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V6" /><path d="M5 12l7-7 7 7" />
                </svg>
              </span>
            </div>
            <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "rgba(235,235,245,0.7)", lineHeight: 1.4 }}>
              {fStr(features, "f8PhotoHint")}
            </span>
          </div>
        </div>

        {/* (2) profile backdrop */}
        <div>
          <div style={{ ...label, marginBottom: 9 }}>
            <span style={{ color: `oklch(80% 0.12 ${hue})` }}>{String.fromCharCode(9313)} </span>
            {fStr(features, "f8PickLabel")}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {BACKDROP_HUES.map((h, i) => (
              <div key={i} style={{
                width: 48, height: 30, borderRadius: 6,
                background: `linear-gradient(135deg, oklch(44% 0.13 ${h}) 0%, oklch(20% 0.07 ${h}) 100%)`,
                border: i === 0 ? `2px solid oklch(75% 0.17 ${hue})` : "1px solid rgba(255,255,255,0.08)",
                boxShadow: i === 0 ? `0 0 14px oklch(62% 0.17 ${hue} / 0.4)` : "none",
              }} />
            ))}
          </div>
        </div>

        {/* synced everywhere */}
        <div>
          <div style={{ ...label, marginBottom: 8 }}>{fStr(features, "f8SyncLabel")}</div>
          {["f8Sync1", "f8Sync2", "f8Sync3"].map((k, i) => (
            <div key={k} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "9px 0",
              borderTop: i === 0 ? "none" : "1px solid rgba(84,84,88,0.28)",
            }}>
              <span style={{
                width: 20, height: 20, borderRadius: 9999, flexShrink: 0,
                background: `oklch(30% 0.10 ${hue} / 0.5)`,
                border: `1px solid oklch(62% 0.17 ${hue} / 0.45)`,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={`oklch(86% 0.14 ${hue})`} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              </span>
              <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "rgba(235,235,245,0.78)" }}>
                {fStr(features, k)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 3) live profile preview: how the picked backdrop reads on your page.
            Grows to absorb the wide tile so the section never looks half-empty. */}
      <div style={{ flex: "1 1 340px", minWidth: 280, alignSelf: "center" }}>
        <div style={{ ...label, marginBottom: 12 }}>{fStr(features, "f8PreviewLabel")}</div>
        <div style={{
          position: "relative", borderRadius: 14, overflow: "hidden",
          background: "#0d0d0f", border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: `0 20px 48px -16px rgba(0,0,0,0.7), 0 0 32px oklch(62% 0.17 ${hue} / 0.12)`,
        }}>
          {/* backdrop banner = the backdrop you picked */}
          <div style={{ position: "relative", height: 108 }}>
            {backdrop ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={backdrop} alt="" loading="lazy" decoding="async" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "center 35%" }} />
            ) : (
              <div style={{ position: "absolute", inset: 0, background: `linear-gradient(135deg, oklch(40% 0.13 ${hue}) 0%, oklch(20% 0.07 ${hue}) 100%)` }} />
            )}
            <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(0,0,0,0.05) 0%, rgba(13,13,15,0.88) 100%)" }} />
          </div>
          {/* avatar straddling the banner + name */}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 12, padding: "0 18px", marginTop: -32, position: "relative" }}>
            <div style={{
              width: 62, height: 62, borderRadius: 9999, flexShrink: 0,
              border: "3px solid #0d0d0f", overflow: "hidden", background: `oklch(30% 0.1 ${hue})`,
            }}>
              {art ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={art} alt="" loading="lazy" decoding="async" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : null}
            </div>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7, paddingBottom: 8 }}>
              <span style={{ fontFamily: "'Sora', sans-serif", fontWeight: 800, fontSize: 18, color: "#fff", letterSpacing: "-0.01em" }}>@you</span>
              <span style={{ width: 7, height: 7, borderRadius: 9999, background: `oklch(74% 0.18 ${hue})`, boxShadow: `0 0 8px oklch(74% 0.18 ${hue})` }} aria-hidden />
            </span>
          </div>
          {/* stats row */}
          <div style={{ padding: "12px 18px 16px", display: "flex", alignItems: "baseline", gap: 12, ...mono, fontSize: 11, color: "rgba(235,235,245,0.5)" }}>
            <span>
              <b style={{ fontFamily: "'Sora', sans-serif", fontSize: 15, color: "#fff", marginRight: 4 }}>42</b>
              {fStr(features, "f8PreviewWatched")}
            </span>
            <span style={{ color: "rgba(255,255,255,0.2)" }}>·</span>
            <span>2026 {zh ? "春季" : "Spring"}</span>
            <span style={{ color: "rgba(255,255,255,0.2)" }}>·</span>
            <span style={{ color: `oklch(80% 0.10 ${hue})` }}>#AGC-000142</span>
          </div>
        </div>
      </div>
    </div>
  );
}
