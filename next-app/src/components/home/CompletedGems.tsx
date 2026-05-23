// Phase 8.0 port of client/src/components/home/CompletedGems.jsx.
//
// Stateless server component: parent page fetches /api/anime/completed-gems
// (limit=6 per spec; legacy uses 10) and passes items in. The legacy
// "refresh batch" button required React Query cache invalidation, which
// only makes sense on the client; we drop the button here because the
// list is static per render. If we re-introduce refresh later, mark this
// 'use client' and lift to a state-bearing parent.
//
// ASCII comments only — Unicode in source can panic Turbopack.

import Link from "next/link";
import type { CSSProperties } from "react";
import { formatScore, pickTitle } from "@/lib/formatters";
import type { Dict, Lang } from "@/lib/i18n";
import type { TrendingItem } from "@/lib/types";

export interface CompletedGemsProps {
  items: TrendingItem[];
  dict: Dict;
  lang: Lang;
}

const sectionStyle: CSSProperties = { marginTop: 48 };

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 20,
};

const labelStyle: CSSProperties = {
  color: "#0a84ff",
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: "2px",
  textTransform: "uppercase",
  marginBottom: 8,
};

const titleStyle: CSSProperties = {
  fontSize: "clamp(22px,3vw,32px)",
  color: "#ffffff",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(5, 1fr)",
  gap: 12,
};

const cardStyle: CSSProperties = {
  position: "relative",
  display: "block",
  borderRadius: 10,
  overflow: "hidden",
  textDecoration: "none",
  color: "inherit",
};

const coverStyle: CSSProperties = {
  width: "100%",
  aspectRatio: "3/4",
  objectFit: "cover",
  display: "block",
  background: "#2c2c2e",
};

const scoreBadgeStyle: CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  background: "rgba(0,0,0,0.75)",
  backdropFilter: "blur(4px)",
  borderRadius: 6,
  padding: "2px 6px",
  fontSize: 12,
  fontWeight: 700,
  color: "#ff9f0a",
  fontFamily: "'JetBrains Mono',monospace",
  fontVariantNumeric: "tabular-nums",
};

const epBadgeStyle: CSSProperties = {
  position: "absolute",
  top: 8,
  left: 8,
  background: "rgba(0,0,0,0.75)",
  backdropFilter: "blur(4px)",
  borderRadius: 6,
  padding: "2px 6px",
  fontSize: 11,
  fontWeight: 600,
  color: "rgba(235,235,245,0.80)",
};

const gradientStyle: CSSProperties = {
  position: "absolute",
  bottom: 0,
  left: 0,
  right: 0,
  background:
    "linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.6) 50%, transparent 100%)",
  padding: "32px 10px 10px",
};

const titleTextStyle: CSSProperties = {
  fontFamily: "'Sora',sans-serif",
  fontSize: 13,
  fontWeight: 600,
  color: "#fff",
  overflow: "hidden",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  lineHeight: 1.4,
  marginBottom: 4,
};

const genresStyle: CSSProperties = {
  fontSize: 11,
  color: "rgba(235,235,245,0.50)",
  overflow: "hidden",
  whiteSpace: "nowrap",
  textOverflow: "ellipsis",
};

export default function CompletedGems({ items, dict, lang }: CompletedGemsProps) {
  if (!items || items.length === 0) return null;

  return (
    <section style={sectionStyle}>
      <div style={headerStyle}>
        <div>
          <p style={labelStyle}>{dict.home.gemsLabel}</p>
          <h2 style={titleStyle}>{dict.home.gemsTitle}</h2>
        </div>
      </div>

      <div className="gems-grid" style={gridStyle}>
        {items.map((item) => {
          // TrendingItem.genres is not on the type (it lives on
          // AnimeDetail). Fall back to an empty array via a structural
          // read so the file does not depend on Phase 5 detail shape.
          const genres = ((item as unknown) as { genres?: string[] }).genres ?? [];
          const score = item.averageScore ?? 0;
          const episodes = item.episodes ?? 0;
          const title = pickTitle(item, lang);
          return (
            <Link
              key={item.anilistId}
              href={`/anime/${item.anilistId}`}
              prefetch={false}
              className="gems-card"
              aria-label={title}
              style={cardStyle}
            >
              {item.coverImageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.coverImageUrl}
                  alt={title}
                  style={coverStyle}
                  loading="lazy"
                />
              ) : (
                <div style={coverStyle} aria-hidden />
              )}

              {score > 0 ? (
                <div style={scoreBadgeStyle}>{formatScore(score)}</div>
              ) : null}

              {episodes > 0 ? (
                <div style={epBadgeStyle}>
                  {episodes}
                  {dict.detail.epUnit}
                </div>
              ) : null}

              <div style={gradientStyle}>
                <div style={titleTextStyle}>{title}</div>
                <div style={genresStyle}>{genres.slice(0, 3).join(" / ")}</div>
              </div>
            </Link>
          );
        })}
      </div>

      <style>{`
        .gems-card { transition: transform 0.3s cubic-bezier(0.4,0,0.2,1), box-shadow 0.3s cubic-bezier(0.4,0,0.2,1); }
        .gems-card:hover { transform: translateY(-6px); box-shadow: 0 12px 28px rgba(0,0,0,0.50); }
        @media (max-width: 900px) {
          .gems-grid { grid-template-columns: repeat(3, 1fr) !important; }
        }
        @media (max-width: 600px) {
          .gems-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>
    </section>
  );
}
