"use client";

/**
 * ManualSearch — fallback picker when matchAnime fails (drop-zone) OR when the
 * user rematches a series from the Library. Same component, two entry points.
 *
 * Library's RematchDialog imports this via re-export from
 * `library/_components/ManualSearchPlaceholder.tsx` so the rematch flow has
 * the real search UI without changing its import path.
 *
 * Ported from legacy client/src/components/player/ManualSearch.jsx (P6.6).
 */

import { useState, useCallback, type CSSProperties } from "react";
import { useLang } from "@/lib/lang-client";
import FadeImage from "@/components/ui/FadeImage";
import { ChapterBar, CornerBrackets } from "@/components/landing/shared/hud";
import { mono, PLAYER_HUE } from "@/components/landing/shared/hud-tokens";

const HUE = PLAYER_HUE.ingest;
const HUE_STREAM = PLAYER_HUE.stream;

const s: Record<string, CSSProperties | ((hover: boolean) => CSSProperties)> = {
  container: {
    position: "relative",
    maxWidth: 600,
    margin: "0 auto",
    padding: "24px 28px 28px 56px",
    background: `linear-gradient(180deg, oklch(14% 0.04 ${HUE} / 0.55) 0%, rgba(20,20,22,0.55) 100%)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.36)`,
    borderRadius: 4,
  },
  backBtn: {
    ...mono,
    background: "transparent",
    border: "1px solid rgba(235,235,245,0.20)",
    borderRadius: 2,
    color: "rgba(235,235,245,0.75)",
    fontSize: 11,
    cursor: "pointer",
    padding: "6px 12px",
    marginBottom: 18,
    textTransform: "uppercase",
    letterSpacing: "0.14em",
  },
  hint: {
    ...mono,
    fontSize: 11,
    color: `oklch(72% 0.15 ${HUE} / 0.85)`,
    marginBottom: 18,
    textTransform: "uppercase",
    letterSpacing: "0.16em",
  },
  inputRow: {
    display: "flex",
    gap: 8,
    marginBottom: 22,
  },
  input: {
    flex: 1,
    padding: "10px 4px",
    background: "transparent",
    border: "none",
    borderBottom: `1px solid oklch(46% 0.06 ${HUE_STREAM} / 0.55)`,
    color: "#ffffff",
    fontSize: 16,
    outline: "none",
    fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: "0.04em",
  },
  searchBtn: {
    ...mono,
    padding: "10px 18px",
    borderRadius: 2,
    background: "transparent",
    border: `1px solid oklch(62% 0.19 ${HUE_STREAM} / 0.55)`,
    color: `oklch(78% 0.15 ${HUE_STREAM})`,
    fontSize: 11,
    fontWeight: 500,
    cursor: "pointer",
    flexShrink: 0,
    textTransform: "uppercase",
    letterSpacing: "0.14em",
  },
  resultRow: (hover: boolean): CSSProperties => ({
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 14px",
    borderRadius: 2,
    marginBottom: 8,
    transition: "background 150ms, border-color 150ms",
    cursor: "pointer",
    background: hover ? `oklch(62% 0.19 ${HUE_STREAM} / 0.10)` : "transparent",
    borderLeft: hover
      ? `2px solid oklch(62% 0.19 ${HUE_STREAM} / 0.85)`
      : "2px solid transparent",
  }),
  cover: {
    width: 60,
    aspectRatio: "3/4",
    borderRadius: 2,
    objectFit: "cover",
    background: "#2c2c2e",
    flexShrink: 0,
  },
  info: { flex: 1, minWidth: 0 },
  title: {
    fontFamily: "'Sora',sans-serif",
    fontSize: 15,
    fontWeight: 600,
    color: "#ffffff",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  meta: {
    ...mono,
    fontSize: 11,
    color: "rgba(235,235,245,0.45)",
    marginTop: 4,
    letterSpacing: "0.06em",
  },
  selectBtn: {
    ...mono,
    padding: "6px 14px",
    borderRadius: 2,
    background: "transparent",
    border: `1px solid oklch(62% 0.19 ${HUE} / 0.50)`,
    color: `oklch(78% 0.15 ${HUE})`,
    fontSize: 11,
    fontWeight: 500,
    cursor: "pointer",
    flexShrink: 0,
    textTransform: "uppercase",
    letterSpacing: "0.14em",
  },
  empty: {
    ...mono,
    textAlign: "center",
    padding: 32,
    color: "rgba(235,235,245,0.45)",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.14em",
  },
};

// dandanplay /search shape — server returns a slim subset, keep loose.
export interface AnimeSearchResult {
  anilistId?: number;
  dandanAnimeId?: number;
  title?: string;
  titleChinese?: string;
  coverImageUrl?: string;
  imageUrl?: string;
  seasonYear?: number | string;
  format?: string;
  episodes?: number;
  averageScore?: number | string;
  [key: string]: unknown;
}

interface SearchResponse {
  results?: AnimeSearchResult[];
}

async function searchAnime(keyword: string): Promise<SearchResponse> {
  const url = `/api/dandanplay/search?keyword=${encodeURIComponent(keyword)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`searchAnime: HTTP ${res.status}`);
  return (await res.json()) as SearchResponse;
}

interface ResultRowProps {
  item: AnimeSearchResult;
  onSelect: (item: AnimeSearchResult) => void;
  t: (key: string) => string;
}

function ResultRow({ item, onSelect, t }: ResultRowProps) {
  const [hover, setHover] = useState(false);
  return (
    <div
      style={(s.resultRow as (h: boolean) => CSSProperties)(hover)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <FadeImage
        style={s.cover as CSSProperties}
        src={item.coverImageUrl || item.imageUrl || ""}
        alt=""
      />
      <div style={s.info as CSSProperties}>
        <div style={s.title as CSSProperties}>
          {item.titleChinese || item.title}
        </div>
        <div style={s.meta as CSSProperties}>
          {item.seasonYear && `${item.seasonYear} `}
          {item.format && `· ${item.format} `}
          {item.episodes && `· ${item.episodes}${t("detail.epUnit")}`}
          {item.averageScore && ` · ★ ${item.averageScore}`}
        </div>
      </div>
      <button
        type="button"
        style={s.selectBtn as CSSProperties}
        onClick={() => onSelect(item)}
      >
        {t("player.select")}
      </button>
    </div>
  );
}

export interface ManualSearchProps {
  defaultKeyword: string;
  onSelect: (item: AnimeSearchResult) => void;
  onBack: () => void;
}

export function ManualSearch({ defaultKeyword, onSelect, onBack }: ManualSearchProps) {
  const { t } = useLang();
  const [query, setQuery] = useState(defaultKeyword || "");
  const [results, setResults] = useState<AnimeSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const doSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const data = await searchAnime(query.trim());
      setResults(data.results || []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
      setSearched(true);
    }
  }, [query]);

  return (
    <div style={s.container as CSSProperties}>
      <ChapterBar hue={HUE} height={48} top={20} left={20} trigger="mount" />
      <CornerBrackets inset={6} size={10} opacity={0.32} hue={HUE} />

      <button
        type="button"
        style={s.backBtn as CSSProperties}
        onClick={onBack}
      >
        ← {t("player.back")}
      </button>
      <div style={s.hint as CSSProperties}>// {t("player.manualHint")}</div>
      <div style={s.inputRow as CSSProperties}>
        <input
          style={s.input as CSSProperties}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && doSearch()}
          placeholder={t("player.searchPlaceholder")}
        />
        <button
          type="button"
          style={s.searchBtn as CSSProperties}
          onClick={doSearch}
          disabled={loading}
        >
          {loading ? "..." : t("player.searchBtn")}
        </button>
      </div>

      {results.map((item, i) => (
        <ResultRow
          key={item.anilistId || item.dandanAnimeId || i}
          item={item}
          onSelect={onSelect}
          t={t}
        />
      ))}

      {searched && !results.length && !loading && (
        <div style={s.empty as CSSProperties}>{t("player.noResults")}</div>
      )}
    </div>
  );
}

export default ManualSearch;
