// The reads every /anime/[id] tab makes, in one place so the three pages make
// them the same way.
//
// All of them are anonymous (`auth: false`) and ISR-cached for the pages'
// own 60s window: these routes are served from the ISR cache and a
// Cloudflare edge cache, so nothing here may read cookies() or headers().
// Next memoises identical fetches within one render, so generateMetadata
// and the page asking for the same thing cost one request.

import { ApiError, apiGet, apiGetEnvelope } from "@/lib/api";
import { LOCALES } from "@/lib/i18n/locale";
import type {
  AnimeDetail,
  CharactersResponse,
  CreditCounts,
  StaffResponse,
} from "@/lib/types";

const READ = { revalidate: 60, auth: false } as const;

/**
 * The query-string suffix that ties a credits read to one detail snapshot.
 *
 * A title a listing wrote (seasonal, search, warm_season) has empty credit
 * tables until its first /api/anime/:id fills them, and Next's data cache
 * keys a fetch by its URL for the 60s window. Read before that fill, the
 * empty answer would be handed back to every render for a minute after it
 * stopped being true. The detail's cachedAt changes whenever the row is
 * written, so a read made after the detail, with its cachedAt in the URL, is
 * a different cache entry from any read made before it. go-api ignores the
 * parameter.
 */
function snapshot(cachedAt: string | null | undefined): string {
  return cachedAt ? `at=${encodeURIComponent(cachedAt)}` : "";
}

function withQuery(path: string, ...parts: string[]): string {
  const query = parts.filter(Boolean).join("&");
  return query ? `${path}?${query}` : path;
}

/** The detail document, or null when go-api says the title does not exist. */
export async function loadDetail(id: number): Promise<AnimeDetail | null> {
  try {
    return await apiGet<AnimeDetail>(`/api/anime/${id}`, READ);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * How many characters and staff a title has, for the tab bar. Null when the
 * catalogue does not hold the title.
 *
 * Unlike /api/anime/:id this endpoint never goes to AniList, which is what
 * lets the 角色 and 制作 tabs decide "no such title" before asking for the
 * detail document — an id nobody has heard of costs a primary-key read, not
 * an upstream call. Called that way, with no `cachedAt`, the answer is for
 * that decision only; the numbers a page shows come from a call made after
 * the detail, with its cachedAt (see `snapshot`).
 */
export async function loadCreditCounts(id: number, cachedAt?: string | null): Promise<CreditCounts | null> {
  try {
    return await apiGet<CreditCounts>(withQuery(`/api/anime/${id}/credit-counts`, snapshot(cachedAt)), READ);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** The counts, or null on any failure: the overview renders without them. */
export async function loadCreditCountsSoft(id: number, cachedAt?: string | null): Promise<CreditCounts | null> {
  try {
    return await loadCreditCounts(id, cachedAt);
  } catch {
    return null;
  }
}

/** A page of characters; `cachedAt` is the detail's, read first (see `snapshot`). */
export async function loadCharacters(
  id: number,
  query: string,
  cachedAt: string | null | undefined,
): Promise<CharactersResponse | null> {
  try {
    return await apiGetEnvelope<CharactersResponse>(
      withQuery(`/api/anime/${id}/characters`, query, snapshot(cachedAt)),
      READ,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** Every staff credit; `cachedAt` is the detail's, read first (see `snapshot`). */
export async function loadStaff(id: number, cachedAt: string | null | undefined): Promise<StaffResponse | null> {
  try {
    return await apiGetEnvelope<StaffResponse>(withQuery(`/api/anime/${id}/staff`, snapshot(cachedAt)), READ);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * The number beside 社区: the tab's reviews, threads and status events as an
 * anonymous reader sees them. Null on any failure — the tab bar then shows
 * 社区 without a number rather than failing the page.
 */
export async function loadCommunityCount(id: number): Promise<number | null> {
  try {
    const { total } = await apiGet<{ total: number }>(`/api/anime/${id}/community/count`, READ);
    return typeof total === "number" ? total : null;
  } catch {
    return null;
  }
}

/**
 * The detail document of a title the catalogue already holds, or null.
 *
 * The tabs other than the overview ask the read-only counts first: an id
 * nobody has heard of then costs a primary-key read and a 404, never a call
 * to AniList (which /api/anime/:id makes for a title it does not hold).
 */
export async function loadKnownDetail(id: number): Promise<AnimeDetail | null> {
  if (!(await loadCreditCounts(id))) return null;
  return loadDetail(id);
}

/** AniList ids are positive int32s; go-api answers 400 for anything else. */
const MAX_ANIME_ID = 2_147_483_647;

/**
 * The path id, or null when it cannot be an AniList id — the page answers
 * that with notFound() before asking go-api anything.
 *
 * Plain decimal digits only. Number() alone would read "1e3" as 1000 and
 * "0154587" as 154587 and render a title under a URL that is not its own.
 */
export function parseAnimeId(raw: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id <= MAX_ANIME_ID ? id : null;
}

/**
 * The ids each tab prerenders at build time: the trending set, in every
 * published locale.
 *
 * A route with its own generateStaticParams supplies EVERY param in its path,
 * `lang` included, so this is the full LOCALES × ids product — half of it
 * would silently prerender one locale and leave the others on demand.
 *
 * MUST NOT fail a build where go-api is unreachable: CI has no backend, so on
 * any error this returns [] and every id renders on its first request
 * (dynamicParams). Do not add a throw path here.
 */
export async function detailStaticParams(): Promise<Array<{ lang: string; id: string }>> {
  let ids: string[];
  try {
    const trending = await apiGet<Array<{ anilistId: number }>>(
      "/api/anime/trending?limit=20",
      { revalidate: 3600, auth: false },
    );
    ids = trending.map((a) => String(a.anilistId));
  } catch {
    return [];
  }
  return LOCALES.flatMap((lang) => ids.map((id) => ({ lang, id })));
}
