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

import {
  NO_DANDAN_ANIME_ID,
  toAnilistId,
  toBgmSubjectId,
  toDandanAnimeId,
  toPositiveInt,
  type AnilistId,
  type DandanAnimeId,
} from "./animeIds";

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
  /**
   * `animeId` is dandanplay id space, and `NO_DANDAN_ANIME_ID` when the
   * envelope proved nothing. The union is the point: there is no third state
   * where the number is present but from somewhere else.
   */
  animes: Array<{ animeId: DandanAnimeId | 0; animeTitle: string }>;
  enrichment?: DandanEnrichment;
  /**
   * The matched entry's AniList id, when the envelope carried one.
   *
   * A THIRD fact, deliberately a sibling of `enrichment` rather than a member
   * of it. Enrichment is display metadata (title, poster, episode count) and is
   * applied whether or not anything identified the content; this is identity,
   * and it lands on `Series.anilistId` through `animeBinding.ts`. Folding it
   * into the blob would re-tie two facts that the import pipeline just finished
   * separating — and would make the binding hinge on whether a poster happened
   * to be present.
   *
   * Sourced from `siteAnime.anilistId`, which go-api emits in BOTH phases that
   * produce a siteAnime at all (`match.go:213` phase 1, `:275` phase 2;
   * `site_anime.go:56` declares the field). Phase 3 emits `siteAnime: null`,
   * so this is absent there.
   */
  anilistId?: AnilistId;
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
        // rematch path already fixed — the shared rule now lives in
        // `animeIds.ts` so there is one statement of it rather than two.
        //
        // Both terms below are `DandanAnimeId | undefined`, so extending the
        // chain with `merged.bgmId` or `merged.anilistId` no longer compiles:
        // the brands do not unify with the annotation on this binding.
        //
        // Phase 1 does hold the real value (`combined.AnimeID`, match.go:186 —
        // fetched, used, then dropped). Emitting it is a go-api change; until
        // then this is `NO_DANDAN_ANIME_ID` and the pipeline's falsiness guards
        // do the work.
        const animeId: DandanAnimeId | 0 =
          merged.dandanAnimeId ?? merged.animeId ?? NO_DANDAN_ANIME_ID;
        const animeTitle =
          merged.titleChinese ||
          merged.titleNative ||
          merged.titleRomaji ||
          fileName;
        const enrichment = pickEnrichment(merged);
        // Annotated, not `as`-cast. The old cast silenced exactly the class of
        // mistake this file exists to prevent — a cast between two branded
        // numbers is not an error, an assignment is.
        const matchResult: DandanMatchResult = {
          isMatched: true,
          animes: [{ animeId, animeTitle }],
          ...(enrichment ? { enrichment } : {}),
          ...(merged.anilistId ? { anilistId: merged.anilistId } : {}),
        };
        return matchResult;
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
    // Every id goes through its own space's normalizer. That is both the
    // untrusted-JSON guard (a null / 0 / "" becomes undefined rather than a
    // stored zero) and the thing that gives each field a brand the compiler
    // will refuse to unify with its neighbours.
    dandanAnimeId: toDandanAnimeId(a.dandanAnimeId),
    animeId: toDandanAnimeId(a.animeId),
    // bgm.tv and AniList ids. Neither is a substitute for `dandanAnimeId` —
    // see the id-space note in `match()` above. `bgmId` is read by nothing and
    // is kept here deliberately: it is the value that poisoned `Season.animeId`
    // in the field, and leaving it typed is what makes a relapse a compile
    // error instead of a silent write nobody can undo.
    bgmId: toBgmSubjectId(a.bgmId) ?? toBgmSubjectId(s.bgmId),
    anilistId: toAnilistId(a.anilistId) ?? toAnilistId(s.anilistId),
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
  // Same `toPositiveInt` the rematch path uses on the same field — this was an
  // open-coded copy of it.
  const totalEpisodes = toPositiveInt(merged.episodes);
  if (totalEpisodes !== undefined) out.totalEpisodes = totalEpisodes;
  return Object.keys(out).length ? out : undefined;
}
