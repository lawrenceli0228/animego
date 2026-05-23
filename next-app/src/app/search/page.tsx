// /search route -- Server Component that reads `q` + `genre` + `page` from
// searchParams, fetches Go /api/anime/search on the server, and renders
// AnimeCard grid + Pagination links. The filter row (input + chips) is
// a Client Component (SearchFilters) so user input can debounce and
// router.push back here without a full server round-trip per keystroke.
//
// Go endpoint shape note: /api/anime/search uses a CUSTOM envelope
// distinct from apiGetPaged's {data,total,page,hasMore,nextPage}. It
// returns {data:[...], pagination:{page,perPage,total,totalPages}}.
// We therefore bypass apiGet/apiGetPaged and call fetch directly.
// See go-api/internal/anime/search.go searchResponse for the source.

import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";
import AnimeCard, { type AnimeCardData } from "@/components/anime/AnimeCard";
import SearchFilters from "@/components/search/SearchFilters";
import { ApiError, getApiBase } from "@/lib/api";
import { getDict, getLang, type Dict, type Lang } from "@/lib/i18n";

// searchParams forces a dynamic render -- the page output depends on
// per-request query, so static prerender is impossible by construction.
export const dynamic = "force-dynamic";

interface SearchPageProps {
  searchParams: Promise<{
    q?: string;
    genre?: string;
    page?: string;
  }>;
}

// Row shape returned by GET /api/anime/search. Matches the Go
// GetAnimeByAnilistIDsRow struct in db/gen/anime_cache.sql.go:141.
// Distinct from TrendingItem -- no rank/watcherCount/genres -- so we
// declare it locally rather than reuse SeasonalAnime / TrendingItem.
interface SearchRow {
  anilistId: number;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
  titleChinese: string | null;
  coverImageUrl: string | null;
  coverImageColor: string | null;
  posterAccent: string | null;
  averageScore: number | null;
  bangumiScore: number | null;
  episodes: number | null;
  season: string | null;
  seasonYear: number | null;
  status: string | null;
  format: string | null;
  description: string | null;
}

interface SearchPagination {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

interface SearchResponse {
  data: SearchRow[];
  pagination: SearchPagination;
}

// Custom envelope unwrap for /api/anime/search. Keeps the central
// ApiError class so error logging upstream stays consistent, but does
// not pretend the shape matches apiGet's {data:T} or apiGetPaged's
// {data,total,page,hasMore,nextPage}.
async function fetchSearch(
  q: string,
  genre: string,
  page: number,
): Promise<SearchResponse> {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (genre) params.set("genre", genre);
  params.set("page", String(page));

  const url = `${getApiBase()}/api/anime/search?${params.toString()}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
  } catch (err) {
    throw new ApiError("NETWORK_ERROR", "fetch failed", 0, err);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new ApiError(
      "INVALID_JSON",
      `non-JSON response (status ${res.status})`,
      res.status,
      err,
    );
  }

  if (!res.ok || (body && typeof body === "object" && "error" in body)) {
    const errBody = body as { error?: { code?: string; message?: string } };
    throw new ApiError(
      errBody.error?.code || "SERVER_ERROR",
      errBody.error?.message || `HTTP ${res.status}`,
      res.status,
    );
  }

  return body as SearchResponse;
}

// Render headings that mirror legacy SearchPage.jsx:25-29 so SSR text
// matches the SPA exactly. Crawler bots and accessibility tools key
// off this <h1>, so keep it in sync with the active query.
function buildHeading(q: string, genre: string, dict: Dict, lang: Lang): string {
  if (q) {
    return lang === "zh"
      ? `搜索"${q}"的动画结果`
      : `Search results for "${q}"`;
  }
  if (genre) {
    return lang === "zh" ? `${genre} 类型的动画` : `${genre} anime`;
  }
  return dict.search.title;
}

// noindex when a query string is present -- there are effectively
// infinite (q, genre, page) permutations and indexing them dilutes
// crawl budget. Empty /search (the "browse" entry) stays indexable
// so the route shows up in sitemaps and SEO. Mirrors the typical
// e-commerce "site search noindex" pattern.
export async function generateMetadata({
  searchParams,
}: SearchPageProps): Promise<Metadata> {
  const { q = "", genre = "" } = await searchParams;
  const [dict, lang] = await Promise.all([getDict(), getLang()]);
  const heading = buildHeading(q, genre, dict, lang);

  const title = q || genre ? heading : dict.search.title;
  const hasQuery = Boolean(q || genre);

  return {
    title,
    description: hasQuery
      ? lang === "zh"
        ? `AnimeGo 搜索结果: ${q || genre}`
        : `AnimeGo search results for ${q || genre}`
      : dict.search.prompt,
    robots: hasQuery
      ? { index: false, follow: true }
      : { index: true, follow: true },
  };
}

const containerStyle: CSSProperties = {
  paddingTop: 40,
  paddingBottom: 40,
};

const headingStyle: CSSProperties = {
  fontSize: "clamp(22px,3vw,34px)",
  marginBottom: 24,
  background:
    "linear-gradient(135deg,#ffffff,rgba(235,235,245,0.60))",
  WebkitBackgroundClip: "text",
  WebkitTextFillColor: "transparent",
  fontFamily: "'Sora', sans-serif",
  fontWeight: 700,
};

const promptStyle: CSSProperties = {
  textAlign: "center",
  padding: "60px 0",
  color: "rgba(235,235,245,0.30)",
  fontFamily: "'Sora', sans-serif",
  fontSize: 15,
};

const errorStyle: CSSProperties = {
  textAlign: "center",
  padding: "60px 0",
  color: "#ff453a",
  fontFamily: "'Sora', sans-serif",
  fontSize: 14,
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(5, 1fr)",
  gap: 12,
};

const paginationWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 16,
  padding: "32px 0",
};

const pageButtonStyle = (disabled: boolean): CSSProperties => ({
  padding: "8px 20px",
  borderRadius: 8,
  border: `1px solid ${disabled ? "rgba(84,84,88,0.30)" : "rgba(84,84,88,0.65)"}`,
  color: disabled ? "rgba(235,235,245,0.18)" : "#ffffff",
  background: disabled ? "transparent" : "rgba(120,120,128,0.12)",
  cursor: disabled ? "not-allowed" : "pointer",
  fontFamily: "'DM Sans', sans-serif",
  fontSize: 14,
  fontWeight: 500,
  textDecoration: "none",
  display: "inline-block",
});

const pageInfoStyle: CSSProperties = {
  color: "rgba(235,235,245,0.60)",
  fontSize: 14,
  fontFamily: "'Sora', sans-serif",
};

// Build the /search URL preserving q + genre. Used by the server-side
// pagination links so prev/next navigate without losing filter state.
function buildHref(q: string, genre: string, page: number): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (genre) params.set("genre", genre);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/search?${qs}` : "/search";
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const { q: qRaw = "", genre = "", page: pageStr = "1" } = await searchParams;
  const q = qRaw.trim();
  const page = Math.max(1, Number(pageStr) || 1);

  const [dict, lang] = await Promise.all([getDict(), getLang()]);
  const heading = buildHeading(q, genre, dict, lang);
  const hasQuery = Boolean(q || genre);

  let results: SearchResponse | null = null;
  let fetchError: string | null = null;
  if (hasQuery) {
    try {
      results = await fetchSearch(q, genre, page);
    } catch (err) {
      // Render the rest of the page (heading + filters) even on
      // upstream failure so the user can still tweak inputs. Log
      // server-side for ops; surface a generic message to the UI.
      if (err instanceof ApiError) {
        fetchError = err.message;
        if (err.status !== 404) {
          console.warn(`[SearchPage] fetch failed: ${err.code} ${err.message}`);
        }
      } else {
        fetchError = "unknown error";
        console.warn("[SearchPage] unexpected error:", err);
      }
    }
  }

  const totalPages = results?.pagination.totalPages ?? 0;
  const animeList: SearchRow[] = results?.data ?? [];

  return (
    <div className="container" style={containerStyle}>
      <style>{`
        .search-anime-grid {
          grid-template-columns: repeat(5, 1fr);
        }
        @media (max-width: 900px) {
          .search-anime-grid { grid-template-columns: repeat(3, 1fr) !important; }
        }
        @media (max-width: 600px) {
          .search-anime-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>

      <h1 style={headingStyle}>{heading}</h1>

      <SearchFilters initialQ={q} initialGenre={genre} dict={dict} />

      {!hasQuery ? (
        <div style={promptStyle}>{dict.search.prompt}</div>
      ) : fetchError ? (
        <div style={errorStyle}>
          {dict.anime.loadError}: {fetchError}
        </div>
      ) : animeList.length === 0 ? (
        <div style={promptStyle}>{dict.anime.noAnime}</div>
      ) : (
        <>
          <div className="search-anime-grid" style={gridStyle}>
            {animeList.map((a) => {
              // SearchRow lacks `genres` -- AnimeCard treats it as
              // optional and degrades gracefully (no chip overlay).
              const cardData: AnimeCardData = {
                anilistId: a.anilistId,
                titleChinese: a.titleChinese,
                titleRomaji: a.titleRomaji,
                titleEnglish: a.titleEnglish,
                titleNative: a.titleNative,
                coverImageUrl: a.coverImageUrl,
                posterAccent: a.posterAccent,
                averageScore: a.averageScore,
                format: a.format,
              };
              return (
                <AnimeCard
                  key={a.anilistId}
                  anime={cardData}
                  lang={lang}
                  prefetch={false}
                />
              );
            })}
          </div>

          {totalPages > 1 ? (
            <nav
              style={paginationWrapStyle}
              aria-label="search pagination"
            >
              {page > 1 ? (
                <Link
                  href={buildHref(q, genre, page - 1)}
                  prefetch={false}
                  style={pageButtonStyle(false)}
                >
                  {lang === "zh" ? "上一页" : "Prev"}
                </Link>
              ) : (
                <span style={pageButtonStyle(true)} aria-disabled>
                  {lang === "zh" ? "上一页" : "Prev"}
                </span>
              )}
              <span style={pageInfoStyle}>
                <span style={{ color: "#ffffff", fontWeight: 700 }}>
                  {page}
                </span>
                {" / "}
                {totalPages}
              </span>
              {page < totalPages ? (
                <Link
                  href={buildHref(q, genre, page + 1)}
                  prefetch={false}
                  style={pageButtonStyle(false)}
                >
                  {lang === "zh" ? "下一页" : "Next"}
                </Link>
              ) : (
                <span style={pageButtonStyle(true)} aria-disabled>
                  {lang === "zh" ? "下一页" : "Next"}
                </span>
              )}
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}
