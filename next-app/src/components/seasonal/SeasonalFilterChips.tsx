"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { CSSProperties } from "react";
import type { Lang } from "@/lib/i18n";

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

export const GENRES = [
  "Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy",
  "Horror", "Mahou Shoujo", "Mecha", "Music", "Mystery", "Psychological",
  "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller",
] as const;
export type Genre = (typeof GENRES)[number];

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

interface SeasonalFilterChipsProps {
  lang: Lang;
  filteredCount: number;
}

export default function SeasonalFilterChips({ lang, filteredCount }: SeasonalFilterChipsProps) {
  const router = useRouter();
  const params = useSearchParams();

  const genre = params.get("genre") ?? "";
  const format = params.get("format") ?? "";
  const status = params.get("status") ?? "";
  const sortBy = (params.get("sort") ?? "score") as SortKey;

  function push(updates: Record<string, string>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v) {
        next.set(k, v);
      } else {
        next.delete(k);
      }
    }
    next.delete("page");
    // `show` is "load more" cursor — reset on filter change or the next
    // RSC re-render will keep the over-extended slice (stale on back-nav).
    next.delete("show");
    router.replace(`?${next.toString()}`, { scroll: false });
  }

  const hasFilters = Boolean(genre || format || status);
  const clearLabel = lang === "zh" ? "清除筛选" : "Clear Filters";
  const countLabel = lang === "zh" ? "部" : "anime";

  return (
    <div style={wrapStyle}>
      <div style={genreRowStyle}>
        {GENRES.map((g) => {
          const active = genre === g;
          return (
            <button
              key={g}
              type="button"
              style={genreChipStyle(active)}
              onClick={() => push({ genre: active ? "" : g })}
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
                onClick={() => push({ format: active ? "" : f })}
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
                onClick={() => push({ status: active ? "" : s })}
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
          onChange={(e) => push({ sort: e.target.value })}
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
          <button
            type="button"
            onClick={() => push({ genre: "", format: "", status: "" })}
            style={clearBtnStyle}
          >
            {clearLabel}
          </button>
        )}
        <span style={countStyle}>
          {filteredCount} {countLabel}
        </span>
      </div>
    </div>
  );
}
