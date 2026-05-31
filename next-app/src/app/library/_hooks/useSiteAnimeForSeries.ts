"use client";

// Ported from client/src/hooks/useSiteAnimeForSeries.js. Fetches siteAnime
// (rich AniList metadata: score, format, season, studios, genres, etc.)
// for a library Series by re-searching dandanplay's AnimeCache-backed
// endpoint with the series title. Module-scoped cache so revisiting the
// same series within one session skips the network round-trip.

import { useEffect, useState } from "react";
// P6 TODO: tighten when useLibrary gets typed exports
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SeriesRecord = any;

interface SearchHit {
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

interface SearchResponse {
  results?: SearchHit[];
}

export interface SiteAnimeMapped {
  anilistId?: number;
  titleChinese?: string;
  titleNative?: string;
  titleRomaji?: string;
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
  source?: string;
  duration?: number;
}

const _cache = new Map<string, SiteAnimeMapped | null>();

function scoreMatch(hit: SearchHit, target: string): number {
  const t = target.toLowerCase();
  const candidates = [
    hit.titleChinese,
    hit.titleNative,
    hit.titleRomaji,
    hit.title,
  ]
    .filter(Boolean)
    .map((s) => (s as string).toLowerCase());
  if (candidates.includes(t)) return 100;
  for (const c of candidates) {
    if (c.includes(t) || t.includes(c)) return 50;
  }
  return 0;
}

async function searchAnime(keyword: string): Promise<SearchResponse | null> {
  const url = `/api/dandanplay/search?keyword=${encodeURIComponent(keyword)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`searchAnime: HTTP ${res.status}`);
  return (await res.json()) as SearchResponse;
}

export interface UseSiteAnimeResult {
  data: SiteAnimeMapped | null;
  loading: boolean;
}

export function useSiteAnimeForSeries({
  series,
}: {
  series: SeriesRecord | null | undefined;
}): UseSiteAnimeResult {
  const [siteAnime, setSiteAnime] = useState<SiteAnimeMapped | null>(null);
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

    const keyword = series.titleZh || series.titleEn || series.titleJa || "";
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
        const hits = (data?.results ?? []).filter(
          (r) => r.source === "animeCache",
        );
        if (!hits.length) {
          _cache.set(series.id, null);
          setSiteAnime(null);
          setLoading(false);
          return;
        }
        let best = hits[0];
        let bestScore = scoreMatch(best, keyword);
        for (const h of hits.slice(1)) {
          const s = scoreMatch(h, keyword);
          if (s > bestScore) {
            best = h;
            bestScore = s;
          }
        }
        const mapped: SiteAnimeMapped = {
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
        // eslint-disable-next-line no-console
        console.warn(
          "[useSiteAnimeForSeries] search failed:",
          err instanceof Error ? err.message : err,
        );
        _cache.set(series.id, null);
        setSiteAnime(null);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [series?.id, series?.titleZh, series?.titleEn, series?.titleJa]);

  return { data: siteAnime, loading };
}
