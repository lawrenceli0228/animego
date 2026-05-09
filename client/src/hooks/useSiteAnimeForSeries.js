// @ts-check
import { useEffect, useState } from 'react';
import { searchAnime } from '../api/dandanplay.api';

/**
 * Module-scoped cache so revisiting the same series within one session skips
 * the network round-trip. Keyed by the series id (stable across navigations).
 * @type {Map<string, any>}
 */
const _cache = new Map();

/**
 * Score a search result against a target title — higher is better. Exact
 * Chinese / Romaji match wins; otherwise we accept partial substring overlap
 * so fansub-suffixed results still bind to the right anime.
 *
 * @param {{ titleChinese?: string, titleNative?: string, titleRomaji?: string, title?: string }} hit
 * @param {string} target
 */
function scoreMatch(hit, target) {
  const t = target.toLowerCase();
  const candidates = [hit.titleChinese, hit.titleNative, hit.titleRomaji, hit.title]
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  if (candidates.includes(t)) return 100;
  for (const c of candidates) {
    if (c.includes(t) || t.includes(c)) return 50;
  }
  return 0;
}

/**
 * Fetch siteAnime (rich AniList metadata: score, format, season, studios,
 * genres, etc.) for a library Series by re-searching dandanplay's
 * AnimeCache-backed endpoint with the series title.
 *
 * Returns `{ data, loading }`:
 * - `data`: siteAnime payload (or null if no match / network error)
 * - `loading`: true while the network round-trip is in flight; false when
 *   the result is resolved (or served from the in-session cache)
 *
 * The loading flag lets callers render a skeleton during the ~hundreds-of-ms
 * first-fetch window instead of flashing the bare layout.
 *
 * @param {{ series: import('../lib/library/types').Series | null | undefined }} options
 * @returns {{ data: any | null, loading: boolean }}
 */
export default function useSiteAnimeForSeries({ series }) {
  const [siteAnime, setSiteAnime] = useState(/** @type {any|null} */ (null));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!series?.id) {
      setSiteAnime(null);
      setLoading(false);
      return undefined;
    }
    const cached = _cache.get(series.id);
    if (cached !== undefined) {
      setSiteAnime(cached);
      setLoading(false);
      return undefined;
    }

    const keyword = series.titleZh || series.titleEn || series.titleJa || '';
    if (!keyword) {
      setSiteAnime(null);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setSiteAnime(null);
    (async () => {
      try {
        const data = await searchAnime(keyword);
        if (cancelled) return;
        const hits = (data?.results ?? []).filter((r) => r.source === 'animeCache');
        if (!hits.length) {
          _cache.set(series.id, null);
          setSiteAnime(null);
          setLoading(false);
          return;
        }
        // Pick the highest-scoring hit (preferring exact match on the series's
        // primary title). Fall back to the first hit when nothing scores >0.
        let best = hits[0];
        let bestScore = scoreMatch(best, keyword);
        for (const h of hits.slice(1)) {
          const s = scoreMatch(h, keyword);
          if (s > bestScore) { best = h; bestScore = s; }
        }
        // Map searchAnime's animeCache result into siteAnime shape (matches
        // pickSiteAnime in dandanplay.controller.js so EpisodeFileList renders
        // the same fields the post-match drop-zone flow gets).
        const mapped = {
          anilistId: best.anilistId,
          titleChinese: best.titleChinese,
          titleNative: best.titleNative,
          titleRomaji: best.titleRomaji,
          coverImageUrl: best.coverImageUrl,
          episodes: best.episodes,
          status: best.status,
          season: best.season,
          seasonYear: best.seasonYear,
          averageScore: best.averageScore,
          bangumiScore: best.bangumiScore,
          bangumiVotes: best.bangumiVotes,
          genres: best.genres,
          format: best.format,
          bgmId: best.bgmId,
          studios: best.studios,
          source: best.animeSource,
          duration: best.duration,
        };
        _cache.set(series.id, mapped);
        setSiteAnime(mapped);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        console.warn('[useSiteAnimeForSeries] search failed:', err?.message || err);
        _cache.set(series.id, null);
        setSiteAnime(null);
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [series?.id, series?.titleZh, series?.titleEn, series?.titleJa]);

  return { data: siteAnime, loading };
}
