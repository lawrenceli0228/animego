// /search route -- Server Component that reads `q` + `genre` + `page` from
// searchParams, fetches Go /api/anime/search on the server, and hands the
// first result set to SearchExperience.
//
// Everything interactive lives in that Client Component, including the
// heading and the grid. This page renders the first answer and the metadata:
// a shared link, a crawler and a reader with JS off see a complete page, and
// from the first keystroke onward the browser talks to go-api itself rather
// than pushing a new URL through here for every character. See
// components/search/SearchExperience.tsx for what that fixed.
//
// Go endpoint shape note: /api/anime/search uses a CUSTOM envelope
// distinct from apiGetPaged's {data,total,page,hasMore,nextPage}. It
// returns {data:[...], pagination:{page,perPage,total,totalPages}}.
// We therefore bypass apiGet/apiGetPaged and call fetch directly.
// See go-api/internal/anime/search.go searchResponse for the source.

import type { Metadata } from "next";
import type { CSSProperties } from "react";
import SearchExperience from "@/components/search/SearchExperience";
import { buildHeading, META_DESCRIPTION } from "@/components/search/searchHeading";
import {
  hasTerms,
  parseSearchResponse,
  queryFromParams,
  searchApiPath,
  type SearchQuery,
  type SearchResultSet,
} from "@/components/search/searchQuery";
import { ApiError, getApiBase } from "@/lib/api";
import { genreLabel } from "@/lib/contentLabels";
import { resolveLocale } from "@/lib/i18n/route";
import { buildAlternates } from "@/lib/seo/alternates";

// searchParams forces a dynamic render -- the page output depends on
// per-request query, so static prerender is impossible by construction.
export const dynamic = "force-dynamic";

// Hand-written rather than the generated PageProps<"/[lang]/search">: that
// helper types searchParams as Record<string, string | string[] | undefined>,
// and every read below treats these three keys as plain strings. Adopting it
// would mean adding a narrowing step at each use for no gain. `params` is the
// part that matters here and it matches the generated ParamMap entry exactly.
interface SearchPageProps {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{
    q?: string;
    genre?: string;
    page?: string;
  }>;
}

// Custom envelope unwrap for /api/anime/search. Keeps the central
// ApiError class so error logging upstream stays consistent, but does
// not pretend the shape matches apiGet's {data:T} or apiGetPaged's
// {data,total,page,hasMore,nextPage}.
async function fetchSearch(query: SearchQuery): Promise<SearchResultSet> {
  const url = `${getApiBase()}${searchApiPath(query)}`;
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

  const parsed = parseSearchResponse(body);
  if (!parsed) {
    throw new ApiError("INVALID_JSON", "unexpected search envelope", res.status);
  }
  return parsed;
}

// noindex when a query string is present -- there are effectively
// infinite (q, genre, page) permutations and indexing them dilutes
// crawl budget. Empty /search (the "browse" entry) stays indexable
// so the route shows up in sitemaps and SEO. Mirrors the typical
// e-commerce "site search noindex" pattern.
export async function generateMetadata({
  params,
  searchParams,
}: SearchPageProps): Promise<Metadata> {
  const { q = "", genre = "" } = await searchParams;
  const { locale, dict, lang } = await resolveLocale(params);
  const heading = buildHeading(q, genre, dict, lang);

  const title = q || genre ? heading : dict.search.title;
  const hasQuery = Boolean(q || genre);
  // Only the genre term is translated here; the surrounding copy is untouched.
  // genreLabel is the identity for en, so the English description is unchanged.
  const subject = q || genreLabel(genre, lang);

  return {
    title,
    description: hasQuery ? META_DESCRIPTION[lang](subject) : dict.search.prompt,
    robots: hasQuery
      ? { index: false, follow: true }
      : { index: true, follow: true },
    // Always the bare path, including on the noindex query variants. This
    // route had no canonical at all, while robots.ts declares it crawlable
    // and the homepage JSON-LD points a SearchAction at
    // /search?q={search_term_string} — so the one URL shape Google is
    // actively told about was both unindexable and unconsolidated. Pointing
    // every permutation at /search collapses them onto the indexable entry
    // instead of leaving them to accumulate as orphans.
    alternates: buildAlternates("/search", locale),
  };
}

const containerStyle: CSSProperties = {
  paddingTop: 40,
  paddingBottom: 40,
};

export default async function SearchPage({ params, searchParams }: SearchPageProps) {
  const { q, genre, page } = await searchParams;
  const query = queryFromParams(q, genre, page);
  const { dict, lang } = await resolveLocale(params);

  let results: SearchResultSet | null = null;
  let fetchError: string | null = null;
  if (hasTerms(query)) {
    try {
      results = await fetchSearch(query);
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

  return (
    <div className="container" style={containerStyle}>
      <SearchExperience
        initialQuery={query}
        initialResults={results}
        initialError={fetchError}
        dict={dict}
        lang={lang}
      />
    </div>
  );
}
