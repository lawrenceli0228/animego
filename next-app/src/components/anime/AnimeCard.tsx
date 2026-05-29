"use client";

import Link from "next/link";
import type { CSSProperties, MouseEvent } from "react";
import { useRef } from "react";
import { formatScore, pickTitle } from "@/lib/formatters";
import type { Lang } from "@/lib/i18n";
import type { LandingPoster } from "@/lib/types";

// AnimeCard accepts any record that carries the title fields, cover, and
// poster-accent. Used by both legacy LandingPage components (which pass
// TrendingItem / AnimeDetail) and Phase 5 pages (Seasonal / Search). We
// add a few optional badges (rank, watcherCount) and genres lifted from
// detail responses; cards built from trending alone simply omit them.
export interface AnimeCardData {
  anilistId: number;
  titleChinese?: string | null;
  titleRomaji?: string | null;
  titleEnglish?: string | null;
  titleNative?: string | null;
  coverImageUrl: string | null;
  posterAccent?: string | null;
  averageScore?: number | null;
  format?: string | null;
  genres?: string[];
}

interface AnimeCardProps {
  anime: AnimeCardData;
  lang: Lang;
  rank?: number;
  watcherCount?: number;
  /**
   * Phase 5 plan §UI mitigation B1: pass prefetch=false to avoid
   * Next prefetching every visible card in the seasonal/search grid
   * (those grids can render 20+ cards above-the-fold which would
   * stampede the Go API).
   */
  prefetch?: boolean;
  /** Set true for the first above-the-fold card — disables lazy load and sets fetchpriority=high. */
  priority?: boolean;
}

function scoreColor(s: number): string {
  if (s >= 75) return "#30d158";
  if (s >= 50) return "#ff9f0a";
  return "#ff453a";
}

const cardStyle: CSSProperties = {
  display: "block",
  position: "relative",
  borderRadius: 12,
  overflow: "hidden",
  background: "#1c1c1e",
  border: "1px solid #38383a",
  textDecoration: "none",
  color: "inherit",
  transition:
    "transform 0.25s cubic-bezier(0.4,0,0.2,1), box-shadow 0.25s cubic-bezier(0.4,0,0.2,1)",
  aspectRatio: "3/4",
};

const imgStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
};

// Non-priority cards fade in on load so the grid fills in as a smooth,
// uniform reveal instead of each image popping abruptly at its own decode
// time. The card's #1c1c1e bg is the shared placeholder underneath, so
// every cell looks identical until its image arrives. Priority (LCP) card
// keeps imgStyle — opacity 1, no transition — so its paint isn't delayed.
const imgFadeStyle: CSSProperties = {
  ...imgStyle,
  opacity: 0,
  transition: "opacity 0.4s ease",
};

const rankBadgeStyle: CSSProperties = {
  position: "absolute",
  top: 8,
  left: 8,
  color: "#0a84ff",
  fontSize: 20,
  fontWeight: 900,
  lineHeight: 1,
  fontFamily: "'Sora', sans-serif",
  background: "rgba(0,0,0,0.65)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  padding: "4px 8px",
  borderRadius: 6,
};

const formatBadgeStyle: CSSProperties = {
  position: "absolute",
  top: 8,
  left: 8,
  background: "rgba(0,0,0,0.75)",
  backdropFilter: "blur(8px)",
  color: "rgba(235,235,245,0.60)",
  fontSize: 10,
  fontWeight: 700,
  padding: "3px 7px",
  borderRadius: 5,
  letterSpacing: "0.5px",
};

const scoreBadgeBase: CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  background: "rgba(0,0,0,0.75)",
  backdropFilter: "blur(8px)",
  fontSize: 11,
  fontWeight: 700,
  padding: "3px 7px",
  borderRadius: 6,
  fontFamily: "'JetBrains Mono', monospace",
};

const watcherBadgeStyle: CSSProperties = {
  position: "absolute",
  bottom: 8,
  left: 8,
  background: "rgba(0,0,0,0.75)",
  backdropFilter: "blur(8px)",
  color: "#5ac8fa",
  fontSize: 10,
  fontWeight: 700,
  padding: "3px 7px",
  borderRadius: 5,
};

const gradientStyle: CSSProperties = {
  position: "absolute",
  bottom: 0,
  left: 0,
  right: 0,
  background:
    "linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.55) 55%, transparent 100%)",
  padding: "32px 10px 10px",
};

const overlayStyle: CSSProperties = {
  opacity: 0,
  transition: "opacity 0.25s",
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  marginBottom: 6,
};

const genreChipStyle: CSSProperties = {
  fontSize: 10,
  padding: "2px 7px",
  borderRadius: 9999,
  background: "rgba(120,120,128,0.12)",
  color: "rgba(235,235,245,0.60)",
  fontWeight: 500,
};

const titleStyle: CSSProperties = {
  fontFamily: "'Sora', sans-serif",
  fontSize: 13,
  fontWeight: 600,
  color: "#ffffff",
  lineHeight: 1.35,
  margin: 0,
  overflow: "hidden",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
};

export default function AnimeCard({
  anime,
  lang,
  rank,
  watcherCount,
  prefetch = false,
  priority = false,
}: AnimeCardProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const href = `/anime/${anime.anilistId}`;
  const title = pickTitle(anime, lang);

  const onEnter = (e: MouseEvent<HTMLAnchorElement>) => {
    const el = e.currentTarget;
    el.style.transform = "translateY(-4px)";
    el.style.boxShadow = "0 8px 24px rgba(0,0,0,0.40)";
    if (overlayRef.current) overlayRef.current.style.opacity = "1";
  };
  const onLeave = (e: MouseEvent<HTMLAnchorElement>) => {
    const el = e.currentTarget;
    el.style.transform = "none";
    el.style.boxShadow = "none";
    if (overlayRef.current) overlayRef.current.style.opacity = "0";
  };

  return (
    <Link
      href={href}
      prefetch={prefetch}
      aria-label={title}
      style={cardStyle}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {anime.coverImageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={anime.coverImageUrl}
          alt={title}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "low"}
          decoding={priority ? "sync" : "async"}
          width={230}
          height={320}
          ref={(el) => {
            // Cached images can finish decoding before React binds onLoad,
            // which would leave them stuck at opacity 0. Reveal immediately
            // if already complete.
            if (el && el.complete && el.naturalWidth > 0) el.style.opacity = "1";
          }}
          onLoad={(e) => {
            e.currentTarget.style.opacity = "1";
          }}
          style={priority ? imgStyle : imgFadeStyle}
        />
      ) : (
        <div style={{ ...imgStyle, background: "#2c2c2e" }} aria-hidden />
      )}

      {rank ? (
        <span style={rankBadgeStyle}>#{rank}</span>
      ) : anime.format ? (
        <span style={formatBadgeStyle}>{anime.format}</span>
      ) : null}

      {anime.averageScore != null && anime.averageScore > 0 ? (
        <span style={{ ...scoreBadgeBase, color: scoreColor(anime.averageScore) }}>
          ★ {formatScore(anime.averageScore)}
        </span>
      ) : null}

      {watcherCount && watcherCount > 0 ? (
        <span style={watcherBadgeStyle}>
          {watcherCount} {lang === "zh" ? "人" : "watching"}
        </span>
      ) : null}

      <div style={gradientStyle}>
        <div ref={overlayRef} style={overlayStyle}>
          {(anime.genres ?? []).slice(0, 2).map((g) => (
            <span key={g} style={genreChipStyle}>
              {g}
            </span>
          ))}
        </div>
        <p style={titleStyle}>{title}</p>
      </div>
    </Link>
  );
}

// Re-export the LandingPoster union so consumers that already typed
// against TrendingItem / AnimeDetail can pass them as AnimeCardData
// without an extra cast — the structural overlap is full.
export type { LandingPoster };
