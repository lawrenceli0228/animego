// Resolving `Series.anilistId` on demand — the shared half of what used to
// live only inside `useSiteAnimeForSeries`.
//
// WHY THIS IS A SERVICE AND NOT A HOOK
//
// The binding is the load-bearing key for watch-progress sync, but until this
// module existed the only thing that could create one was a React hook mounted
// on exactly one route (`/library/[seriesId]`, via LocalSeriesShell). Clicking
// a card in the grid opens SeriesDetailSheet, which never runs it; the resume
// row and the new-additions row jump straight to `/player`. So the main path
// through the product never bound anything, `startTracking` had no id to post,
// and the whole pipeline no-opped. Resolution has to be reachable from the
// moment the user expresses intent, not from one component's lifecycle.
//
// TWO CONSUMERS, TWO DIFFERENT NEEDS
//
//   The metadata hook needs the whole search hit (score, format, studios…), so
//   it searches every time, binding or not.
//
//   The sync callers need one integer. An existing binding answers them without
//   touching the network at all, and that difference is the entire reason
//   `resolveSeriesBinding` takes the "skip the search when already bound" path
//   while the hook does not.
//
// Both are built from the same three primitives below, so the parts that must
// not drift — which hit wins, and what a manual binding means — are literally
// one function.
//
// WHY ONLY TWO CALLERS MAY USE THIS (and the reconciler may not)
//
// A resolve is a title search against `/api/dandanplay/search`. Single, bounded
// and user-initiated is fine: one card click, one player entry. Sweeping a
// library on mount is not — a few hundred unbound series would become a few
// hundred simultaneous searches for a page the user only wanted to look at.
// `reconcileLibrary` therefore skips unbound series and lets the card note
// explain itself. The same rule is restated in `watchSync.ts`.

import { pickBestHit } from "@/lib/seasonMatch";
import {
  readBinding,
  writeBinding,
  type AnimeBinding,
  type BindingDb,
} from "@/lib/library/animeBinding";

/** One row of `/api/dandanplay/search`. */
export interface SeriesSearchHit {
  source?: string;
  animeSource?: string;
  titleChinese?: string;
  titleNative?: string;
  titleRomaji?: string;
  title?: string;
  anilistId?: number;
  coverImageUrl?: string;
  episodes?: number;
  status?: string;
  season?: string;
  seasonYear?: number;
  averageScore?: number;
  bangumiScore?: number;
  bangumiVotes?: number;
  genres?: string[];
  format?: string;
  bgmId?: number;
  studios?: string[];
  duration?: number;
}

export interface SeriesSearchResponse {
  results?: SeriesSearchHit[];
}

/** The `Series` fields this module reads. */
export interface BindableSeriesRow {
  id?: string;
  titleZh?: string;
  titleEn?: string;
  titleJa?: string;
}

/** Injectable so tests never touch the network. */
export type SeriesSearchFn = (keyword: string) => Promise<SeriesSearchResponse | null>;

// ─── primitives (shared by the hook and by resolveSeriesBinding) ────────────

/**
 * The title the search runs on. Same fallback order the hook has always used;
 * an empty string means there is nothing to search with.
 */
export function seriesSearchKeyword(
  series: BindableSeriesRow | null | undefined,
): string {
  return series?.titleZh || series?.titleEn || series?.titleJa || "";
}

/** Throws on a non-2xx, so callers decide what a failed search means. */
export async function searchAnime(
  keyword: string,
): Promise<SeriesSearchResponse | null> {
  const url = `/api/dandanplay/search?keyword=${encodeURIComponent(keyword)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`searchAnime: HTTP ${res.status}`);
  return (await res.json()) as SeriesSearchResponse;
}

/**
 * Keep only rows backed by our own anime cache — those are the ones that carry
 * an `anilistId` and that `/api/subscriptions` can accept.
 */
export function animeCacheHits(
  response: SeriesSearchResponse | null | undefined,
): SeriesSearchHit[] {
  return (response?.results ?? []).filter((r) => r?.source === "animeCache");
}

/**
 * Resolve which search hit this series is about.
 *
 * A stored binding is an answer we already have; the title search is a guess.
 * So the binding is consulted first, and a *manual* binding that this search
 * cannot see (title drifted, the row is not in animeCache) resolves to nothing
 * rather than falling back to the guess — showing a different show than the one
 * the user explicitly picked is worse than showing an un-enriched card. An
 * `auto` binding carries no such promise, so it re-derives.
 *
 * This is Taiga's `LinkEpisodeToAnime` rule (`anime_util.cpp:220-241`), where a
 * manual link becomes a synonym that outranks the official titles from then on.
 * Moved here verbatim from useSiteAnimeForSeries; do not "simplify" either
 * branch.
 */
export function pickBindingHit(
  hits: readonly SeriesSearchHit[],
  keyword: string,
  bound: AnimeBinding | null,
): SeriesSearchHit | null {
  if (bound) {
    const exact = hits.find((h) => h.anilistId === bound.anilistId);
    if (exact) return exact;
    if (bound.source === "manual") return null;
  }
  // No blind hits[0] fallback. The search is a title ILIKE, so for a franchise
  // it returns every season and the first row is arbitrary — taking it put
  // season 2's score and details link on a season 3 card. pickBestHit requires
  // the season/part ordinals to agree and returns null when none does.
  return pickBestHit(hits, keyword);
}

/**
 * Best-effort persist of an automatic match. Failing to store the binding must
 * not cost the caller the metadata that was just fetched successfully — the
 * next attempt re-derives and retries.
 */
export async function persistAutoBinding(
  db: BindingDb,
  seriesId: string,
  anilistId: number | undefined,
): Promise<void> {
  if (anilistId === undefined) return;
  try {
    // 'auto' — writeBinding refuses this outright when the user owns the
    // binding, which is the guarantee that makes it safe to call every time.
    await writeBinding(db, seriesId, anilistId, "auto");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[resolveSeriesBinding] binding write failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ─── on-demand resolution ───────────────────────────────────────────────────

export type BindingOutcome =
  /** Already bound; no search ran. */
  | "existing"
  /** Searched, matched, and wrote the binding. */
  | "resolved"
  /** No usable id: no title, no match, or the search failed. */
  | "none";

export interface SeriesBindingResult {
  readonly anilistId: number | null;
  readonly outcome: BindingOutcome;
  /** The winning hit, when a search actually ran. */
  readonly hit: SeriesSearchHit | null;
}

const NONE: SeriesBindingResult = { anilistId: null, outcome: "none", hit: null };

/**
 * Series we have already searched for, unsuccessfully, this session.
 *
 * Without it, a series whose title matches nothing re-searches on every card
 * click and every player entry. The failure is a property of the title, so one
 * answer per session is enough. A successful bind does not need an entry: the
 * stored binding short-circuits everything above the search.
 */
const _unresolved = new Set<string>();

/** Test seam. */
export function resetSeriesBindingCache(): void {
  _unresolved.clear();
}

export interface ResolveBindingOptions {
  /** Injected in tests; defaults to the real endpoint. */
  readonly search?: SeriesSearchFn;
  /**
   * Search again even when a binding already exists, because the caller wants
   * the metadata rather than the id. Only the enrichment hook sets this.
   */
  readonly force?: boolean;
}

/**
 * The id for a series, resolving it on demand if it has none.
 *
 * NEVER THROWS. Every caller is a fire-and-forget path hanging off a click or a
 * navigation, and none of them has anywhere to put an exception: a search that
 * 500s must degrade to "not bound yet", not to an unhandled rejection over a
 * playing video.
 */
export async function resolveSeriesBinding(
  db: BindingDb,
  series: BindableSeriesRow | null | undefined,
  opts: ResolveBindingOptions = {},
): Promise<SeriesBindingResult> {
  const seriesId = series?.id;
  if (!seriesId) return NONE;

  let bound: AnimeBinding | null = null;
  try {
    bound = await readBinding(db, seriesId);
  } catch {
    // An unreadable Dexie is not a reason to go and guess a binding.
    return NONE;
  }

  // The whole point of the non-forced path: an answer we already have costs
  // nothing, and the sync callers only ever wanted the integer.
  if (bound && !opts.force) {
    return { anilistId: bound.anilistId, outcome: "existing", hit: null };
  }
  if (!bound && _unresolved.has(seriesId)) return NONE;

  const keyword = seriesSearchKeyword(series);
  if (!keyword) {
    return bound
      ? { anilistId: bound.anilistId, outcome: "existing", hit: null }
      : NONE;
  }

  const search = opts.search ?? searchAnime;
  let hits: SeriesSearchHit[];
  try {
    hits = animeCacheHits(await search(keyword));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[resolveSeriesBinding] search failed:",
      err instanceof Error ? err.message : err,
    );
    // Deliberately NOT remembered as unresolved: a network failure is not an
    // answer about this title, and latching it would disable resolution for the
    // session over one dropped request.
    return bound
      ? { anilistId: bound.anilistId, outcome: "existing", hit: null }
      : NONE;
  }

  const best = pickBindingHit(hits, keyword, bound);
  const anilistId = best?.anilistId;
  if (best === null || anilistId === undefined) {
    if (!bound) _unresolved.add(seriesId);
    return bound
      ? { anilistId: bound.anilistId, outcome: "existing", hit: null }
      : NONE;
  }

  await persistAutoBinding(db, seriesId, anilistId);
  return {
    anilistId,
    outcome: bound ? "existing" : "resolved",
    hit: best,
  };
}

/**
 * `BindingDb` with the series row widened to the title fields the search needs.
 * Structural, like every other db type in this tree, so the Dexie handle is
 * narrowed once at the call site instead of at each use.
 */
export interface BindingResolverDb {
  series: {
    get(
      id: string,
    ): Promise<(BindableSeriesRow & { anilistId?: number | null }) | undefined>;
    update(id: string, changes: Record<string, unknown>): Promise<unknown>;
  };
  userOverride?: {
    get(id: string): Promise<{ locked?: boolean } | undefined>;
    put(row: Record<string, unknown>): Promise<unknown>;
  } | null;
}

/**
 * Adapter for `watchSync`'s `resolveBinding` seam: series id in, AniList id out.
 *
 * It lives here rather than in `lib/library/watchSync.ts` so the sync module
 * keeps no dependency on the app layer, and so the "which callers are allowed
 * to resolve" decision stays in one file with its rationale.
 */
export function makeBindingResolver(
  db: BindingResolverDb,
  opts: ResolveBindingOptions = {},
): (seriesId: string) => Promise<number | null> {
  return async (seriesId: string) => {
    try {
      const series = await db.series.get(seriesId);
      if (!series) return null;
      const result = await resolveSeriesBinding(db, { ...series, id: seriesId }, opts);
      return result.anilistId;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[resolveSeriesBinding] resolver failed:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  };
}
