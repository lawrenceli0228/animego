// The two requests the magnet panel makes, and how their answers are read.
//
// Pure: no React, no DOM, no fetch.

import { readEpisodeOffset } from "@/lib/library/episodeOffset";

/**
 * The torrents request for the panel's two modes:
 *   - manualQ === null   → by anilistId: go-api searches every title the
 *     anime has, plus the id-keyed feeds, then dedups and sorts.
 *   - manualQ is a string → that keyword (a title button or the search box).
 * An empty or blank keyword is no request (skip).
 *
 * cacheKey namespaces the modes (`id:7` vs `q:7`) so an id answer and a
 * keyword answer never share a cache slot.
 */
export function buildTorrentRequest(
  anilistId: number,
  manualQ: string | null,
): { skip: boolean; path: string; cacheKey: string } {
  if (manualQ === null) {
    return {
      skip: false,
      path: `/api/anime/torrents?anilistId=${anilistId}`,
      cacheKey: `id:${anilistId}`,
    };
  }
  const term = manualQ.trim();
  if (!term) return { skip: true, path: "", cacheKey: "" };
  return {
    skip: false,
    path: `/api/anime/torrents?q=${encodeURIComponent(term)}`,
    cacheKey: `q:${term.toLowerCase()}`,
  };
}

export function episodeOffsetPath(anilistId: number): string {
  return `/api/anime/${anilistId}/episode-offset`;
}

/**
 * The offset from an episode-offset answer (`{data: {known, offset}}`), or
 * undefined. `known` is read before the number: an unknown offset is not 0.
 */
export function readOffsetAnswer(body: unknown): number | undefined {
  const envelope = body as { data?: unknown } | null;
  const data = (envelope && typeof envelope === "object" && "data" in envelope ? envelope.data : body) as {
    known?: unknown;
    offset?: unknown;
  } | null;
  if (!data || typeof data !== "object" || data.known !== true) return undefined;
  return readEpisodeOffset(data.offset);
}
