"use client";

// Hero carousel for the legacy HomePage port (Phase 8.0).
// Ported from client/src/components/anime/HeroCarousel.jsx.
//
// LCP: the first slide image is rendered as a raw <img> with
// loading=eager + fetchPriority=high; the remaining slides lazy-load.
// (We keep the same <img> approach as AnimeCard to avoid wiring
// next/image remotePatterns for s4.anilist.co.)

import Link from "next/link";
import type { CSSProperties, KeyboardEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { formatScore, pickTitle, stripHtml, truncate } from "@/lib/formatters";
import type { Dict, Lang } from "@/lib/i18n";
import type { SeasonalAnime } from "@/lib/types";

const INTERVAL_MS = 5000;

// SeasonalAnime is the spec'd prop type, but the legacy carousel also
// reads enriched fields (banner, description, genres, accent rgb) when
// the homepage hydrates 3 known IDs with full detail. Read those via an
// extended shape so the component degrades gracefully when only the
// lean SeasonalAnime fields are present.
type CarouselAnime = SeasonalAnime & {
  bannerImageUrl?: string | null;
  description?: string | null;
  genres?: string[];
  posterAccentRgb?: string | null;
};

export interface HeroCarouselProps {
  animeList: CarouselAnime[];
  dict: Dict;
  lang: Lang;
}

// Season key -> dict lookup. SeasonalAnime.season is the AniList enum
// string (WINTER/SPRING/SUMMER/FALL) which matches dict.season keys.
type SeasonKey = "WINTER" | "SPRING" | "SUMMER" | "FALL";
function seasonLabel(dict: Dict, season: string | null | undefined): string {
  if (!season) return "";
  const key = season.toUpperCase() as SeasonKey;
  if (key === "WINTER" || key === "SPRING" || key === "SUMMER" || key === "FALL") {
    return dict.season[key];
  }
  return season;
}

const rootStyle: CSSProperties = {
  position: "relative",
  height: "clamp(420px, 55vh, 600px)",
  overflow: "hidden",
};

const slideBaseStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  transition: "opacity 0.9s ease",
};

const bgImgStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  objectFit: "cover",
  objectPosition: "center top",
  transition: "transform 6s ease",
};

const leftFadeStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  background:
    "linear-gradient(to right, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.70) 55%, rgba(0,0,0,0.10) 100%)",
};

const bottomFadeStyle: CSSProperties = {
  position: "absolute",
  bottom: 0,
  left: 0,
  right: 0,
  height: "40%",
  background: "linear-gradient(to top, #000000, transparent)",
};

const containerStyle: CSSProperties = {
  position: "relative",
  height: "100%",
  display: "flex",
  alignItems: "center",
};

const copyWrapStyle: CSSProperties = { maxWidth: 560 };

const eyebrowStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "2px",
  textTransform: "uppercase",
  color: "#0a84ff",
  marginBottom: 12,
};

const titleStyle: CSSProperties = {
  fontSize: "clamp(24px, 3.5vw, 46px)",
  fontFamily: "'Sora', sans-serif",
  fontWeight: 800,
  lineHeight: 1.15,
  marginBottom: 16,
  color: "#ffffff",
  textShadow: "0 2px 20px rgba(0,0,0,0.6)",
};

const genresRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  marginBottom: 14,
};

const genreChipStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  padding: "3px 10px",
  borderRadius: 9999,
  background: "rgba(120,120,128,0.12)",
  color: "rgba(235,235,245,0.60)",
};

const descStyle: CSSProperties = {
  fontSize: 14,
  color: "rgba(235,235,245,0.60)",
  lineHeight: 1.7,
  marginBottom: 20,
};

const ctaRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
};

const scoreWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const starStyle: CSSProperties = { fontSize: 20, color: "#ff9f0a" };

const scoreNumStyle: CSSProperties = {
  fontSize: 22,
  fontWeight: 800,
  color: "#ffffff",
  fontFamily: "'JetBrains Mono', monospace",
};

const ctaLinkBaseStyle: CSSProperties = {
  padding: "10px 28px",
  borderRadius: 8,
  background: "#0a84ff",
  color: "#fff",
  fontWeight: 500,
  fontSize: 14,
  fontFamily: "'DM Sans', sans-serif",
  textDecoration: "none",
  transition: "background 0.15s",
};

const arrowBtnBaseStyle: CSSProperties = {
  position: "absolute",
  top: "50%",
  transform: "translateY(-50%)",
  width: 44,
  height: 44,
  borderRadius: "50%",
  border: "none",
  cursor: "pointer",
  background: "rgba(255,255,255,0.1)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  color: "#ffffff",
  fontSize: 22,
  fontWeight: 700,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "background 0.2s",
  zIndex: 10,
};

const dotsRowStyle: CSSProperties = {
  position: "absolute",
  bottom: 24,
  left: "50%",
  transform: "translateX(-50%)",
  display: "flex",
  gap: 8,
  zIndex: 10,
};

const dotBtnStyle: CSSProperties = {
  height: 44,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  cursor: "pointer",
  background: "transparent",
  padding: "0 4px",
};

export default function HeroCarousel({ animeList, dict, lang }: HeroCarouselProps) {
  const [current, setCurrent] = useState(0);
  const [paused, setPaused] = useState(false);

  const len = animeList.length;

  const next = useCallback(() => {
    if (len === 0) return;
    setCurrent((c) => (c + 1) % len);
  }, [len]);

  const prev = useCallback(() => {
    if (len === 0) return;
    setCurrent((c) => (c - 1 + len) % len);
  }, [len]);

  // Auto-rotate: every INTERVAL_MS unless paused (hover) or <2 slides.
  useEffect(() => {
    if (paused || len < 2) return;
    const id = setInterval(next, INTERVAL_MS);
    return () => clearInterval(id);
  }, [paused, next, len]);

  // Arrow-key nav for keyboard users.
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      }
    },
    [next, prev],
  );

  if (len === 0) return null;

  return (
    <div
      style={rootStyle}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="region"
      aria-label="Featured anime carousel"
    >
      {animeList.map((anime, i) => {
        const isActive = i === current;
        const bg = anime.bannerImageUrl || anime.coverImageUrl || "";
        const title = pickTitle(anime, lang);
        const slideStyle: CSSProperties = {
          ...slideBaseStyle,
          opacity: isActive ? 1 : 0,
          pointerEvents: isActive ? "auto" : "none",
        };
        const imgDynamicStyle: CSSProperties = {
          ...bgImgStyle,
          transform: isActive ? "scale(1.03)" : "scale(1)",
        };

        return (
          <div key={anime.anilistId} style={slideStyle} aria-hidden={!isActive} inert={!isActive}>
            {bg ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={bg}
                alt=""
                aria-hidden
                // First slide is LCP candidate -> eager + high priority.
                // Remaining slides lazy load (off-screen via opacity:0).
                loading={i === 0 ? "eager" : "lazy"}
                fetchPriority={i === 0 ? "high" : "auto"}
                decoding={i === 0 ? "sync" : "async"}
                style={imgDynamicStyle}
              />
            ) : (
              <div style={{ ...imgDynamicStyle, background: "#1c1c1e" }} aria-hidden />
            )}
            <div style={leftFadeStyle} />
            <div style={bottomFadeStyle} />

            <div className="container" style={containerStyle}>
              <div style={copyWrapStyle}>
                {anime.season && anime.seasonYear ? (
                  <p style={eyebrowStyle}>
                    {seasonLabel(dict, anime.season)} {anime.seasonYear}
                  </p>
                ) : null}
                <h1 style={titleStyle}>{title}</h1>
                {anime.genres && anime.genres.length > 0 ? (
                  <div style={genresRowStyle}>
                    {anime.genres.slice(0, 4).map((g) => (
                      <span key={g} style={genreChipStyle}>
                        {g}
                      </span>
                    ))}
                  </div>
                ) : null}
                {anime.description ? (
                  <p style={descStyle}>{truncate(stripHtml(anime.description), 130)}</p>
                ) : null}
                <div style={ctaRowStyle}>
                  {anime.averageScore != null && anime.averageScore > 0 ? (
                    <div style={scoreWrapStyle}>
                      <span style={starStyle}>★</span>
                      <span style={scoreNumStyle}>{formatScore(anime.averageScore)}</span>
                    </div>
                  ) : null}
                  <Link
                    href={`/anime/${anime.anilistId}`}
                    prefetch={false}
                    style={ctaLinkBaseStyle}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "#409cff";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "#0a84ff";
                    }}
                  >
                    {dict.detail.viewDetails}
                  </Link>
                </div>
              </div>
            </div>
          </div>
        );
      })}

      <button
        type="button"
        onClick={prev}
        aria-label="Previous slide"
        style={{ ...arrowBtnBaseStyle, left: 24 }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "rgba(10,132,255,0.5)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "rgba(255,255,255,0.1)";
        }}
      >
        {"‹"}
      </button>
      <button
        type="button"
        onClick={next}
        aria-label="Next slide"
        style={{ ...arrowBtnBaseStyle, right: 24 }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "rgba(10,132,255,0.5)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "rgba(255,255,255,0.1)";
        }}
      >
        {"›"}
      </button>

      <div style={dotsRowStyle}>
        {animeList.map((_, i) => {
          const isActive = i === current;
          const pillStyle: CSSProperties = {
            display: "block",
            height: 6,
            borderRadius: 3,
            width: isActive ? 28 : 6,
            background: isActive ? "#0a84ff" : "rgba(255,255,255,0.35)",
            transition: "all 0.35s ease",
          };
          return (
            <button
              key={i}
              type="button"
              onClick={() => setCurrent(i)}
              aria-label={`Slide ${i + 1}`}
              aria-current={isActive}
              style={dotBtnStyle}
            >
              <span style={pillStyle} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
