"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { CSSProperties } from "react";
import { FILTER_GENRES, formatLabel, genreLabel, statusLabel } from "@/lib/contentLabels";
import { useLang } from "@/lib/lang-client";
import type { Lang } from "@/lib/i18n/lang";

// Formats offered as filters — 6 of AniList's 7. MUSIC is not offered here and
// was also missing from the old local label map, so the gap was latent rather
// than live; formatLabel covers all 7, so adding MUSIC to this row later is a
// pure product decision and can no longer leak the raw enum into the UI.
// Kept local (not in contentLabels) because it is this row's filter set, not a
// shared vocabulary — page.tsx validates ?format= against its own copy.
const FORMATS = ["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA"] as const;

const STATUSES = ["RELEASING", "FINISHED", "NOT_YET_RELEASED"] as const;

type SortKey = "score" | "title" | "format";

// `label` is keyed by Lang rather than held as loose zh/en fields so a new
// language is a compile error here instead of a silent fall-through to English.
const SORT_OPTIONS: Array<{ value: SortKey; label: Record<Lang, string> }> = [
  { value: "score", label: { zh: "评分", en: "Score" } },
  { value: "title", label: { zh: "标题", en: "Title" } },
  { value: "format", label: { zh: "格式", en: "Format" } },
];

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
  filteredCount: number;
}

export default function SeasonalFilterChips({ filteredCount }: SeasonalFilterChipsProps) {
  const router = useRouter();
  const params = useSearchParams();
  // The language comes from useLang(), NOT from a server-passed prop: getLang()
  // is pinned to "zh" server-side (ISR islanding), so a prop would hand every
  // visitor zh and translate the chips for English readers too. useLang() seeds
  // zh for SSR and reconciles to the `lang` cookie after mount, which is what
  // keeps genre chips reading "Action" rather than "动作" in English.
  const { lang } = useLang();

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
        {FILTER_GENRES.map((g) => {
          const active = genre === g;
          return (
            <button
              key={g}
              type="button"
              style={genreChipStyle(active)}
              // The URL value stays the raw AniList enum — only the visible
              // text is translated, so shared links and the server-side
              // filter in page.tsx keep working unchanged.
              onClick={() => push({ genre: active ? "" : g })}
            >
              {genreLabel(g, lang)}
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
                {formatLabel(f, lang)}
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
                {statusLabel(s, lang)}
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
              {o.label[lang]}
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
