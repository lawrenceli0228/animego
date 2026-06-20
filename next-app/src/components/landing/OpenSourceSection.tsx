"use client";

/**
 * Section 08 - Open Source. The focal element is a real player + danmaku frame
 * (the product itself), with the open-source payload - a live Star-on-GitHub
 * CTA, contributor cluster, and source/self-host CTAs - overlaid on it like a
 * player OSD. This replaces the earlier dashboard-of-readouts: one dominant
 * artifact instead of a grid of evenly-weighted widgets.
 *
 * Editorially it is the proof behind the §06 differentiator and makes
 * FinalCta's `EOF` / version sign-off literally true: the source is on the
 * table, shown as the thing it actually builds.
 *
 * Hue 150 (green = open / go) sits clear of the neighbours - cyan 195 danmaku
 * above, chartreuse 70 FAQ below.
 *
 * Contribution affordances point ONLY at clean surfaces (player, danmaku,
 * tracking, i18n, self-host, design). The torrent/magnet subsystem is never
 * mentioned - the page invites by what it lists; the governance docs
 * (CONTRIBUTING / CODEOWNERS) carry the actual scope boundary.
 *
 * NOTE: ASCII-only comments. Turbopack code-frame highlighter panics on
 * Unicode box-drawing chars (see P4.1.0).
 */

import type { CSSProperties } from "react";
import { motion as Motion, useReducedMotion } from "motion/react";
import { mono, HUD_VIEWPORT, useCountUp } from "./shared/hud-tokens";
import { SectionNum, SectionHeader, ChapterBar } from "./shared/hud";
import FadeImage from "@/components/ui/FadeImage";
import type { Dict } from "@/lib/i18n";
import type { RepoStats } from "@/lib/github";
import type { LandingPoster, AnimeDetail } from "@/lib/types";

const SECTION_HUE = 150;
const HUE_ROSE = 330; // transient accent on the one "pop" pinned danmaku

const REPO_URL = "https://github.com/lawrenceli0228/animego";
const REPO_PATH = "github.com/lawrenceli0228/animego";
const CONTRIBUTING_URL = `${REPO_URL}/blob/main/CONTRIBUTING.md`;
const README_URL = `${REPO_URL}#readme`;
const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

// Deterministic danmaku-density heatmap for the scrubber (so SSR == client).
const HEATMAP = [
  3, 4, 6, 5, 7, 9, 6, 4, 5, 8, 11, 9, 6, 4, 3, 5, 7, 10, 13, 11,
  8, 6, 9, 12, 14, 11, 8, 5, 4, 6, 9, 7, 5, 8, 11, 14, 12, 9, 6, 4,
];

// A couple of anime danmaku bullets for the frame - it is showing the real
// player, so these stay in-world (not open-source slogans).
const LANE_A = ["这一帧封神", "周日刚需", "弹幕同屏太爽", "op 一响就泪目", "这作画给跪了", "同步率 101%"];
const LANE_B = ["前面高能", "这段 BGM 谁顶得住", "截下来当壁纸", "导演在说话", "一话顶一部"];

// Frozen "pinned" danmaku - the "three thousand voices in one frame" beat,
// merged in from the old standalone danmaku section.
interface Pinned { t: string; x: number; y: number; size: number; op: number; pop?: boolean }
const PINNED: Pinned[] = [
  { t: "每周日就等这个", x: 11, y: 40, size: 13, op: 0.95 },
  { t: "这分镜不得不服", x: 46, y: 52, size: 14, op: 1, pop: true },
  { t: "op 又来了泪目", x: 24, y: 64, size: 12, op: 0.86 },
];

const s = {
  section: {
    position: "relative",
    padding: "clamp(80px, 7vw, 120px) 0",
    background: "#000",
    borderTop: "1px solid rgba(84,84,88,0.30)",
  } as CSSProperties,
  headerWrap: {
    position: "relative",
    paddingLeft: 20,
    marginBottom: 44,
    maxWidth: 760,
  } as CSSProperties,
  headerOverride: { marginBottom: 0 } as CSSProperties,

  /* --- focal player + danmaku frame ----------------------------------- */
  frame: {
    position: "relative",
    aspectRatio: "16 / 9",
    borderRadius: 18,
    overflow: "hidden",
    background: `oklch(8% 0.03 ${SECTION_HUE})`,
    border: "1px solid rgba(255,255,255,0.06)",
    boxShadow: `0 32px 90px rgba(0,0,0,0.6), 0 0 80px oklch(62% 0.17 ${SECTION_HUE} / 0.10)`,
  } as CSSProperties,
  frameImg: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
    objectPosition: "center 28%",
    filter: "saturate(106%)",
    display: "block",
  } as CSSProperties,
  scrim: {
    position: "absolute",
    inset: 0,
    background: `
      linear-gradient(180deg, rgba(0,0,0,0.10) 0%, rgba(0,0,0,0.30) 42%, rgba(0,0,0,0.86) 100%),
      linear-gradient(90deg, rgba(0,0,0,0.55) 0%, transparent 55%)
    `,
    pointerEvents: "none",
  } as CSSProperties,

  /* top chrome: repo path + LIVE */
  topChrome: {
    position: "absolute",
    top: 16,
    left: 20,
    right: 20,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 16,
    ...mono,
    fontSize: 10,
    letterSpacing: "0.12em",
    pointerEvents: "none",
  } as CSSProperties,
  repoPath: {
    color: "rgba(255,255,255,0.62)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    textTransform: "none" as const,
  } as CSSProperties,
  live: {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    color: `oklch(86% 0.13 ${SECTION_HUE})`,
    whiteSpace: "nowrap",
  } as CSSProperties,
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 9999,
    background: `oklch(72% 0.18 ${SECTION_HUE})`,
    boxShadow: `0 0 10px oklch(72% 0.18 ${SECTION_HUE} / 0.8)`,
  } as CSSProperties,

  /* danmaku lanes */
  laneWrap: (topPct: number): CSSProperties => ({
    position: "absolute",
    left: 0,
    right: 0,
    top: `${topPct}%`,
    height: 22,
    overflow: "hidden",
    pointerEvents: "none",
  }),
  laneTrack: (dir: "L" | "R", duration: number): CSSProperties => ({
    display: "flex",
    gap: 44,
    width: "max-content",
    animation: `osLane${dir} ${duration}s linear infinite`,
  }),
  laneItem: (size: number, opacity: number): CSSProperties => ({
    fontFamily: "'DM Sans', sans-serif",
    fontSize: size,
    color: "#fff",
    opacity,
    textShadow: "1px 1px 3px rgba(0,0,0,0.92)",
    whiteSpace: "nowrap",
  }),
  pinned: (p: Pinned): CSSProperties => ({
    position: "absolute",
    left: `${p.x}%`,
    top: `${p.y}%`,
    fontFamily: "'DM Sans', sans-serif",
    fontSize: p.size,
    color: p.pop ? `oklch(80% 0.10 ${HUE_ROSE})` : "#fff",
    opacity: p.op,
    fontWeight: p.pop ? 600 : 500,
    textShadow: p.pop
      ? `0 1px 2px rgba(0,0,0,0.95), 0 0 10px oklch(60% 0.14 ${HUE_ROSE} / 0.55)`
      : "0 1px 2px rgba(0,0,0,0.95), 0 0 8px rgba(0,0,0,0.75)",
    whiteSpace: "nowrap",
    pointerEvents: "none",
  }),

  /* overlaid open-source payload (bottom-left OSD) */
  payload: {
    position: "absolute",
    left: "clamp(20px, 3vw, 44px)",
    right: "clamp(20px, 3vw, 44px)",
    bottom: "clamp(56px, 6vw, 76px)",
    display: "flex",
    flexDirection: "column" as const,
    gap: 18,
    maxWidth: 520,
    pointerEvents: "none",
  } as CSSProperties,
  payloadTag: {
    ...mono,
    fontSize: 11,
    letterSpacing: "0.16em",
    color: `oklch(86% 0.12 ${SECTION_HUE})`,
    textTransform: "uppercase" as const,
  } as CSSProperties,
  starRow: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    flexWrap: "wrap" as const,
    pointerEvents: "auto",
  } as CSSProperties,
  starBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 12,
    padding: "11px 18px",
    borderRadius: 10,
    border: `1px solid oklch(72% 0.17 ${SECTION_HUE} / 0.45)`,
    background: "rgba(0,0,0,0.42)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    textDecoration: "none",
    transition:
      "border-color 200ms var(--ease-out-expo), background 200ms var(--ease-out-expo), transform 200ms var(--ease-out-expo)",
  } as CSSProperties,
  starGlyph: {
    fontSize: 18,
    lineHeight: 1,
    color: `oklch(86% 0.16 ${SECTION_HUE})`,
    transition: "transform 240ms var(--ease-out-expo)",
  } as CSSProperties,
  starWord: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 15,
    fontWeight: 700,
    color: "#fff",
    letterSpacing: "-0.01em",
  } as CSSProperties,
  starCount: {
    ...mono,
    fontSize: 15,
    fontWeight: 500,
    color: `oklch(88% 0.10 ${SECTION_HUE})`,
    paddingLeft: 12,
    marginLeft: 2,
    borderLeft: "1px solid rgba(255,255,255,0.18)",
    fontVariantNumeric: "tabular-nums",
  } as CSSProperties,
  ctaRow: {
    display: "flex",
    alignItems: "center",
    gap: 22,
    flexWrap: "wrap" as const,
    pointerEvents: "auto",
  } as CSSProperties,
  ctaPrimary: {
    display: "inline-flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 20px",
    borderRadius: 8,
    border: `1px solid oklch(62% 0.17 ${SECTION_HUE} / 0.55)`,
    background: `oklch(30% 0.10 ${SECTION_HUE} / 0.55)`,
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    textDecoration: "none",
    fontFamily: "'Sora', sans-serif",
    fontSize: 15,
    fontWeight: 700,
    color: "#fff",
    letterSpacing: "-0.01em",
    transition:
      "border-color 200ms var(--ease-out-expo), background 200ms var(--ease-out-expo), transform 200ms var(--ease-out-expo)",
  } as CSSProperties,
  ctaArrow: {
    ...mono,
    fontSize: 14,
    color: `oklch(86% 0.13 ${SECTION_HUE})`,
    transition: "transform 220ms var(--ease-out-expo)",
  } as CSSProperties,
  ctaText: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    textDecoration: "none",
    fontFamily: "'DM Sans', sans-serif",
    fontSize: 14,
    fontWeight: 600,
    color: "rgba(255,255,255,0.82)",
    transition: "color 150ms var(--ease-out-expo)",
  } as CSSProperties,
  ctaTextArrow: {
    ...mono,
    fontSize: 13,
    color: `oklch(82% 0.12 ${SECTION_HUE} / 0.85)`,
    transition: "transform 220ms var(--ease-out-expo)",
  } as CSSProperties,

  /* player control bar */
  controls: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: "0 clamp(20px, 3vw, 44px) 16px",
    display: "flex",
    alignItems: "center",
    gap: 14,
    pointerEvents: "none",
  } as CSSProperties,
  playBtn: {
    width: 30,
    height: 30,
    flexShrink: 0,
    borderRadius: 9999,
    border: "1px solid rgba(255,255,255,0.30)",
    background: "rgba(0,0,0,0.35)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  } as CSSProperties,
  playTri: {
    width: 0,
    height: 0,
    marginLeft: 2,
    borderTop: "5px solid transparent",
    borderBottom: "5px solid transparent",
    borderLeft: "8px solid #fff",
  } as CSSProperties,
  heatTrack: {
    position: "relative",
    flex: 1,
    height: 22,
    display: "flex",
    alignItems: "flex-end",
    gap: 2,
  } as CSSProperties,
  heatBar: (h: number, played: boolean): CSSProperties => ({
    flex: 1,
    height: `${Math.max(12, (h / 14) * 100)}%`,
    borderRadius: 1,
    background: played
      ? `oklch(74% 0.16 ${SECTION_HUE} / 0.85)`
      : "rgba(255,255,255,0.20)",
    transformOrigin: "bottom",
  }),
  timecode: {
    ...mono,
    fontSize: 11,
    color: "rgba(255,255,255,0.62)",
    whiteSpace: "nowrap",
    flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
  } as CSSProperties,

  /* --- below-frame caption: ways to help + links --------------------- */
  footRow: {
    marginTop: 28,
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 24,
    flexWrap: "wrap" as const,
  } as CSSProperties,
  ways: {
    ...mono,
    fontSize: 12.5,
    color: "rgba(235,235,245,0.45)",
    letterSpacing: "0.01em",
    lineHeight: 1.7,
  } as CSSProperties,
  waysAccent: {
    color: `oklch(80% 0.10 ${SECTION_HUE})`,
  } as CSSProperties,
  links: {
    display: "inline-flex",
    alignItems: "center",
    gap: 18,
    flexWrap: "wrap" as const,
  } as CSSProperties,
  link: {
    ...mono,
    fontSize: 12,
    color: "rgba(235,235,245,0.55)",
    textDecoration: "none",
    letterSpacing: "0.02em",
    transition: "color 150ms var(--ease-out-expo)",
  } as CSSProperties,
};

function pickTitle(poster: LandingPoster | null, isZh: boolean): string {
  if (!poster) return isZh ? "葬送的芙莉莲" : "Frieren";
  if (isZh) {
    return (
      poster.titleChinese ||
      poster.titleNative ||
      poster.titleRomaji ||
      poster.titleEnglish ||
      "葬送的芙莉莲"
    );
  }
  return poster.titleEnglish || poster.titleRomaji || "Frieren";
}

// Bundled fallback so the frame never renders as an empty box when the live
// poster fetch fails (go-api down / cold cache) - same resilience spirit as
// the rest of the page's safe* fetches.
const FALLBACK_IMG = "/card_default/backdrop.jpg";

function pickImage(poster: LandingPoster | null): string {
  if (!poster) return FALLBACK_IMG;
  const banner = (poster as AnimeDetail).bannerImageUrl;
  return banner || poster.coverImageUrl || FALLBACK_IMG;
}

interface OpenSourceSectionProps {
  dict: Dict;
  stats: RepoStats;
  poster: LandingPoster | null;
}

export default function OpenSourceSection({
  dict,
  stats,
  poster,
}: OpenSourceSectionProps) {
  const reduced = useReducedMotion();
  const os = dict.landing.openSource;
  const dm = dict.landing.danmaku; // merged-in danmaku showcase copy
  const isZh = dict.landing.finalCta.period === "。";
  const title = pickTitle(poster, isZh);
  const imgSrc = pickImage(poster);

  const ways = [os.way1, os.way2, os.way3, os.way4, os.way5, os.way6].join(
    isZh ? " · " : " · ",
  );

  // Star count: count-up to the live value; null -> static dash, but the CTA
  // still links to GitHub (it is a Star button regardless of the number).
  const [starRef, starVal] = useCountUp(stats.stars ?? 0, { duration: 1.8, delay: 0.2 });
  const starDisplay =
    stats.stars == null ? "—" : (typeof starVal === "number" ? Math.round(starVal) : starVal);

  return (
    <section style={s.section} aria-labelledby="opensource-title">
      <style>{`
        @keyframes osLaneL { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
        @keyframes osLaneR { 0% { transform: translateX(-50%); } 100% { transform: translateX(0); } }
        .os-frame:hover .os-track { animation-play-state: paused; }
        .os-star:hover { border-color: oklch(82% 0.17 ${SECTION_HUE} / 0.85) !important; background: rgba(0,0,0,0.55) !important; transform: translateY(-2px); }
        .os-star:hover .os-star-glyph { transform: scale(1.18) rotate(-8deg); }
        .os-primary:hover { border-color: oklch(78% 0.17 ${SECTION_HUE} / 0.85) !important; background: oklch(38% 0.12 ${SECTION_HUE} / 0.7) !important; transform: translateY(-2px); }
        .os-primary:hover .os-arrow { transform: translateX(4px); }
        .os-textcta:hover { color: #fff !important; }
        .os-textcta:hover .os-textarrow { transform: translateX(3px); }
        .os-link:hover { color: oklch(82% 0.12 ${SECTION_HUE}) !important; }
        .os-star:focus-visible, .os-primary:focus-visible, .os-textcta:focus-visible, .os-link:focus-visible {
          outline: 2px solid oklch(72% 0.17 ${SECTION_HUE});
          outline-offset: 3px;
          border-radius: 6px;
        }
        @media (max-width: 520px) {
          .os-lane-b { display: none; }
          .os-payload { max-width: none !important; bottom: clamp(50px, 12vw, 64px) !important; }
        }
        @media (prefers-reduced-motion: reduce) {
          .os-track { animation: none !important; }
          .os-star:hover, .os-primary:hover { transform: none !important; }
          .os-star:hover .os-star-glyph { transform: none !important; }
          .os-primary:hover .os-arrow, .os-textcta:hover .os-textarrow { transform: none !important; }
        }
      `}</style>

      <SectionNum n="06" />
      <div className="container">
        <div style={s.headerWrap}>
          <ChapterBar hue={SECTION_HUE} style={{ top: 0, left: 0 }} />
          <SectionHeader
            eyebrow={os.eyebrow}
            title={os.title}
            sub={os.sub}
            titleId="opensource-title"
            style={s.headerOverride}
          />
        </div>

        {/* Focal: the real player + danmaku frame, OSS payload overlaid. */}
        <div className="os-frame" style={s.frame}>
          {imgSrc ? <FadeImage src={imgSrc} alt="" style={s.frameImg} /> : null}
          <div style={s.scrim} aria-hidden />

          <div style={s.topChrome} aria-hidden>
            <span style={s.repoPath}>{REPO_PATH}</span>
            <span style={s.live}>
              <span style={s.liveDot} className="hud-blink" />
              {dm.cornerLive}
              <span style={{ color: "rgba(255,255,255,0.28)" }}>·</span>
              <span style={{ color: "rgba(255,255,255,0.5)" }}>{dm.cornerRate}</span>
            </span>
          </div>

          {/* in-world danmaku - the frame is the actual player */}
          <div style={s.laneWrap(15)} aria-hidden>
            <div className="os-track" style={s.laneTrack("L", 56)}>
              {[...LANE_A, ...LANE_A].map((tx, i) => (
                <span key={`a-${i}`} style={s.laneItem(15, 0.95)}>{tx}</span>
              ))}
            </div>
          </div>
          <div className="os-lane-b" style={s.laneWrap(30)} aria-hidden>
            <div className="os-track" style={s.laneTrack("R", 70)}>
              {[...LANE_B, ...LANE_B].map((tx, i) => (
                <span key={`b-${i}`} style={s.laneItem(14, 0.82)}>{tx}</span>
              ))}
            </div>
          </div>

          {/* frozen "three thousand voices in one frame" pinned danmaku */}
          {PINNED.map((p, i) => (
            <span key={`pin-${i}`} style={s.pinned(p)} aria-hidden>{p.t}</span>
          ))}

          {/* OSS payload OSD */}
          <div className="os-payload" style={s.payload}>
            <span style={s.payloadTag}>{os.frameTag}</span>

            <div style={s.starRow}>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="os-star"
                style={s.starBtn}
                ref={starRef as unknown as React.RefObject<HTMLAnchorElement>}
                aria-label={`${os.starWord} · ${os.starAria}`}
              >
                <span className="os-star-glyph" style={s.starGlyph} aria-hidden>★</span>
                <span style={s.starWord}>{os.starWord}</span>
                <span style={s.starCount}>{starDisplay}</span>
              </a>
            </div>

            <div style={s.ctaRow}>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="os-primary"
                style={s.ctaPrimary}
              >
                {os.ctaSource}
                <span className="os-arrow" style={s.ctaArrow} aria-hidden>→</span>
              </a>
              <a
                href={README_URL}
                target="_blank"
                rel="noreferrer"
                className="os-textcta"
                style={s.ctaText}
              >
                {os.ctaSelfHost}
                <span className="os-textarrow" style={s.ctaTextArrow} aria-hidden>→</span>
              </a>
            </div>
          </div>

          {/* player control bar - sells "this is the actual player" */}
          <div style={s.controls} aria-hidden>
            <span style={s.playBtn}>
              <span style={s.playTri} />
            </span>
            <span style={s.heatTrack}>
              {HEATMAP.map((h, i) => (
                <Motion.span
                  key={i}
                  style={s.heatBar(h, i / HEATMAP.length < 0.42)}
                  initial={reduced ? false : { scaleY: 0 }}
                  whileInView={reduced ? undefined : { scaleY: 1 }}
                  viewport={HUD_VIEWPORT}
                  transition={{ duration: 0.5, delay: 0.3 + i * 0.012, ease: [0.16, 1, 0.3, 1] }}
                />
              ))}
            </span>
            <span style={s.timecode}>{title.length > 14 ? "09:32 / 23:40" : `${title} · 09:32`}</span>
          </div>
        </div>

        {/* below frame: ways to help (one line) + governance links */}
        <div style={s.footRow}>
          <p style={s.ways}>
            <span style={s.waysAccent}>{os.waysLabel}</span>{" "}
            {ways}
          </p>
          <span style={s.links}>
            <a href={CONTRIBUTING_URL} target="_blank" rel="noreferrer" className="os-link" style={s.link}>
              {os.ctaContributing} ↗
            </a>
            <a href={LICENSE_URL} target="_blank" rel="noreferrer" className="os-link" style={s.link}>
              {os.ctaLicense} ↗
            </a>
          </span>
        </div>
      </div>
    </section>
  );
}
