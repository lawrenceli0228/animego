"use client";

/**
 * Section 03 - Data Sources Tribute.
 * 48 sources across two reverse-direction marquee rows. Upgraded to HUD family:
 * single hue=40 signature, shared ChapterBar + SectionNum + SectionHeader,
 * chips are now SystemNodes (live-dot + idx + name + latency readout),
 * footer shows a relay bar with a count-up on the node total.
 * Source names stay verbatim across locales - they are proper nouns.
 */

import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { motion as Motion, useReducedMotion } from "motion/react";
import { mono, label, useCountUp, HUD_VIEWPORT } from "./shared/hud-tokens";
import { SectionNum, SectionHeader, ChapterBar } from "./shared/hud";
import type { Dict } from "@/lib/i18n";

const SECTION_HUE = 40;
// Section 03 "multi-source" essence = multi-color signal sources. 48 chip dots +
// latency cycle through 5 gamut-safe hues; each source gets its own hue, forming
// a colored rhythm scrolling through the marquee.
// Amber (P1) holds the lead as the section primary; the other 4 hues echo s07/s01/s08/s06.
interface ChipPalette {
  h: number;
  dotL: number;
  dotC: number;
  latL: number;
  latC: number;
}

const CHIP_PALETTE: ChipPalette[] = [
  { h: 40, dotL: 62, dotC: 0.19, latL: 72, latC: 0.15 }, // Amber (section 03 primary)
  { h: 195, dotL: 68, dotC: 0.13, latL: 74, latC: 0.11 }, // Cyan (section 07)
  { h: 330, dotL: 62, dotC: 0.19, latL: 72, latC: 0.14 }, // Magenta (section 01)
  { h: 110, dotL: 76, dotC: 0.17, latL: 80, latC: 0.14 }, // Lime (section 08 neighbor)
  { h: 260, dotL: 62, dotC: 0.19, latL: 72, latC: 0.14 }, // Violet (section 06)
];
// P2/P3 - local section tones, independent of the chip multi-hue rotation
const HUE_TERRA = 25; // chip hover border + wash (warm-pull)
const HUE_STRAW = 75; // footer 48-count number - paper-tone key metric

const rowA = [
  "AniList", "Bangumi", "弹弹Play", "TMDb", "AniDB", "Kitsu",
  "动漫花园", "豌豆字幕", "LoliHouse", "NC-Raws", "Lilith-Raws", "ANi",
  "喵萌奶茶屋", "桜都字幕組", "VCB-Studio", "千夏字幕组", "DMhY", "Mikan Project",
  "漫猫字幕社", "澄空学园", "极影字幕社", "悠哈璃羽", "萌番组", "北宇治字幕组",
];

const rowB = [
  "Bilibili", "AcFun", "爱奇艺", "腾讯视频", "优酷", "B 站国创",
  "Simkl", "LiveChart", "AniSearch", "MyAnimeList", "Anime News Network", "动漫之家",
  "MAL CDN", "AniList CDN", "TMDB Images", "nyaa.si", "Bangumi.moe", "动漫国字幕组",
  "风之圣殿", "花园字幕", "雪飄工作室", "诸神字幕组", "白目魔法屋", "Gugugu Subs",
];

/* Fake-but-believable latencies per source index. Static (not measured live) - the
 * point is giving each chip a distinct numeric identity, not a dashboard. */
const LATENCIES = [
  142, 98, 71, 180, 165, 112, 84, 203, 156, 119, 132, 94,
  168, 145, 176, 103, 127, 88, 152, 139, 197, 115, 91, 147,
  108, 164, 122, 189, 173, 96, 131, 157, 144, 102, 118, 183,
  125, 149, 111, 167, 134, 95, 178, 121, 106, 192, 153, 137,
];

type Direction = "A" | "B";

const s = {
  section: {
    position: "relative",
    padding: "clamp(72px, 6vw, 104px) 0",
    background: "#000",
    borderTop: "1px solid rgba(84,84,88,0.30)",
    borderBottom: "1px solid rgba(84,84,88,0.30)",
    overflow: "hidden",
  } as CSSProperties,
  headerWrap: {
    position: "relative",
    paddingLeft: 20,
  } as CSSProperties,
  marqueeWrap: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: 14,
    maskImage:
      "linear-gradient(90deg, transparent 0, #000 8%, #000 92%, transparent 100%)",
    WebkitMaskImage:
      "linear-gradient(90deg, transparent 0, #000 8%, #000 92%, transparent 100%)",
  } as CSSProperties,
  track: (dir: Direction, duration: number): CSSProperties => ({
    display: "flex",
    gap: 14,
    width: "max-content",
    animation: `tributeScroll${dir} ${duration}s linear infinite`,
  }),
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid rgba(84,84,88,0.45)",
    background: "rgba(255,255,255,0.02)",
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 13,
    fontWeight: 500,
    color: "rgba(235,235,245,0.72)",
    whiteSpace: "nowrap",
    transition: "all 200ms var(--ease-out-expo)",
    cursor: "default",
  } as CSSProperties,
  chipDot: (dotL: number, dotC: number, h: number): CSSProperties => ({
    width: 6,
    height: 6,
    borderRadius: 9999,
    background: `oklch(${dotL}% ${dotC} ${h})`,
    boxShadow: `0 0 8px oklch(${dotL}% ${dotC} ${h} / 0.6)`,
    flexShrink: 0,
    animation: "hudBlink 2.4s var(--ease-out-expo) infinite",
    animationDelay: "var(--blink-delay, 0s)",
  }),
  chipIdx: {
    ...mono,
    fontSize: 10,
    color: "rgba(235,235,245,0.30)",
    letterSpacing: "0.06em",
  } as CSSProperties,
  chipName: {
    flex: "0 0 auto",
  } as CSSProperties,
  chipSep: {
    color: "rgba(235,235,245,0.18)",
    margin: "0 2px",
  } as CSSProperties,
  chipLatency: (latL: number, latC: number, h: number): CSSProperties => ({
    ...mono,
    fontSize: 10,
    color: `oklch(${latL}% ${latC} ${h} / 0.80)`,
    letterSpacing: "0.06em",
  }),
  footer: {
    marginTop: 56,
    paddingTop: 24,
    borderTop: "1px solid rgba(84,84,88,0.30)",
    display: "grid",
    gridTemplateColumns: "auto 1fr auto",
    columnGap: 24,
    rowGap: 8,
    alignItems: "center",
  } as CSSProperties,
  footerNodes: {
    ...mono,
    fontSize: 12,
    letterSpacing: "0.1em",
    color: "rgba(235,235,245,0.70)",
  } as CSSProperties,
  footerNodesNum: {
    color: `oklch(88% 0.08 ${HUE_STRAW})`,
    fontWeight: 600,
  } as CSSProperties,
  footerBarWrap: {
    position: "relative",
    height: 4,
    background: "rgba(235,235,245,0.08)",
    borderRadius: 2,
    overflow: "hidden",
  } as CSSProperties,
  footerBarFill: {
    position: "absolute",
    inset: 0,
    background: `linear-gradient(90deg, oklch(62% 0.19 ${SECTION_HUE} / 0.8) 0%, oklch(62% 0.19 ${SECTION_HUE} / 0.3) 100%)`,
    transformOrigin: "left",
  } as CSSProperties,
  footerStatus: {
    ...label,
    fontSize: 10,
    color: "rgba(235,235,245,0.45)",
  } as CSSProperties,
  // Visually hidden but available to assistive tech
  srOnly: {
    position: "absolute",
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    border: 0,
  } as CSSProperties,
};

interface SystemNodeProps {
  name: string;
  idx: number;
  latency: number;
  blinkPhase: string;
}

function SystemNode({ name, idx, latency, blinkPhase }: SystemNodeProps) {
  const palette = CHIP_PALETTE[idx % CHIP_PALETTE.length];
  const hover = (e: ReactMouseEvent<HTMLSpanElement>) => {
    e.currentTarget.style.borderColor = `oklch(60% 0.09 ${HUE_TERRA} / 0.65)`;
    e.currentTarget.style.background = `oklch(60% 0.09 ${HUE_TERRA} / 0.12)`;
    e.currentTarget.style.color = "#fff";
  };
  const leave = (e: ReactMouseEvent<HTMLSpanElement>) => {
    e.currentTarget.style.borderColor = "rgba(84,84,88,0.45)";
    e.currentTarget.style.background = "rgba(255,255,255,0.02)";
    e.currentTarget.style.color = "rgba(235,235,245,0.72)";
  };
  // Custom property `--blink-delay` consumed by chipDot's animationDelay.
  const dotStyle = {
    ...s.chipDot(palette.dotL, palette.dotC, palette.h),
    ["--blink-delay" as string]: `${blinkPhase}s`,
  } as CSSProperties;
  return (
    <span style={s.chip} onMouseEnter={hover} onMouseLeave={leave}>
      <span className="hud-blink" style={dotStyle} aria-hidden />
      <span style={s.chipIdx}>{String(idx + 1).padStart(2, "0")}</span>
      <span style={s.chipName}>{name}</span>
      <span style={s.chipSep}>·</span>
      <span style={s.chipLatency(palette.latL, palette.latC, palette.h)}>
        {latency}ms
      </span>
    </span>
  );
}

interface FooterProps {
  footerNodesSuffix: string;
  footerStatus: string;
}

function Footer({ footerNodesSuffix, footerStatus }: FooterProps) {
  const reduced = useReducedMotion();
  const [countRef, nodes] = useCountUp(48, { duration: 1.4, delay: 0.2 });
  return (
    <div className="tribute-footer" style={s.footer}>
      <div ref={countRef} style={s.footerNodes}>
        <span style={s.footerNodesNum}>{nodes}</span>{" "}
        {footerNodesSuffix} · 03 RELAY · FAIL-OVER READY
      </div>
      <div style={s.footerBarWrap}>
        <Motion.div
          style={s.footerBarFill}
          initial={reduced ? false : { scaleX: 0 }}
          whileInView={reduced ? undefined : { scaleX: 1 }}
          viewport={HUD_VIEWPORT}
          transition={{ duration: 1.4, delay: 0.2, ease: [0.33, 1, 0.68, 1] }}
        />
      </div>
      <div style={s.footerStatus}>{footerStatus}</div>
    </div>
  );
}

interface DataSourcesTributeProps {
  dict: Dict;
}

export default function DataSourcesTribute({ dict }: DataSourcesTributeProps) {
  const tribute = dict.landing.tribute;
  const doubledA = [...rowA, ...rowA];
  const doubledB = [...rowB, ...rowB];

  return (
    <section style={s.section} aria-labelledby="tribute-title">
      <style>{`
        @keyframes tributeScrollA {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        @keyframes tributeScrollB {
          0%   { transform: translateX(-50%); }
          100% { transform: translateX(0); }
        }
        .tribute-marquee:hover .tribute-track {
          animation-play-state: paused;
        }
        @media (prefers-reduced-motion: reduce) {
          .tribute-track {
            animation: none !important;
            transform: none !important;
            flex-wrap: wrap;
            width: 100% !important;
            justify-content: center;
          }
          .tribute-wrap {
            mask-image: none !important;
            -webkit-mask-image: none !important;
          }
        }
        @media (max-width: 520px) {
          .tribute-footer {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
      <SectionNum n="03" />

      <div className="container">
        <div style={s.headerWrap}>
          <ChapterBar hue={SECTION_HUE} style={{ top: 0, left: 0 }} />
          <SectionHeader
            eyebrow={tribute.eyebrow}
            title={tribute.title}
            sub={tribute.sub}
            titleId="tribute-title"
          />
        </div>

        <ul style={s.srOnly} aria-label={tribute.srLabel}>
          {[...rowA, ...rowB].map((name, i) => (
            <li key={`sr-${i}`}>{name}</li>
          ))}
        </ul>

        <div
          className="tribute-marquee tribute-wrap"
          style={s.marqueeWrap}
          aria-hidden="true"
        >
          <div className="tribute-track" style={s.track("A", 60)}>
            {doubledA.map((name, i) => {
              const baseIdx = i % rowA.length;
              return (
                <SystemNode
                  key={`a-${i}`}
                  name={name}
                  idx={baseIdx}
                  latency={LATENCIES[baseIdx]}
                  blinkPhase={((baseIdx * 0.31) % 2.4).toFixed(2)}
                />
              );
            })}
          </div>
          <div className="tribute-track" style={s.track("B", 72)}>
            {doubledB.map((name, i) => {
              const baseIdx = i % rowB.length;
              return (
                <SystemNode
                  key={`b-${i}`}
                  name={name}
                  idx={baseIdx + rowA.length}
                  latency={LATENCIES[baseIdx + rowA.length]}
                  blinkPhase={((baseIdx * 0.41 + 1.1) % 2.4).toFixed(2)}
                />
              );
            })}
          </div>
        </div>

        <Footer
          footerNodesSuffix={tribute.footerNodesSuffix}
          footerStatus={tribute.footerStatus}
        />
      </div>
    </section>
  );
}
