"use client";

import { useState, type CSSProperties } from "react";
import { useReducedMotion } from "motion/react";
import { useLang } from "@/lib/lang-client";
import { formatScore } from "@/lib/formatters";
import { CornerBrackets } from "@/components/landing/shared/hud";
import { mono, PLAYER_HUE } from "@/components/landing/shared/hud-tokens";

const HUE = PLAYER_HUE.stream;

const scoreColor = (v: number) =>
  v >= 75 ? "#30d158" : v >= 50 ? "#ff9f0a" : "#ff453a";

const SOURCE_LABEL: Record<string, { zh: string; en: string }> = {
  ORIGINAL: { zh: "原创", en: "Original" },
  MANGA: { zh: "漫改", en: "Manga" },
  LIGHT_NOVEL: { zh: "轻小说改", en: "Light Novel" },
  VISUAL_NOVEL: { zh: "视觉小说改", en: "Visual Novel" },
  VIDEO_GAME: { zh: "游戏改", en: "Video Game" },
  NOVEL: { zh: "小说改", en: "Novel" },
  WEB_NOVEL: { zh: "网文改", en: "Web Novel" },
  GAME: { zh: "游戏改", en: "Game" },
};

// OKLCH per-episode hue rotation: 210, 220, 230, ... cycles through the spectrum.
const epHue = (ep: number | null | undefined) =>
  210 + (ep != null ? (ep * 10) % 360 : 0);

const s = {
  container: { maxWidth: 1100, margin: "0 auto" } as CSSProperties,
  animeInfo: {
    display: "flex",
    gap: 24,
    marginBottom: 28,
    alignItems: "flex-start",
  } as CSSProperties,
  cover: {
    width: 160,
    aspectRatio: "3/4",
    borderRadius: 12,
    objectFit: "cover",
    background: "#2c2c2e",
    flexShrink: 0,
  } as CSSProperties,
  info: { flex: 1, minWidth: 0 } as CSSProperties,
  title: {
    fontFamily: "'Sora',sans-serif",
    fontWeight: 600,
    fontSize: 24,
    color: "#ffffff",
    letterSpacing: "-0.02em",
  } as CSSProperties,
  titleCn: {
    fontSize: 16,
    color: "rgba(235,235,245,0.60)",
    marginTop: 4,
  } as CSSProperties,
  meta: {
    fontSize: 14,
    color: "rgba(235,235,245,0.30)",
    marginTop: 8,
  } as CSSProperties,
  badge: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 9999,
    background: "rgba(90,200,250,0.10)",
    color: "#5ac8fa",
    fontSize: 13,
    fontWeight: 500,
    marginTop: 8,
  } as CSSProperties,
  // Site anime info styles
  siteInfo: {
    marginTop: 14,
    paddingTop: 14,
    borderTop: "1px solid rgba(84,84,88,0.36)",
  } as CSSProperties,
  badgeRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 10,
  } as CSSProperties,
  scoreBadge: (color: string): CSSProperties => ({
    padding: "3px 10px",
    borderRadius: 9999,
    background: "rgba(255,159,10,0.12)",
    color,
    fontWeight: 700,
    fontSize: 12,
    fontFamily: "'JetBrains Mono',monospace",
  }),
  bgmScoreBadge: {
    padding: "3px 10px",
    borderRadius: 9999,
    background: "rgba(255,69,58,0.10)",
    color: "#ff453a",
    fontWeight: 700,
    fontSize: 12,
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontFamily: "'JetBrains Mono',monospace",
  } as CSSProperties,
  bgmLabel: {
    fontSize: 9,
    opacity: 0.7,
    fontFamily: "'DM Sans',sans-serif",
  } as CSSProperties,
  bgmVotes: { fontSize: 10, opacity: 0.6, fontWeight: 400 } as CSSProperties,
  infoBadge: (bg: string, color: string): CSSProperties => ({
    padding: "3px 10px",
    borderRadius: 9999,
    background: bg,
    color,
    fontSize: 12,
  }),
  metaRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "3px 10px",
    marginBottom: 10,
    alignItems: "center",
  } as CSSProperties,
  metaStudio: {
    color: "rgba(235,235,245,0.75)",
    fontSize: 12,
  } as CSSProperties,
  metaDot: { color: "rgba(84,84,88,0.65)", fontSize: 12 } as CSSProperties,
  metaDetail: { color: "rgba(235,235,245,0.50)", fontSize: 11 } as CSSProperties,
  genreRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 5,
    marginBottom: 10,
  } as CSSProperties,
  genreTag: {
    padding: "3px 8px",
    borderRadius: 9999,
    background: "rgba(120,120,128,0.12)",
    color: "rgba(235,235,245,0.60)",
    fontSize: 11,
    fontWeight: 500,
  } as CSSProperties,
  detailBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "5px 14px",
    borderRadius: 8,
    cursor: "pointer",
    background: "rgba(10,132,255,0.12)",
    border: "1px solid rgba(10,132,255,0.3)",
    color: "#0a84ff",
    fontSize: 13,
    fontWeight: 500,
    transition: "all 0.2s",
    textDecoration: "none",
  } as CSSProperties,
  headerActions: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    alignSelf: "flex-start",
  } as CSSProperties,
  clearBtn: {
    ...mono,
    background: "transparent",
    border: "1px solid rgba(235,235,245,0.20)",
    borderRadius: 2,
    padding: "6px 14px",
    fontSize: 11,
    color: "rgba(235,235,245,0.75)",
    cursor: "pointer",
    textTransform: "uppercase",
    letterSpacing: "0.14em",
  } as CSSProperties,
  // HUD row: relative for ChapterBar + CornerBrackets fade-in.
  row: (i: number, hover: boolean): CSSProperties => ({
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: 14,
    minHeight: 56,
    padding: "12px 22px 12px 24px",
    borderRadius: 2,
    background: hover
      ? "rgba(10,132,255,0.10)"
      : i % 2 === 1
        ? "rgba(120,120,128,0.05)"
        : "transparent",
    transition: "background 150ms, border-color 150ms",
    cursor: "pointer",
    borderLeft: hover
      ? `2px solid oklch(62% 0.19 ${HUE} / 0.85)`
      : "2px solid transparent",
  }),
  // Per-episode badge — OKLCH hue rotated per episode number.
  epBadge: (ep: number | null | undefined): CSSProperties => ({
    ...mono,
    fontSize: 11,
    width: 64,
    flexShrink: 0,
    color:
      ep != null
        ? `oklch(78% 0.15 ${epHue(ep)})`
        : "rgba(235,235,245,0.30)",
    letterSpacing: "0.10em",
    fontWeight: 600,
    paddingTop: 3,
    alignSelf: "flex-start",
  }),
  fileInfo: { flex: 1, minWidth: 0 } as CSSProperties,
  fileName: {
    fontFamily: "'Sora',sans-serif",
    fontSize: 15,
    color: "rgba(235,235,245,0.70)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as CSSProperties,
  epTitle: {
    fontSize: 12,
    fontWeight: 500,
    color: "rgba(235,235,245,0.42)",
    marginTop: 4,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: "'JetBrains Mono',monospace",
    letterSpacing: "0.04em",
  } as CSSProperties,
  playIcon: (hover: boolean): CSSProperties => ({
    ...mono,
    fontSize: 11,
    color: hover ? `oklch(78% 0.15 ${HUE})` : "rgba(235,235,245,0.30)",
    flexShrink: 0,
    transition: "color 150ms",
    textTransform: "uppercase",
    letterSpacing: "0.14em",
  }),
  // Supplementary lane — section divider + label rendered above commentary
  // rows so they read as "extra content" rather than missing main episodes.
  supSection: {
    marginTop: 32,
    paddingTop: 20,
    borderTop: "1px solid rgba(235,235,245,0.20)",
  } as CSSProperties,
  supHeader: {
    ...mono,
    fontSize: 11,
    color: "rgba(235,235,245,0.45)",
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    marginBottom: 12,
    paddingLeft: 24,
  } as CSSProperties,
  supBadge: {
    ...mono,
    display: "inline-block",
    padding: "2px 6px",
    fontSize: 10,
    color: "rgba(255,159,10,0.85)",
    border: "1px solid rgba(255,159,10,0.30)",
    borderRadius: 2,
    letterSpacing: "0.14em",
    marginLeft: 10,
    flexShrink: 0,
    alignSelf: "flex-start",
    paddingTop: 3,
  } as CSSProperties,
};

// Per-kind label shown next to the EP badge on supplementary rows. Keep this
// list lower-case to match parsedKind values; UI uppercases via CSS.
const SUPPLEMENTARY_KIND_LABEL: Record<string, string> = {
  commentary: "COMMENTARY",
};

// Skeleton — pulse animation injected once per page; mirrors the layout of
// the real siteAnime block so when the data lands the row positions don't
// jump.
const SKELETON_KEYFRAMES = `@keyframes siteAnimeSkeletonPulse{0%{opacity:0.55}50%{opacity:0.95}100%{opacity:0.55}}`;
const skel = {
  chip: (w: number): CSSProperties => ({
    background: "rgba(120,120,128,0.16)",
    borderRadius: 9999,
    height: 22,
    width: w,
    animation: "siteAnimeSkeletonPulse 1.4s ease-in-out infinite",
    display: "inline-block",
  }),
  textLine: (w: number): CSSProperties => ({
    background: "rgba(120,120,128,0.14)",
    borderRadius: 4,
    height: 12,
    width: w,
    animation: "siteAnimeSkeletonPulse 1.4s ease-in-out infinite",
    display: "inline-block",
  }),
  genreTag: (w: number): CSSProperties => ({
    background: "rgba(120,120,128,0.12)",
    borderRadius: 9999,
    height: 18,
    width: w,
    animation: "siteAnimeSkeletonPulse 1.4s ease-in-out infinite",
    display: "inline-block",
  }),
};

function SiteAnimeSkeleton() {
  return (
    <div style={s.siteInfo} data-testid="site-anime-skeleton" aria-busy="true">
      <style>{SKELETON_KEYFRAMES}</style>
      <div style={s.badgeRow}>
        <span style={skel.chip(64)} />
        <span style={skel.chip(80)} />
        <span style={skel.chip(48)} />
        <span style={skel.chip(80)} />
        <span style={skel.chip(56)} />
        <span style={skel.chip(96)} />
      </div>
      <div style={s.metaRow}>
        <span style={skel.textLine(140)} />
        <span style={skel.textLine(80)} />
      </div>
      <div style={s.genreRow}>
        <span style={skel.genreTag(48)} />
        <span style={skel.genreTag(64)} />
        <span style={skel.genreTag(56)} />
        <span style={skel.genreTag(40)} />
      </div>
    </div>
  );
}

const danmakuBtnStyle = (hover: boolean): CSSProperties => ({
  background: "transparent",
  border: `1px solid ${hover ? "rgba(255,159,10,0.55)" : "rgba(255,159,10,0.22)"}`,
  borderRadius: 2,
  cursor: "pointer",
  padding: "5px 8px",
  fontSize: 11,
  color: hover ? "oklch(78% 0.15 30)" : "rgba(235,235,245,0.55)",
  flexShrink: 0,
  transition: "all 150ms",
  fontFamily: "'JetBrains Mono',monospace",
  letterSpacing: "0.10em",
});

// AnimeHeader / SiteAnime are intentionally permissive — callers (subagent C
// PlayerShell, library LocalSeriesShell) pass a richer AnimeShape from
// useDandanMatch where many fields are `string | number | unknown`.
interface AnimeHeader {
  titleNative?: string | null;
  titleRomaji?: string | null;
  titleChinese?: string | null;
  coverImageUrl?: string | null;
  episodes?: number | null;
  [key: string]: unknown;
}

interface SiteAnime {
  status?: string | null;
  source?: string | null;
  duration?: number | string | null;
  averageScore?: number | string | null;
  bangumiScore?: number | string | null;
  bangumiVotes?: number | null;
  format?: string | null;
  episodes?: number | null;
  season?: string | null;
  seasonYear?: number | string | null;
  studios?: string[] | null;
  genres?: string[] | null;
  anilistId?: number | null;
  [key: string]: unknown;
}

interface EpisodeMeta {
  title?: string | null;
}

interface VideoFile {
  fileId?: string;
  fileName: string;
  episode: number | null;
  parsedKind?: string | null;
}

export interface EpisodeFileListProps {
  anime: AnimeHeader;
  siteAnime?: SiteAnime | null;
  episodeMap: Record<string | number, EpisodeMeta | undefined>;
  videoFiles: VideoFile[];
  supplementaryFiles?: VideoFile[];
  onPlay: (file: VideoFile) => void;
  onClear: () => void;
  onSetDanmaku: (episode: number | null) => void;
  clearLabel?: string;
  siteAnimeLoading?: boolean;
}

function EpisodeFileList({
  anime,
  siteAnime,
  episodeMap,
  videoFiles,
  supplementaryFiles = [],
  onPlay,
  onClear,
  onSetDanmaku,
  clearLabel,
  siteAnimeLoading,
}: EpisodeFileListProps) {
  const { t, lang } = useLang();

  const sa = siteAnime;
  const statusLabel = sa?.status
    ? ({
        RELEASING: t("detail.releasing"),
        FINISHED: t("detail.finished"),
        NOT_YET_RELEASED: t("detail.notYetReleased"),
        CANCELLED: t("detail.cancelled"),
      } as Record<string, string>)[sa.status] || sa.status
    : null;

  const sourceLabel = sa?.source
    ? (SOURCE_LABEL[sa.source]?.[lang] ?? null)
    : null;
  const durationLabel = sa?.duration
    ? lang === "zh"
      ? `${sa.duration}分/集`
      : `${sa.duration} min/ep`
    : null;

  const avgScore =
    typeof sa?.averageScore === "string"
      ? parseFloat(sa.averageScore)
      : (sa?.averageScore ?? 0);
  const bgmScore =
    typeof sa?.bangumiScore === "string"
      ? parseFloat(sa.bangumiScore)
      : (sa?.bangumiScore ?? 0);

  return (
    <div style={s.container}>
      {/* Anime info header */}
      <div style={s.animeInfo}>
        {anime.coverImageUrl && (
          <img style={s.cover} src={anime.coverImageUrl} alt="" />
        )}
        <div style={s.info}>
          <div style={s.title}>{anime.titleNative || anime.titleRomaji}</div>
          {anime.titleChinese && (
            <div style={s.titleCn}>{anime.titleChinese}</div>
          )}
          <div style={s.meta}>
            {anime.episodes && `${anime.episodes}${t("detail.epUnit")}`}
          </div>
          <div style={s.badge}>
            dandanplay · {Object.keys(episodeMap).length} {t("player.mapped")}
          </div>

          {/* Skeleton while siteAnime is being fetched (library mode first
              load). Replaced by the real block below as soon as data lands. */}
          {!sa && siteAnimeLoading && <SiteAnimeSkeleton />}

          {/* Site anime info */}
          {sa && (
            <div style={s.siteInfo}>
              {/* Score + info badges */}
              <div style={s.badgeRow}>
                {Number.isFinite(avgScore) && avgScore > 0 && (
                  <span style={s.scoreBadge(scoreColor(avgScore))}>
                    ★ {formatScore(avgScore)}
                  </span>
                )}
                {Number.isFinite(bgmScore) && bgmScore > 0 && (
                  <span style={s.bgmScoreBadge}>
                    <span style={s.bgmLabel}>BGM</span>★{" "}
                    {bgmScore.toFixed(1)}
                    {sa.bangumiVotes != null && sa.bangumiVotes > 0 && (
                      <span style={s.bgmVotes}>
                        ({sa.bangumiVotes.toLocaleString()})
                      </span>
                    )}
                  </span>
                )}
                {sa.format && (
                  <span
                    style={s.infoBadge("rgba(10,132,255,0.12)", "#0a84ff")}
                  >
                    {sa.format}
                  </span>
                )}
                {statusLabel && (
                  <span
                    style={s.infoBadge("rgba(90,200,250,0.10)", "#5ac8fa")}
                  >
                    {statusLabel}
                  </span>
                )}
                {sa.episodes != null && sa.episodes > 0 && (
                  <span
                    style={s.infoBadge(
                      "rgba(120,120,128,0.12)",
                      "rgba(235,235,245,0.60)",
                    )}
                  >
                    {sa.episodes} {t("detail.epUnit")}
                  </span>
                )}
                {sa.season && sa.seasonYear && (
                  <span
                    style={s.infoBadge(
                      "rgba(120,120,128,0.12)",
                      "rgba(235,235,245,0.60)",
                    )}
                  >
                    {t(`season.${sa.season}`)} {sa.seasonYear}
                  </span>
                )}
              </div>

              {/* Studios + meta */}
              {((sa.studios && sa.studios.length > 0) ||
                sourceLabel ||
                durationLabel) && (
                <div style={s.metaRow}>
                  {sa.studios && sa.studios.length > 0 && (
                    <span style={s.metaStudio}>{sa.studios.join(" · ")}</span>
                  )}
                  {sa.studios &&
                    sa.studios.length > 0 &&
                    (sourceLabel || durationLabel) && (
                      <span style={s.metaDot}>·</span>
                    )}
                  {sourceLabel && (
                    <span style={s.metaDetail}>{sourceLabel}</span>
                  )}
                  {durationLabel && (
                    <span style={s.metaDetail}>{durationLabel}</span>
                  )}
                </div>
              )}

              {/* Genres */}
              {sa.genres && sa.genres.length > 0 && (
                <div style={s.genreRow}>
                  {sa.genres.map((g) => (
                    <span key={g} style={s.genreTag}>
                      {g}
                    </span>
                  ))}
                </div>
              )}

              {/* View detail button */}
              {sa.anilistId && (
                <a
                  href={`/anime/${sa.anilistId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={s.detailBtn}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background =
                      "rgba(10,132,255,0.20)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background =
                      "rgba(10,132,255,0.12)";
                  }}
                >
                  {t("detail.viewDetails")} →
                </a>
              )}
            </div>
          )}
        </div>
        <div style={s.headerActions}>
          <button style={s.clearBtn} onClick={onClear}>
            // {clearLabel || t("player.clear")}
          </button>
        </div>
      </div>

      {/* Episode list — all files playable, matched ones show episode title */}
      {videoFiles.map((f, i) => (
        <EpisodeRow
          key={f.fileId || f.fileName}
          index={i}
          episode={f.episode}
          fileName={f.fileName}
          episodeTitle={
            f.episode != null
              ? episodeMap[f.episode]?.title ?? null
              : null
          }
          onPlay={() => onPlay(f)}
          onSetDanmaku={() => onSetDanmaku(f.episode)}
        />
      ))}

      {supplementaryFiles.length > 0 && (
        <div style={s.supSection}>
          <div style={s.supHeader}>
            // {t("player.supplementary")} ({supplementaryFiles.length})
          </div>
          {supplementaryFiles.map((f, i) => (
            <EpisodeRow
              key={f.fileId || f.fileName}
              index={i}
              episode={f.episode}
              fileName={f.fileName}
              episodeTitle={
                f.episode != null
                  ? episodeMap[f.episode]?.title ?? null
                  : null
              }
              kindLabel={
                f.parsedKind
                  ? SUPPLEMENTARY_KIND_LABEL[f.parsedKind] ||
                    f.parsedKind.toUpperCase()
                  : null
              }
              onPlay={() => onPlay(f)}
              onSetDanmaku={() => onSetDanmaku(f.episode)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface EpisodeRowProps {
  index: number;
  episode: number | null;
  fileName: string;
  episodeTitle: string | null;
  kindLabel?: string | null;
  onPlay: () => void;
  onSetDanmaku: () => void;
}

/**
 * EpisodeRow — HUD row.
 *   - Left edge: 2px OKLCH border on hover (Motion #7)
 *   - 4 corner brackets fade in on hover (Motion #7, 150ms)
 *   - Per-episode hue rotation on the EPxx badge
 */
function EpisodeRow({
  index,
  episode,
  fileName,
  episodeTitle,
  kindLabel,
  onPlay,
  onSetDanmaku,
}: EpisodeRowProps) {
  const reduced = useReducedMotion();
  const [hover, setHover] = useState(false);
  const [dmHover, setDmHover] = useState(false);
  const epLabel = episode != null ? `EP${String(episode).padStart(2, "0")}` : "—";
  return (
    <div
      style={s.row(index, hover)}
      onClick={onPlay}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") onPlay();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <CornerBrackets
        show={hover}
        animate={!reduced}
        inset={4}
        size={8}
        opacity={0.4}
        hue={episode != null ? epHue(episode) : null}
      />
      <span style={s.epBadge(episode)}>{epLabel}</span>
      {kindLabel && <span style={s.supBadge}>{kindLabel}</span>}
      <div style={s.fileInfo}>
        <div style={s.fileName}>{fileName}</div>
        {episodeTitle && <div style={s.epTitle}>{episodeTitle}</div>}
      </div>
      <button
        style={danmakuBtnStyle(dmHover)}
        onClick={(e) => {
          e.stopPropagation();
          onSetDanmaku();
        }}
        onMouseEnter={() => setDmHover(true)}
        onMouseLeave={() => setDmHover(false)}
        aria-label="Set danmaku"
      >
        DANMAKU
      </button>
      <span style={s.playIcon(hover)}>▶ PLAY</span>
    </div>
  );
}

export { EpisodeFileList };
export default EpisodeFileList;
