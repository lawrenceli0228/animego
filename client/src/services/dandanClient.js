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

import { matchAnime } from '../api/dandanplay.api';

/**
 * @typedef {Object} DandanEnrichment
 * @property {string} [titleZh]
 * @property {string} [titleEn]
 * @property {string} [posterUrl]
 *
 * @typedef {Object} DandanMatchResult
 * @property {boolean} isMatched
 * @property {Array<{ animeId: number, animeTitle: string }>} animes
 * @property {DandanEnrichment} [enrichment]
 *
 * @typedef {{ match(hash16M: string, fileName: string, opts?: { fileSize?: number }): Promise<DandanMatchResult|null> }} DandanClient
 */

/**
 * Build a dandan client backed by the backend matchAnime endpoint.
 *
 * Network or auth failures swallow to `null` so a missing proxy never bricks
 * the import — the user still gets fileRefs + episodes via the local matcher,
 * just without the dandan-derived title and poster.
 *
 * @returns {DandanClient}
 */
export function createDandanClient() {
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
        return /** @type {DandanMatchResult} */ ({
          isMatched: true,
          animes: [{ animeId, animeTitle }],
          ...(enrichment ? { enrichment } : {}),
        });
      } catch (err) {
        // Don't fully swallow — callers tolerate null, but surfacing the cause
        // in the console makes diagnostic mismatches (proxy down, wrong path,
        // malformed hash) findable instead of silent.
        console.warn('[dandan] match failed:', err?.message || err);
        return null;
      }
    },
  };
}

/**
 * Merge `anime` and `siteAnime` fields preferring whichever populates a given
 * key first. Phase 1 puts titles in siteAnime, Phase 2 puts them in anime —
 * caller doesn't care which path matched, only that the fields are present.
 *
 * @param {Record<string, any>|undefined|null} anime
 * @param {Record<string, any>|undefined|null} siteAnime
 */
function mergeAnimeFields(anime, siteAnime) {
  const a = anime ?? {};
  const s = siteAnime ?? {};
  return {
    titleChinese: a.titleChinese || s.titleChinese,
    titleRomaji: a.titleRomaji || s.titleRomaji,
    titleNative: a.titleNative || s.titleNative,
    coverImageUrl: a.coverImageUrl || s.coverImageUrl,
    dandanAnimeId: a.dandanAnimeId,
    animeId: a.animeId,
    bgmId: a.bgmId || s.bgmId,
    anilistId: a.anilistId || s.anilistId,
  };
}

/**
 * Subset of merged anime fields persisted onto the Series record. Returns
 * undefined when nothing useful is present so the caller can short-circuit.
 *
 * @param {{ titleChinese?: string, titleRomaji?: string, titleNative?: string, coverImageUrl?: string }} merged
 * @returns {DandanEnrichment|undefined}
 */
function pickEnrichment(merged) {
  /** @type {DandanEnrichment} */
  const out = {};
  if (merged.titleChinese) out.titleZh = merged.titleChinese;
  if (merged.titleRomaji) out.titleEn = merged.titleRomaji;
  else if (merged.titleNative) out.titleEn = merged.titleNative;
  if (merged.coverImageUrl) out.posterUrl = merged.coverImageUrl;
  return Object.keys(out).length ? out : undefined;
}
