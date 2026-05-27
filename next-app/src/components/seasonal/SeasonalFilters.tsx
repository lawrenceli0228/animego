"use client";

// Client-side filtering surface for /seasonal/[season]/[year].
//
// Why client state instead of URL search params:
//   The legacy SPA (client/src/pages/SeasonPage.jsx) stored season+year
//   in the URL via react-router useSearchParams and kept genre/format/
//   status/sort in local useState. We preserve the same split for v2.0:
//   - season+year remain path segments (RSC route, SEO-friendly)
//   - filters stay in client state so chip clicks don't re-render the
//     entire RSC subtree (which would require either a route push or a
//     server-rendered grid swap). URL sync (?genre=Action&format=TV) is
//     a v2.1 nice-to-have, not v2.0.
//
// The full season page (up to perPage=200, currently ~96 anime for
// spring 2026) is fetched once on the server and streamed into this
// component as a prop, so all filter / sort / show-more interactions
// run locally with zero additional network calls.

import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import AnimeCard from "@/components/anime/AnimeCard";
import { pickTitle } from "@/lib/formatters";
import type { Lang } from "@/lib/i18n";
import type { SeasonalAnime } from "@/lib/types";

// ─── Filter taxonomy ────────────────────────────────────────────────
// Ported verbatim from client/src/pages/SeasonPage.jsx (lines 11-27)
// so labels match what users see on the legacy SPA today.

const FORMATS = ["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA"] as const;
type Format = (typeof FORMATS)[number];

const STATUSES = ["RELEASING", "FINISHED", "NOT_YET_RELEASED"] as const;
type Status = (typeof STATUSES)[number];

const FORMAT_LABELS: Record<Lang, Record<Format, string>> = {
  zh: { TV: "TV", TV_SHORT: "TV短篇", MOVIE: "剧场版", SPECIAL: "特别篇", OVA: "OVA", ONA: "ONA" },
  en: { TV: "TV", TV_SHORT: "Short", MOVIE: "Movie", SPECIAL: "Special", OVA: "OVA", ONA: "ONA" },
};

const STATUS_LABELS: Record<Lang, Record<Status, string>> = {
  zh: { RELEASING: "连载中", FINISHED: "已完结", NOT_YET_RELEASED: "未开播" },
  en: { RELEASING: "Airing", FINISHED: "Finished", NOT_YET_RELEASED: "Upcoming" },
};

type SortKey = "score" | "title" | "format";

const SORT_OPTIONS: Array<{ value: SortKey; zh: string; en: string }> = [
  { value: "score", zh: "评分", en: "Score" },
  { value: "title", zh: "标题", en: "Title" },
  { value: "format", zh: "格式", en: "Format" },
];

// Genre list — single source of truth lives in
// client/src/utils/constants.js (GENRES). 18 canonical AniList genres,
// mirrored here so this client component has no cross-package import.
const GENRES = [
  "Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy",
  "Horror", "Mahou Shoujo", "Mecha", "Music", "Mystery", "Psychological",
  "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller",
] as const;
type Genre = (typeof GENRES)[number] | "";

// ─── Pagination ─────────────────────────────────────────────────────
// Show-more pacing matches the legacy SeasonPage (INITIAL_COUNT=20,
// LOAD_MORE=20 — four rows of five at desktop width).

const INITIAL_COUNT = 20;
const LOAD_MORE = 20;

// ─── Styles ─────────────────────────────────────────────────────────
// Inline styles ported from the legacy ChipFilter component (lines
// 29-45) so visual parity is preserved. Same opacities, same radii,
// same accent blue (#0a84ff @ 15% bg / solid fg).

const wrapStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  marginBottom: 20,
};

const genreRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
};

const formatStatusRowStyle: CSSProperties = {
  display: "flex",
  gap: 16,
  flexWrap: "wrap",
  alignItems: "center",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  flexWrap: "wrap",
};

const dividerStyle: CSSProperties = {
  width: 1,
  height: 20,
  background: "#38383a",
};

const sortRowStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
};

const selectStyle: CSSProperties = {
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid #38383a",
  background: "#1c1c1e",
  color: "rgba(235,235,245,0.60)",
  fontSize: 12,
  cursor: "pointer",
  outline: "none",
};

const clearBtnStyle: CSSProperties = {
  padding: "5px 12px",
  borderRadius: 8,
  border: "none",
  background: "rgba(255,69,58,0.1)",
  color: "#ff453a",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const countStyle: CSSProperties = {
  fontSize: 12,
  color: "rgba(235,235,245,0.30)",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
  gap: 12,
  animation: "fadeUp 0.4s ease both",
};

const emptyStyle: CSSProperties = {
  textAlign: "center",
  padding: "60px 0",
  color: "rgba(235,235,245,0.30)",
  fontFamily: "'Sora', sans-serif",
};

const showMoreWrapStyle: CSSProperties = {
  display: "flex",
  justifyContent: "center",
  marginTop: 32,
};

const showMoreBtnStyle: CSSProperties = {
  padding: "10px 36px",
  borderRadius: 10,
  border: "1px solid #38383a",
  background: "rgba(120,120,128,0.08)",
  color: "rgba(235,235,245,0.60)",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  transition: "all 0.2s",
};

// Per-chip style — `selected` is a string from the parent state, `o` is
// the option this chip represents; both null/empty when no filter is
// active.
function chipStyle(active: boolean): CSSProperties {
  return {
    padding: "5px 14px",
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    border: "none",
    transition: "all 0.2s",
    background: active ? "rgba(10,132,255,0.15)" : "rgba(120,120,128,0.08)",
    color: active ? "#0a84ff" : "rgba(235,235,245,0.40)",
  };
}

// Genre chip uses a slightly different visual (border + 12% bg) — same
// as the legacy GenreFilter component, kept distinct so it doesn't read
// as just-another-format-pill.
function genreChipStyle(active: boolean): CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 9999,
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    transition: "all 0.2s",
    background: active ? "rgba(10,132,255,0.12)" : "rgba(120,120,128,0.12)",
    border: `1px solid ${active ? "rgba(10,132,255,0.5)" : "transparent"}`,
    color: active ? "#0a84ff" : "rgba(235,235,245,0.60)",
  };
}

// ─── Props ──────────────────────────────────────────────────────────

interface SeasonalFiltersProps {
  items: SeasonalAnime[];
  lang: Lang;
}

// ─── Component ──────────────────────────────────────────────────────

export default function SeasonalFilters({ items, lang }: SeasonalFiltersProps) {
  const [genre, setGenre] = useState<Genre>("");
  const [format, setFormat] = useState<Format | "">("");
  const [status, setStatus] = useState<Status | "">("");
  const [sortBy, setSortBy] = useState<SortKey>("score");
  const [visibleCount, setVisibleCount] = useState(INITIAL_COUNT);

  // Filter + sort runs in memo so toggling unrelated UI doesn't rebuild
  // the (potentially 200-item) list. The legacy SeasonPage uses the
  // same shape — see useMemo at lines 78-97.
  const filtered = useMemo(() => {
    let list = items;
    if (genre) list = list.filter((a) => a.genres?.includes(genre));
    if (format) list = list.filter((a) => a.format === format);
    if (status) list = list.filter((a) => a.status === status);

    const sorted = [...list];
    switch (sortBy) {
      case "title":
        sorted.sort((a, b) => pickTitle(a, lang).localeCompare(pickTitle(b, lang)));
        break;
      case "format":
        // Group by format order then break ties by descending score —
        // same compound sort as legacy SeasonPage line 91.
        sorted.sort(
          (a, b) =>
            FORMATS.indexOf(a.format as Format) - FORMATS.indexOf(b.format as Format) ||
            (b.averageScore ?? 0) - (a.averageScore ?? 0),
        );
        break;
      default:
        // score: API already returns rows sorted by score desc, so the
        // memoised copy preserves that order.
        break;
    }
    return sorted;
  }, [items, genre, format, status, sortBy, lang]);

  const displayed = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;
  const hasFilters = Boolean(genre || format || status);

  // Every filter change resets the visible window — otherwise a user
  // who paged to 100 cards then toggled a chip would see a confusing
  // partial slice of the new filtered set.
  const onGenre = (g: Genre) => {
    setGenre(g);
    setVisibleCount(INITIAL_COUNT);
  };
  const onFormat = (f: Format | "") => {
    setFormat(f);
    setVisibleCount(INITIAL_COUNT);
  };
  const onStatus = (s: Status | "") => {
    setStatus(s);
    setVisibleCount(INITIAL_COUNT);
  };
  const resetFilters = () => {
    setGenre("");
    setFormat("");
    setStatus("");
    setVisibleCount(INITIAL_COUNT);
  };

  const showMoreLabel = lang === "zh" ? "显示更多" : "Show More";
  const clearLabel = lang === "zh" ? "清除筛选" : "Clear Filters";
  const countLabel = lang === "zh" ? "部" : "anime";
  const emptyLabel = lang === "zh" ? "暂无番剧" : "No anime found";

  return (
    <>
      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: none; }
        }
      `}</style>
      <div style={wrapStyle}>
        <div style={genreRowStyle}>
          {GENRES.map((g) => {
            const active = genre === g;
            return (
              <button
                key={g}
                type="button"
                style={genreChipStyle(active)}
                onClick={() => onGenre(active ? "" : g)}
              >
                {g}
              </button>
            );
          })}
        </div>

        <div style={formatStatusRowStyle}>
          <div style={chipRowStyle}>
            {FORMATS.map((f) => {
              const active = format === f;
              return (
                <button
                  key={f}
                  type="button"
                  style={chipStyle(active)}
                  onClick={() => onFormat(active ? "" : f)}
                >
                  {FORMAT_LABELS[lang][f]}
                </button>
              );
            })}
          </div>
          <div style={dividerStyle} />
          <div style={chipRowStyle}>
            {STATUSES.map((s) => {
              const active = status === s;
              return (
                <button
                  key={s}
                  type="button"
                  style={chipStyle(active)}
                  onClick={() => onStatus(active ? "" : s)}
                >
                  {STATUS_LABELS[lang][s]}
                </button>
              );
            })}
          </div>
        </div>

        <div style={sortRowStyle}>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortKey)}
            style={selectStyle}
            aria-label={lang === "zh" ? "排序" : "Sort"}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {lang === "zh" ? o.zh : o.en}
              </option>
            ))}
          </select>
          {hasFilters && (
            <button type="button" onClick={resetFilters} style={clearBtnStyle}>
              {clearLabel}
            </button>
          )}
          <span style={countStyle}>
            {filtered.length} {countLabel}
          </span>
        </div>
      </div>

      {displayed.length === 0 ? (
        <div style={emptyStyle}>{emptyLabel}</div>
      ) : (
        <div style={gridStyle}>
          {displayed.map((a) => (
            <AnimeCard key={a.anilistId} anime={a} lang={lang} prefetch={false} />
          ))}
        </div>
      )}

      {hasMore && (
        <div style={showMoreWrapStyle}>
          <button
            type="button"
            style={showMoreBtnStyle}
            onClick={() => setVisibleCount((v) => v + LOAD_MORE)}
          >
            {showMoreLabel}
          </button>
        </div>
      )}
    </>
  );
}
