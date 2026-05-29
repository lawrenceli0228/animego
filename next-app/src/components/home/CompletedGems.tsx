"use client";

// Visual + behavior parity with client/src/components/home/CompletedGems.jsx.
//
// The /api/anime/completed-gems endpoint returns a RANDOM sample on
// every call — that is the whole point of the "换一批" (refresh batch)
// button. A pure RSC version (Phase 8.0 initial port) lost that
// behavior by treating items as static parent-fetched props. Restored
// here: parent still SSR-fetches initialItems so SEO + first paint stay
// fast, but the refresh button re-fetches client-side and swaps the
// list in place — same UX as the legacy React Query
// queryClient.invalidateQueries(['completedGems']) call.

import Link from "next/link";
import { useCallback, useState, type CSSProperties } from "react";
import FadeImage from "@/components/ui/FadeImage";
import { formatScore, pickTitle } from "@/lib/formatters";
import type { Dict, Lang } from "@/lib/i18n";
import type { TrendingItem } from "@/lib/types";

export interface CompletedGemsProps {
  initialItems: TrendingItem[];
  dict: Dict;
  lang: Lang;
  limit?: number;
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

const refreshButtonStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 18px",
  borderRadius: 9999,
  fontSize: 13,
  fontWeight: 500,
  border: "1px solid #38383a",
  background: "transparent",
  color: "rgba(235,235,245,0.60)",
  cursor: "pointer",
  transition: "all 0.2s",
};

const refreshButtonBusyStyle: CSSProperties = {
  ...refreshButtonStyle,
  opacity: 0.6,
  cursor: "wait",
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

type GemItem = TrendingItem & { genres?: string[] };

export default function CompletedGems({
  initialItems,
  dict,
  lang,
  limit = 10,
}: CompletedGemsProps) {
  const [items, setItems] = useState<GemItem[]>(initialItems as GemItem[]);
  const [busy, setBusy] = useState(false);

  const handleRefresh = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Cache-buster query param so any HTTP/CDN cache layer between us
      // and the API returns a fresh random sample instead of replaying
      // the previous response. The endpoint itself shuffles per call,
      // but Cloudflare / nginx could collapse identical URLs.
      const res = await fetch(
        `/api/anime/completed-gems?limit=${limit}&_=${Date.now()}`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const body = (await res.json()) as
        | { data: GemItem[] }
        | GemItem[];
      const next = Array.isArray(body) ? body : body.data;
      if (Array.isArray(next) && next.length > 0) setItems(next);
    } catch {
      // Silent: refresh failure leaves the previous batch on screen,
      // matching legacy behavior (React Query also silently keeps the
      // last successful query result on a failed refetch).
    } finally {
      setBusy(false);
    }
  }, [busy, limit]);

  if (!items || items.length === 0) return null;

  return (
    <section style={sectionStyle}>
      <div style={headerStyle}>
        <div>
          <p style={labelStyle}>{dict.home.gemsLabel}</p>
          <h2 style={titleStyle}>{dict.home.gemsTitle}</h2>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={busy}
          aria-label={dict.home.gemsRefresh}
          className="gems-refresh-btn"
          style={busy ? refreshButtonBusyStyle : refreshButtonStyle}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              animation: busy ? "gems-spin 0.9s linear infinite" : undefined,
            }}
          >
            <path d="M21 2v6h-6" />
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
            <path d="M3 22v-6h6" />
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          </svg>
          {dict.home.gemsRefresh}
        </button>
      </div>

      <div className="gems-grid" style={gridStyle}>
        {items.map((item) => {
          const genres = item.genres ?? [];
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
                <FadeImage
                  src={item.coverImageUrl}
                  alt={title}
                  style={coverStyle}
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
        .gems-refresh-btn:hover:not(:disabled) {
          border-color: #0a84ff !important;
          color: #0a84ff !important;
        }
        @keyframes gems-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
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
