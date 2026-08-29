// The shape of a /search request, and the two URLs it turns into.
//
// Pure on purpose — no React, no fetch, no window. Both sides of the page use
// it: the Server Component builds the first result set through
// `parseSearchResponse`, and SearchExperience builds every subsequent one
// through the same function, so the two cannot disagree about what a row is.

/**
 * A row of GET /api/anime/search. Matches the Go GetAnimeByAnilistIDsRow
 * struct in db/gen/anime_cache.sql.go:141 — distinct from TrendingItem (no
 * rank / watcherCount / genres), which is why it is declared rather than
 * reused.
 */
export interface SearchRow {
  anilistId: number;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
  titleChinese: string | null;
  // go-api has returned this since migration 0022 — GetAnimeByAnilistIDs
  // selects it, and both the AniList and the local-catalogue paths read
  // through that one query. The page's own interface used to omit it, and
  // /zh-Hant/search rendered Simplified titles on 12 of 18 production cards.
  titleHant: string | null;
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

/** One answered page of results. */
export interface SearchResultSet {
  rows: SearchRow[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

/** What the reader is asking for. */
export interface SearchQuery {
  readonly q: string;
  readonly genre: string;
  readonly page: number;
}

/**
 * A query with the keyword trimmed and the page floored at 1.
 *
 * Trimming here rather than at each call site is what makes `sameQuery` mean
 * what it says: without it, typing a trailing space would count as a new
 * query and cost a request that returns the same rows.
 */
export function makeQuery(q: string, genre: string, page: number): SearchQuery {
  return {
    q: q.trim(),
    genre,
    page: Number.isFinite(page) && page > 1 ? Math.floor(page) : 1,
  };
}

/** Parse the three values as they arrive from a URL. */
export function queryFromParams(
  q: string | undefined,
  genre: string | undefined,
  page: string | undefined,
): SearchQuery {
  return makeQuery(q ?? "", genre ?? "", Number(page) || 1);
}

/**
 * The cache key, and the identity used to decide whether anything changed.
 * `|` cannot appear in a genre slug and is harmless inside a keyword — two
 * different queries that collide here would have to differ only in where the
 * bar falls, which no pair of (keyword, genre, page) can.
 */
export function queryKey(query: SearchQuery): string {
  return `${query.q}|${query.genre}|${query.page}`;
}

export function sameQuery(a: SearchQuery, b: SearchQuery): boolean {
  return queryKey(a) === queryKey(b);
}

/**
 * True when the keyword and the genre agree, whatever page each is on.
 *
 * The distinction from sameQuery is load-bearing. The debounce asks "have the
 * controls moved away from what is on screen?", and the controls cannot
 * express a page — so asking it with sameQuery made every page-2 view differ
 * from the page-1 query the input implies, and scheduled a run that put the
 * reader back on page 1 a second after they turned the page.
 */
export function sameTerms(a: SearchQuery, b: SearchQuery): boolean {
  return a.q === b.q && a.genre === b.genre;
}

/**
 * False when there is nothing to ask for. go-api answers 400 to a request
 * with neither a keyword nor a genre, so this is the guard that keeps the
 * empty input from ever producing one.
 */
export function hasTerms(query: SearchQuery): boolean {
  return query.q !== "" || query.genre !== "";
}

/** The reader-facing URL, with empty params dropped so no "?q=&genre=" ships. */
export function searchPath(query: SearchQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.genre) params.set("genre", query.genre);
  if (query.page > 1) params.set("page", String(query.page));
  const qs = params.toString();
  return qs ? `/search?${qs}` : "/search";
}

/**
 * The go-api URL. `page` is always sent — unlike searchPath, which omits it
 * at 1 to keep the shareable URL clean, this one has no reader to please and
 * an explicit value is one fewer default to keep in sync with the Go side.
 */
export function searchApiPath(query: SearchQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.genre) params.set("genre", query.genre);
  params.set("page", String(query.page));
  return `/api/anime/search?${params.toString()}`;
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Unwrap `{data, pagination}` into a SearchResultSet, or null when the body is
 * not that shape.
 *
 * Null rather than a throw because both callers already have an error path and
 * neither wants a stack: the server logs and renders the rest of the page, the
 * client shows the load error under the still-usable input. Note the envelope
 * here is NOT apiGet's `{data:T}` or apiGetPaged's `{data,total,page,…}` —
 * /search has its own, see searchResponse in go-api/internal/anime/search.go.
 */
export function parseSearchResponse(body: unknown): SearchResultSet | null {
  if (!body || typeof body !== "object") return null;
  const envelope = body as { data?: unknown; pagination?: unknown };
  if (!Array.isArray(envelope.data)) return null;
  const rows = envelope.data as SearchRow[];

  const p = (envelope.pagination ?? {}) as Record<string, unknown>;
  const perPage = asNumber(p.perPage, rows.length);
  const total = asNumber(p.total, rows.length);
  // Derived rather than trusted when absent: a missing totalPages that
  // defaulted to 0 would hide the pagination controls on a real multi-page
  // result, which reads as "there is no more" — the one wrong answer here
  // that a reader cannot tell from the truth.
  const totalPages = asNumber(
    p.totalPages,
    perPage > 0 ? Math.ceil(total / perPage) : 0,
  );
  return {
    rows,
    page: asNumber(p.page, 1),
    perPage,
    total,
    totalPages,
  };
}

/**
 * The message inside an error envelope, for the line shown under the input.
 * Falls back to the status because go-api's 502/503/504 bodies are the ones a
 * reader is most likely to hit and the least likely to carry useful prose.
 */
export function errorFromResponse(body: unknown, status: number): string {
  const err = (body as { error?: { message?: unknown } } | null)?.error;
  const message = err?.message;
  return typeof message === "string" && message ? message : `HTTP ${status}`;
}
