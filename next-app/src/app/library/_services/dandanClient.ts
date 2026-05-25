"use client";
// @ts-check
// Real dandanplay client adapter wrapping the high-level matchAnime endpoint.
// Provides the `{ match(hash16M, fileName, opts?) }` shape that importPipeline
// and refreshSeriesMetadata expect. The high-level endpoint returns Chinese /
// Romaji titles plus coverImageUrl in a single call — we forward those as
// `enrichment` so callers can patch Series.titleZh / titleEn / posterUrl in
// place of the anitomy-derived parsedTitle (which often picks up fansub group
// names).
//
// Server contract notes (server/controllers/dandanplay.controller.js):
//   - Body MUST include a non-empty `episodes` array AND a matching
//     `files[].episode` field, because the server only returns matched:true
//     when buildEpisodeMap produces at least one entry. We send `episodes:[1]`
//     plus `files[0].episode=1` as a placeholder — index-based fallback in
//     buildEpisodeMap means this lands on the first regular episode regardless
//     of actual numbering. Without this, every refresh call returns
//     matched:false and the user sees nothing change.
//   - Phase 1 (hash/filename hit) returns titleChinese ONLY in `siteAnime`
//     (sourced from AnimeCache via anilist). Phase 2 (animeCache search) puts
//     them in `anime`. We merge both so refresh works in either path.
//
// Next-app port: legacy used `axios.post('/dandanplay/match')` with axios
// baseURL `/api`. In next-app we hit `/api/dandanplay/match` directly via
// fetch. Browser-side requests are same-origin; nginx proxies to Express.

export interface DandanEnrichment {
  titleZh?: string;
  titleEn?: string;
  posterUrl?: string;
}

export interface DandanMatchResult {
  isMatched: boolean;
  animes: Array<{ animeId: number; animeTitle: string }>;
  enrichment?: DandanEnrichment;
}

export interface DandanClient {
  match(
    hash16M: string,
    fileName: string,
    opts?: { fileSize?: number },
  ): Promise<DandanMatchResult | null>;
}

interface MatchAnimeResponse {
  matched?: boolean;
  anime?: Record<string, unknown> | null;
  siteAnime?: Record<string, unknown> | null;
  [key: string]: unknown;
}

async function matchAnime(body: unknown): Promise<MatchAnimeResponse | null> {
  // Same-origin fetch from the client. nginx in prod and the next.config.ts
  // rewrites in dev both forward `/api/*` to the Express upstream.
  const res = await fetch("/api/dandanplay/match", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`matchAnime: HTTP ${res.status}`);
  }
  return (await res.json()) as MatchAnimeResponse;
}

/**
 * Build a dandan client backed by the backend matchAnime endpoint.
 *
 * Network or auth failures swallow to `null` so a missing proxy never bricks
 * the import — the user still gets fileRefs + episodes via the local matcher,
 * just without the dandan-derived title and poster.
 */
export function createDandanClient(): DandanClient {
  return {
    async match(hash16M, fileName, opts = {}) {
      if (!hash16M || !fileName) return null;
      const fileSize = opts.fileSize ?? 0;
      try {
        const body = {
          fileName,
          fileHash: hash16M,
          fileSize,
          episodes: [1],
          files: [{ fileName, fileHash: hash16M, fileSize, episode: 1 }],
        };
        const result = await matchAnime(body);
        if (!result?.matched) return null;

        const merged = mergeAnimeFields(result.anime, result.siteAnime);
        const animeId = Number(
          merged.dandanAnimeId ?? merged.animeId ?? merged.bgmId ?? 0,
        );
        const animeTitle =
          merged.titleChinese ||
          merged.titleNative ||
          merged.titleRomaji ||
          fileName;
        const enrichment = pickEnrichment(merged);
        return {
          isMatched: true,
          animes: [{ animeId, animeTitle }],
          ...(enrichment ? { enrichment } : {}),
        } as DandanMatchResult;
      } catch (err) {
        // Don't fully swallow — callers tolerate null, but surfacing the cause
        // in the console makes diagnostic mismatches (proxy down, wrong path,
        // malformed hash) findable instead of silent.
        // eslint-disable-next-line no-console
        console.warn(
          "[dandan] match failed:",
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    },
  };
}

/**
 * Merge `anime` and `siteAnime` fields preferring whichever populates a given
 * key first. Phase 1 puts titles in siteAnime, Phase 2 puts them in anime —
 * caller doesn't care which path matched, only that the fields are present.
 */
function mergeAnimeFields(
  anime: Record<string, unknown> | null | undefined,
  siteAnime: Record<string, unknown> | null | undefined,
) {
  const a = (anime ?? {}) as Record<string, unknown>;
  const s = (siteAnime ?? {}) as Record<string, unknown>;
  return {
    titleChinese: (a.titleChinese as string) || (s.titleChinese as string),
    titleRomaji: (a.titleRomaji as string) || (s.titleRomaji as string),
    titleNative: (a.titleNative as string) || (s.titleNative as string),
    coverImageUrl: (a.coverImageUrl as string) || (s.coverImageUrl as string),
    dandanAnimeId: a.dandanAnimeId as number | undefined,
    animeId: a.animeId as number | undefined,
    bgmId: (a.bgmId as number) || (s.bgmId as number),
    anilistId: (a.anilistId as number) || (s.anilistId as number),
  };
}

/**
 * Subset of merged anime fields persisted onto the Series record. Returns
 * undefined when nothing useful is present so the caller can short-circuit.
 */
function pickEnrichment(merged: {
  titleChinese?: string;
  titleRomaji?: string;
  titleNative?: string;
  coverImageUrl?: string;
}): DandanEnrichment | undefined {
  const out: DandanEnrichment = {};
  if (merged.titleChinese) out.titleZh = merged.titleChinese;
  if (merged.titleRomaji) out.titleEn = merged.titleRomaji;
  else if (merged.titleNative) out.titleEn = merged.titleNative;
  if (merged.coverImageUrl) out.posterUrl = merged.coverImageUrl;
  return Object.keys(out).length ? out : undefined;
}
