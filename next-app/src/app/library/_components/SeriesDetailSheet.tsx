"use client";

// Ported from client/src/components/library/SeriesDetailSheet.jsx.
// Modal overlay shown when the user clicks a series card in the main grid.
// Replaces the immediate /player navigation with an episode picker so users
// can pick an exact episode without leaving the library.

import { useEffect, useState, useMemo, type CSSProperties } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import {
  mono,
  PLAYER_HUE,
  LOCAL_HEX_GLYPH,
  LOCAL_BADGE_COLOR,
  PROGRESS_FILL,
} from "@/components/landing/shared/hud-tokens";
import { CornerBrackets } from "@/components/landing/shared/hud";
import FadeImage from "@/components/ui/FadeImage";
import { useLang } from "@/lib/lang-client";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — JSDoc-only JS module
import { db } from "@/lib/library/db/db.js";
// P6 TODO: tighten when useLibrary gets typed exports; for now widen to any
// eslint-disable-next-line -eslint/no-explicit-any
type SeriesRecord = any;

interface EpisodeRow {
  id: string;
  seriesId: string;
  number: number;
  kind: string;
}

interface ProgressRow {
  episodeId: string;
  seriesId: string;
  positionSec: number;
  durationSec: number;
  updatedAt: number;
  completed: boolean;
}

const HUE = PLAYER_HUE.local;

// motion's typings narrow style values; cast our inline objects per use.
const s = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "oklch(4% 0.02 210 / 0.78)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    zIndex: 900,
    cursor: "pointer",
  } as CSSProperties,
  panel: {
    position: "relative",
    width: "100%",
    maxWidth: 880,
    maxHeight: "88vh",
    overflow: "auto",
    background: `oklch(11% 0.03 ${HUE} / 0.92)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.55)`,
    borderRadius: 8,
    boxShadow: "0 30px 80px oklch(2% 0 0 / 0.65)",
    color: "#fff",
    cursor: "default",
  } as CSSProperties,
  closeBtn: {
    ...mono,
    position: "absolute",
    top: 12,
    right: 12,
    width: 32,
    height: 32,
    borderRadius: 4,
    background: "oklch(8% 0.02 210 / 0.65)",
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.50)`,
    color: "rgba(235,235,245,0.85)",
    fontSize: 14,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
    padding: 0,
    lineHeight: 1,
  } as CSSProperties,
  hero: {
    display: "grid",
    gridTemplateColumns: "180px 1fr",
    gap: 24,
    padding: "32px 32px 24px",
    borderBottom: `1px solid oklch(46% 0.06 ${HUE} / 0.25)`,
  } as CSSProperties,
  posterWrap: {
    position: "relative",
    aspectRatio: "2/3",
    borderRadius: 4,
    overflow: "hidden",
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.35)`,
  } as CSSProperties,
  poster: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  } as CSSProperties,
  monogram: {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: `oklch(18% 0.06 ${HUE} / 0.80)`,
    fontFamily: "'Sora', sans-serif",
    fontSize: 48,
    fontWeight: 700,
    color: `oklch(72% 0.15 ${HUE})`,
  } as CSSProperties,
  posterScrim: {
    position: "absolute",
    inset: 0,
    background: `linear-gradient(to top, oklch(8% 0.04 ${HUE} / 0.55) 0%, transparent 50%)`,
    pointerEvents: "none",
  } as CSSProperties,
  localBadge: {
    ...mono,
    position: "absolute",
    top: 8,
    left: 8,
    height: 20,
    padding: "0 8px 0 6px",
    background: "rgba(28,28,30,0.78)",
    border: `1px solid ${LOCAL_BADGE_COLOR}4D`,
    color: LOCAL_BADGE_COLOR,
    borderRadius: 999,
    fontSize: 9,
    letterSpacing: "0.10em",
    textTransform: "uppercase",
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    backdropFilter: "blur(4px)",
  } as CSSProperties,
  meta: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    minWidth: 0,
  } as CSSProperties,
  kicker: {
    ...mono,
    fontSize: 10,
    letterSpacing: "0.16em",
    color: "rgba(235,235,245,0.30)",
    textTransform: "uppercase",
  } as CSSProperties,
  title: {
    fontFamily: "'Sora', sans-serif",
    fontWeight: 700,
    fontSize: 28,
    lineHeight: 1.15,
    margin: 0,
    letterSpacing: "-0.02em",
  } as CSSProperties,
  subtitle: {
    fontFamily: "'Sora', sans-serif",
    fontWeight: 500,
    fontSize: 14,
    color: "rgba(235,235,245,0.55)",
    margin: 0,
  } as CSSProperties,
  metaRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
    alignItems: "center",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: "rgba(235,235,245,0.65)",
    letterSpacing: "0.05em",
    marginTop: 4,
  } as CSSProperties,
  metaChip: {
    ...mono,
    fontSize: 10,
    letterSpacing: "0.10em",
    textTransform: "uppercase",
    padding: "3px 8px",
    background: `oklch(46% 0.06 ${HUE} / 0.18)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.35)`,
    borderRadius: 999,
    color: `oklch(72% 0.15 ${HUE})`,
  } as CSSProperties,
  metaDot: { color: "rgba(235,235,245,0.20)" } as CSSProperties,
  progressBar: {
    height: 4,
    borderRadius: 999,
    background: "rgba(255,255,255,0.10)",
    overflow: "hidden",
    marginTop: 4,
  } as CSSProperties,
  progressFill: (pct: number): CSSProperties => ({
    height: "100%",
    width: `${Math.max(0, Math.min(1, pct)) * 100}%`,
    background: PROGRESS_FILL,
    borderRadius: 999,
    boxShadow: `0 0 8px ${PROGRESS_FILL}88`,
  }),
  progressLabel: {
    ...mono,
    fontSize: 11,
    color: "rgba(235,235,245,0.65)",
    fontVariantNumeric: "tabular-nums",
    marginTop: 4,
  } as CSSProperties,
  ctaRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 12,
  } as CSSProperties,
  ctaPrimary: {
    ...mono,
    padding: "10px 18px",
    background: `oklch(62% 0.17 ${HUE} / 0.22)`,
    border: `1px solid oklch(62% 0.17 ${HUE} / 0.65)`,
    borderRadius: 4,
    color: `oklch(78% 0.15 ${HUE})`,
    fontSize: 12,
    cursor: "pointer",
    textTransform: "uppercase",
    letterSpacing: "0.14em",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    transition:
      "background-color 180ms ease-out, border-color 180ms ease-out, transform 180ms cubic-bezier(0.16,1,0.3,1)",
  } as CSSProperties,
  ctaDanmaku: {
    ...mono,
    padding: "10px 18px",
    background: "transparent",
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.65)`,
    borderRadius: 4,
    color: "rgba(235,235,245,0.85)",
    fontSize: 12,
    cursor: "pointer",
    textTransform: "uppercase",
    letterSpacing: "0.14em",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    position: "relative",
    transition:
      "background-color 180ms ease-out, border-color 180ms ease-out, transform 180ms cubic-bezier(0.16,1,0.3,1)",
  } as CSSProperties,
  danmakuGlyph: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  } as CSSProperties,
  playTri: {
    color: LOCAL_BADGE_COLOR,
    fontSize: 11,
    lineHeight: 1,
    textShadow: `0 0 8px ${LOCAL_BADGE_COLOR}88`,
  } as CSSProperties,
  streaksWrap: {
    position: "relative",
    width: 18,
    height: 14,
    overflow: "hidden",
    flexShrink: 0,
  } as CSSProperties,
  streak: (i: number): CSSProperties => {
    const tracks = [
      { top: 2, width: 8 },
      { top: 6, width: 11 },
      { top: 10, width: 6 },
    ];
    const t = tracks[i] || tracks[0];
    return {
      position: "absolute",
      left: 0,
      top: t.top,
      width: t.width,
      height: 1,
      background: LOCAL_BADGE_COLOR,
      borderRadius: 1,
      boxShadow: `0 0 4px ${LOCAL_BADGE_COLOR}88`,
      animation: `seriesDetailDanmakuStreak 1.6s linear ${i * 0.45}s infinite`,
      opacity: 0,
    };
  },
  episodes: {
    padding: "20px 32px 28px",
  } as CSSProperties,
  episodeHeader: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: 16,
  } as CSSProperties,
  episodeKicker: {
    ...mono,
    fontSize: 10,
    letterSpacing: "0.16em",
    color: "rgba(235,235,245,0.45)",
    textTransform: "uppercase",
  } as CSSProperties,
  episodeStats: {
    ...mono,
    fontSize: 10,
    letterSpacing: "0.10em",
    color: "rgba(235,235,245,0.30)",
    textTransform: "uppercase",
  } as CSSProperties,
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))",
    gap: 8,
  } as CSSProperties,
  chip: {
    ...mono,
    position: "relative",
    aspectRatio: "1.1",
    borderRadius: 4,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.30)`,
    background: `oklch(14% 0.04 ${HUE} / 0.50)`,
    color: "rgba(235,235,245,0.65)",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    padding: 0,
    fontFamily: "inherit",
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "0.02em",
    transition:
      "transform 180ms cubic-bezier(0.16,1,0.3,1), border-color 180ms ease-out, color 180ms ease-out, box-shadow 180ms ease-out",
  } as CSSProperties,
  chipDisabled: {
    cursor: "not-allowed",
    opacity: 0.35,
    background: `oklch(8% 0.02 ${HUE} / 0.40)`,
  } as CSSProperties,
  chipCompleted: {
    border: "1px solid #30d158",
    color: "#30d158",
    background: "oklch(60% 0.18 145 / 0.10)",
  } as CSSProperties,
  chipInProgress: {
    border: `1px solid ${PROGRESS_FILL}`,
    color: "#fff",
  } as CSSProperties,
  chipLastWatched: {
    border: `1px solid oklch(72% 0.16 ${HUE})`,
    color: "#fff",
    boxShadow: `0 0 0 1px oklch(72% 0.16 ${HUE} / 0.85), 0 0 16px oklch(72% 0.16 ${HUE} / 0.45)`,
  } as CSSProperties,
  chipNum: {
    fontFamily: "inherit",
    fontSize: 14,
    fontWeight: 500,
  } as CSSProperties,
  chipCheck: {
    position: "absolute",
    top: 4,
    right: 4,
    fontSize: 10,
    color: "#30d158",
  } as CSSProperties,
  chipResumeRing: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: `oklch(72% 0.16 ${HUE})`,
    boxShadow: `0 0 8px oklch(72% 0.16 ${HUE})`,
  } as CSSProperties,
  chipProgress: {
    position: "absolute",
    left: 4,
    right: 4,
    bottom: 4,
    height: 2,
    borderRadius: 999,
    background: "rgba(255,255,255,0.15)",
    overflow: "hidden",
  } as CSSProperties,
  chipProgressFill: (pct: number): CSSProperties => ({
    height: "100%",
    width: `${Math.max(0, Math.min(1, pct)) * 100}%`,
    background: PROGRESS_FILL,
  }),
  empty: {
    ...mono,
    padding: "48px 16px",
    textAlign: "center",
    color: "rgba(235,235,245,0.45)",
    fontSize: 11,
    letterSpacing: "0.10em",
    textTransform: "uppercase",
  } as CSSProperties,
};

const HOVER_KEYFRAMES = `
@keyframes seriesDetailDanmakuStreak {
  0%   { transform: translateX(-12px); opacity: 0; }
  15%  { opacity: 1; }
  80%  { opacity: 1; }
  100% { transform: translateX(20px); opacity: 0; }
}
[data-episode-chip="true"]:hover:not([disabled]) {
  transform: translateY(-2px) scale(1.04);
  border-color: oklch(72% 0.16 210 / 0.85);
  color: #fff;
  box-shadow: 0 6px 16px oklch(2% 0 0 / 0.45), 0 0 0 1px oklch(72% 0.16 210 / 0.40);
}
[data-episode-chip="true"]:focus-visible {
  outline: 2px solid oklch(72% 0.16 210 / 0.85);
  outline-offset: 2px;
}
[data-cta-primary="true"]:hover {
  transform: translateY(-1px);
  background: oklch(62% 0.17 210 / 0.32);
}
[data-cta-danmaku="true"]:hover {
  transform: translateY(-1px);
  background: oklch(62% 0.17 210 / 0.10);
  border-color: oklch(72% 0.16 210 / 0.85);
  color: #fff;
}
[data-cta-primary="true"]:focus-visible,
[data-cta-danmaku="true"]:focus-visible {
  outline: 2px solid oklch(72% 0.16 210 / 0.85);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  [data-episode-chip="true"] { transition: border-color 180ms ease-out, color 180ms ease-out; }
  [data-episode-chip="true"]:hover:not([disabled]) { transform: none !important; box-shadow: none !important; }
  [data-cta-primary="true"]:hover, [data-cta-danmaku="true"]:hover { transform: none !important; }
  @keyframes seriesDetailDanmakuStreak { 0%, 100% { opacity: 0.7; transform: none; } }
}
`;

let __episodeChipStylesInjected = false;
function ensureEpisodeChipStyles(): void {
  if (__episodeChipStylesInjected || typeof document === "undefined") return;
  __episodeChipStylesInjected = true;
  const el = document.createElement("style");
  el.dataset.injectedBy = "series-detail-sheet";
  el.textContent = HOVER_KEYFRAMES;
  document.head.appendChild(el);
}

function safePoster(url: string | undefined): string | null {
  return typeof url === "string" && /^https:\/\//i.test(url) ? url : null;
}

interface SeriesDetailSheetProps {
  series: SeriesRecord & { totalEpisodes?: number };
  onClose: () => void;
  onPickEpisode: (seriesId: string, episodeNumber: number) => void;
  onPlaySeries?: (seriesId: string) => void;
}

export function SeriesDetailSheet({
  series,
  onClose,
  onPickEpisode,
  onPlaySeries,
}: SeriesDetailSheetProps) {
  const { t } = useLang();
  const reduced = useReducedMotion();
  const [episodes, setEpisodes] = useState<EpisodeRow[]>([]);
  const [progressById, setProgressById] = useState<Map<string, ProgressRow>>(
    new Map(),
  );
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    ensureEpisodeChipStyles();
  }, []);

  useEffect(() => {
    if (!series?.id) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const [eps, progRows] = (await Promise.all([
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (db as any).episodes
            .where("seriesId")
            .equals(series.id)
            .toArray(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (db as any).progress
            .where("seriesId")
            .equals(series.id)
            .toArray(),
        ])) as [EpisodeRow[], ProgressRow[]];
        if (cancelled) return;
        const map = new Map<string, ProgressRow>();
        for (const p of progRows) map.set(p.episodeId, p);
        setEpisodes(eps);
        setProgressById(map);
        setLoaded(true);
      } catch (err) {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.warn("[SeriesDetailSheet] load failed:", err);
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [series?.id]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const episodeByNumber = useMemo(() => {
    const m = new Map<number, EpisodeRow>();
    for (const ep of episodes) {
      if (!m.has(ep.number) || ep.kind === "main") m.set(ep.number, ep);
    }
    return m;
  }, [episodes]);

  const lastResume = useMemo(() => {
    let best: ProgressRow | null = null;
    for (const [, p] of progressById) {
      if (p.completed) continue;
      if (!best || (p.updatedAt || 0) > (best.updatedAt || 0)) best = p;
    }
    if (!best) return null;
    const ep = episodes.find((e) => e.id === best!.episodeId);
    return ep ? { episode: ep, progress: best } : null;
  }, [progressById, episodes]);

  const total = useMemo(() => {
    const fromSeries =
      typeof series.totalEpisodes === "number" && series.totalEpisodes > 0
        ? series.totalEpisodes
        : 0;
    let maxNum = 0;
    for (const ep of episodes) if (ep.number > maxNum) maxNum = ep.number;
    return Math.max(fromSeries, maxNum, episodes.length, 1);
  }, [series.totalEpisodes, episodes]);

  const completedCount = useMemo(() => {
    let n = 0;
    for (const [, p] of progressById) if (p.completed) n += 1;
    return n;
  }, [progressById]);

  const overallPct = total > 0 ? completedCount / total : 0;

  const title =
    series.titleZh || series.titleEn || series.titleJa || series.id;
  const subtitle =
    series.titleEn && series.titleEn !== title
      ? series.titleEn
      : series.titleJa && series.titleJa !== title
        ? series.titleJa
        : null;
  const posterUrl = safePoster(series.posterUrl);

  function handleChipClick(num: number, ep: EpisodeRow | undefined) {
    if (!ep) return;
    onPickEpisode(series.id, num);
  }

  function handleResume() {
    if (!lastResume) return;
    onPickEpisode(series.id, lastResume.episode.number);
  }

  return (
    <AnimatePresence>
      <motion.div
        key="backdrop"
        style={s.backdrop}
        data-testid="series-detail-sheet"
        initial={reduced ? false : { opacity: 0 }}
        animate={reduced ? undefined : { opacity: 1 }}
        exit={reduced ? undefined : { opacity: 0 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        onClick={onClose}
      >
        <motion.div
          style={s.panel}
          data-testid="series-detail-sheet-panel"
          initial={reduced ? false : { opacity: 0, scale: 0.96, y: 8 }}
          animate={reduced ? undefined : { opacity: 1, scale: 1, y: 0 }}
          exit={reduced ? undefined : { opacity: 0, scale: 0.97, y: 4 }}
          transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="series-detail-title"
        >
          <CornerBrackets inset={6} size={12} opacity={0.45} hue={HUE} />

          <button
            type="button"
            style={s.closeBtn}
            onClick={onClose}
            aria-label={t("library.detail.close")}
            data-testid="series-detail-close"
          >
            ×
          </button>

          {/* HERO */}
          <div style={s.hero}>
            <div style={s.posterWrap}>
              {posterUrl ? (
                <FadeImage src={posterUrl} alt="" style={s.poster} />
              ) : (
                <div style={s.monogram} aria-hidden>
                  {(title.charAt(0) || "?").toUpperCase()}
                </div>
              )}
              <div style={s.posterScrim} aria-hidden />
              <span style={s.localBadge}>
                <span aria-hidden style={{ fontSize: 11, lineHeight: 1 }}>
                  {LOCAL_HEX_GLYPH}
                </span>
                LOCAL
              </span>
            </div>

            <div style={s.meta}>
              <div style={s.kicker}>// SERIES · DETAIL //</div>
              <h2 id="series-detail-title" style={s.title}>
                {title}
              </h2>
              {subtitle && <p style={s.subtitle}>{subtitle}</p>}
              <div style={s.metaRow}>
                {series.type && (
                  <span style={s.metaChip}>
                    {String(series.type).toUpperCase()}
                  </span>
                )}
                {total > 0 && (
                  <>
                    <span style={s.metaDot}>·</span>
                    <span>{t("library.detail.epCount").replace("{{count}}", String(total))}</span>
                  </>
                )}
                {completedCount > 0 && (
                  <>
                    <span style={s.metaDot}>·</span>
                    <span>
                      {t("library.detail.watched")
                        .replace("{{done}}", String(completedCount))
                        .replace("{{total}}", String(total))}
                    </span>
                  </>
                )}
              </div>
              {completedCount > 0 && (
                <>
                  <div style={s.progressBar}>
                    <div style={s.progressFill(overallPct)} />
                  </div>
                  <div style={s.progressLabel}>
                    {Math.round(overallPct * 100)}%
                  </div>
                </>
              )}
              {(lastResume || onPlaySeries) && (
                <div style={s.ctaRow}>
                  {lastResume && (
                    <button
                      type="button"
                      data-cta-primary="true"
                      style={s.ctaPrimary}
                      onClick={handleResume}
                      data-testid="series-detail-resume"
                    >
                      {t("library.detail.resumeBtn").replace("{{ep}}", String(lastResume.episode.number))}
                    </button>
                  )}
                  {onPlaySeries && (
                    <button
                      type="button"
                      data-cta-danmaku="true"
                      style={s.ctaDanmaku}
                      onClick={() => onPlaySeries(series.id)}
                      data-testid="series-detail-play-danmaku"
                      title={t("library.detail.danmakuPlayTitle")}
                    >
                      <span style={s.danmakuGlyph} aria-hidden>
                        <span style={s.playTri}>▶</span>
                        <span style={s.streaksWrap}>
                          <span style={s.streak(0)} />
                          <span style={s.streak(1)} />
                          <span style={s.streak(2)} />
                        </span>
                      </span>
                      {t("library.detail.danmakuPlayBtn")}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* EPISODE GRID */}
          <div style={s.episodes}>
            <div style={s.episodeHeader}>
              <span style={s.episodeKicker}>// EPISODES //</span>
              {loaded && total > 0 && (
                <span style={s.episodeStats}>
                  {t("library.detail.indexedStats")
                    .replace("{{indexed}}", String(episodes.length))
                    .replace("{{total}}", String(total))}
                </span>
              )}
            </div>

            {!loaded ? (
              <div style={s.empty}>// LOADING //</div>
            ) : total === 0 ? (
              <div style={s.empty}>// NO EPISODES //</div>
            ) : (
              <motion.div
                style={s.grid}
                initial={reduced ? false : "hidden"}
                animate={reduced ? undefined : "show"}
                variants={{
                  hidden: {},
                  show: { transition: { staggerChildren: 0.02 } },
                }}
              >
                {Array.from({ length: total }).map((_, i) => {
                  const num = i + 1;
                  const ep = episodeByNumber.get(num);
                  const prog = ep ? progressById.get(ep.id) : undefined;
                  const completed = prog?.completed === true;
                  const inProgress =
                    !!prog && !completed && (prog.positionSec || 0) > 0;
                  const isLast =
                    lastResume?.episode?.number === num && !completed;
                  const pct =
                    inProgress && prog?.durationSec
                      ? (prog.positionSec || 0) /
                        Math.max(1, prog.durationSec)
                      : 0;

                  const chipStyle: CSSProperties = {
                    ...s.chip,
                    ...(completed ? s.chipCompleted : null),
                    ...(inProgress ? s.chipInProgress : null),
                    ...(isLast ? s.chipLastWatched : null),
                    ...(!ep ? s.chipDisabled : null),
                  };

                  return (
                    <motion.button
                      key={num}
                      type="button"
                      data-episode-chip="true"
                      data-episode-number={num}
                      data-testid={`episode-chip-${num}`}
                      data-state={
                        completed
                          ? "completed"
                          : inProgress
                            ? "in-progress"
                            : ep
                              ? "unseen"
                              : "missing"
                      }
                      style={chipStyle}
                      disabled={!ep}
                      onClick={() => handleChipClick(num, ep)}
                      variants={{
                        hidden: { opacity: 0, y: 6 },
                        show: {
                          opacity: ep ? 1 : 0.45,
                          y: 0,
                          transition: {
                            duration: 0.22,
                            ease: [0.16, 1, 0.3, 1],
                          },
                        },
                      }}
                      title={ep ? `EP ${num}` : t("library.detail.epMissing").replace("{{num}}", String(num))}
                    >
                      <span style={s.chipNum}>
                        {String(num).padStart(2, "0")}
                      </span>
                      {completed && (
                        <span style={s.chipCheck} aria-hidden>
                          ✓
                        </span>
                      )}
                      {isLast && !completed && (
                        <span style={s.chipResumeRing} aria-hidden />
                      )}
                      {inProgress && (
                        <div style={s.chipProgress}>
                          <div style={s.chipProgressFill(pct)} />
                        </div>
                      )}
                    </motion.button>
                  );
                })}
              </motion.div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
