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
// Server contract notes (go-api/internal/dandanplay/match.go, which is where
// the retired server/controllers/dandanplay.controller.js was ported to):
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
// fetch. Browser-side requests are same-origin; in production nginx proxies
// `/api/*` to go-api, and in dev `next.config.ts`'s rewrite does the same to
// localhost:8080. (The Express hop this line used to name retired with the
// rest of that stack on 2026-06-01.)

export interface DandanEnrichment {
  titleZh?: string;
  titleEn?: string;
  posterUrl?: string;
  /**
   * AniList's episode count for the matched entry, when the response carried
   * one. Lands on `Series.totalEpisodes`.
   *
   * Only the authoritative `episodes` is available here: the /match envelope
   * projects `siteAnime` (all three phases) and `anime` (phase 2 only) out of
   * the anime_cache row and neither projection includes `episodes_bgm`. The
   * inferred count exists solely on `GET /api/anime/episodes`, so the
   * "episodes → episodesBgm" fallback only has anything to fall back to in
   * `episodeCountBackfill.ts`.
   */
  totalEpisodes?: number;
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
        // dandanplay id space, and only dandanplay id space. This number
        // becomes `Season.animeId` (types.js: "dandanplay 每季独立 animeId"),
        // which is what season reuse and danmaku lookups key on.
        //
        // This chain used to end in `?? merged.bgmId`, and that was not a
        // fallback — it was the only branch that ever fired. `/match` emits no
        // dandanplay animeId in ANY phase (match.go: `phase1Anime` is
        // titleNative + coverImageUrl, `phase2Anime` is anilistId + titles +
        // episodes, phase 3 is a literal `{}`), so both preceding terms are
        // permanently undefined and every matched import wrote a bgm.tv
        // subject id into a dandanplay field. Same bug class the manual
        // rematch path already fixed — `rematchPayload.ts` documents the cost.
        //
        // Nothing downstream can detect or repair the substitution: the two
        // spaces collide numerically (806 is a live id in both and resolves to
        // two unrelated shows), so no range check separates them.
        //
        // 0 is strictly safer than a wrong id, because the pipeline's guards
        // are gated on FALSINESS, not on validity. `importPipeline.js:319`
        // re-enables the folder-home and title-home heuristics when
        // `seasonRecord.animeId` is falsy; a plausible-but-foreign id disables
        // them silently, then fails `findReusableSeason` (:214) on the next
        // import and mints a duplicate card for content already in the
        // library. Empty degrades into the structural fallbacks. Wrong does
        // not degrade at all — it just reads as answered.
        //
        // Phase 1 does hold the real value (`combined.AnimeID`, match.go:186 —
        // fetched, used, then dropped). Emitting it is a go-api change; until
        // then this is 0 and the guards do the work.
        const animeId = Number(merged.dandanAnimeId ?? merged.animeId ?? 0);
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
    // bgm.tv and AniList ids. Neither is a substitute for `dandanAnimeId` —
    // see the id-space note in `match()` above. They are carried for
    // identification (the phase-2 envelope is the only place an import ever
    // sees an anilistId), never for `Season.animeId`.
    bgmId: (a.bgmId as number) || (s.bgmId as number),
    anilistId: (a.anilistId as number) || (s.anilistId as number),
    // siteAnime first, against the `anime`-first rule the other fields follow.
    // Phase 1's `anime` projection is two fields (titleNative + coverImageUrl)
    // and has no episode count at all, so siteAnime is the only source that
    // exists in every phase that produces one. In phase 2 both are projected
    // from the same anime_cache row, so the order costs nothing there.
    episodes: (s.episodes as number) || (a.episodes as number),
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
  episodes?: number;
}): DandanEnrichment | undefined {
  const out: DandanEnrichment = {};
  if (merged.titleChinese) out.titleZh = merged.titleChinese;
  if (merged.titleRomaji) out.titleEn = merged.titleRomaji;
  else if (merged.titleNative) out.titleEn = merged.titleNative;
  if (merged.coverImageUrl) out.posterUrl = merged.coverImageUrl;
  // Positive integers only. A 0 or a null from the cache means "unknown", and
  // every reader of `Series.totalEpisodes` already spells unknown as `<= 0`.
  if (Number.isInteger(merged.episodes) && (merged.episodes as number) > 0) {
    out.totalEpisodes = merged.episodes;
  }
  return Object.keys(out).length ? out : undefined;
}
