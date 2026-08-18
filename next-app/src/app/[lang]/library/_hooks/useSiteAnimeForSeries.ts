"use client";

// Ported from client/src/hooks/useSiteAnimeForSeries.js. Fetches siteAnime
// (rich AniList metadata: score, format, season, studios, genres, etc.)
// for a library Series by re-searching dandanplay's AnimeCache-backed
// endpoint with the series title. Module-scoped cache so revisiting the
// same series within one session skips the network round-trip.
//
// This is also the automatic half of anime binding. Two changes from the
// title-search-every-time original:
//
//   1. A stored binding outranks the title match. Taiga does the same thing
//      (`LinkEpisodeToAnime` writes the user's pick as a synonym that ranks
//      ahead of the official titles from then on): once a series is bound, the
//      hit whose anilistId matches wins, and for a manual binding there is no
//      fall back to fuzzy matching at all — an un-enriched card beats quietly
//      showing a different show than the one the user picked.
//   2. A successful match is persisted, via animeBinding and nothing else. That
//      turns a per-session guess into the durable local ↔ AniList key that
//      watch-progress sync needs. `writeBinding` refuses to overwrite a manual
//      binding, so the automatic path physically cannot stomp the user's pick.
//
// The search, the animeCache filter, the hit-picking rule and the binding write
// now live in `_services/resolveSeriesBinding.ts`, because they also have to be
// reachable from a card click and a player entry — this hook mounts on exactly
// one route, so leaving them here meant the main path never bound anything.
// What stayed here is everything this hook needs and the service does not: the
// metadata mapping, the module cache, the loading flag and the cancellation
// guard. The shared parts are called in the same order with the same arguments
// as before, so the behaviour is unchanged.

import { useEffect, useState } from "react";
import type Dexie from "dexie";
import {
  onBindingChanged,
  readBinding,
  type BindingDb,
} from "@/lib/library/animeBinding";
import {
  animeCacheHits,
  persistAutoBinding,
  pickBindingHit,
  searchAnime,
  seriesSearchKeyword,
} from "../_services/resolveSeriesBinding";
// P6 TODO: tighten when useLibrary gets typed exports
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SeriesRecord = any;

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

// The cache stays here — it holds whole metadata objects, which is none of
// animeBinding's business — but it does not get to decide when it is stale.
// A rebind anywhere (this hook, the rematch dialog, later the reconciler)
// drops the entry, so the next mount re-resolves against the new id instead of
// serving a session-old answer for a binding that just changed.
onBindingChanged((seriesId) => {
  _cache.delete(seriesId);
});

export interface UseSiteAnimeResult {
  data: SiteAnimeMapped | null;
  loading: boolean;
}

export function useSiteAnimeForSeries({
  series,
  db,
}: {
  series: SeriesRecord | null | undefined;
  /**
   * The library Dexie handle. Passed in rather than imported: `db.js` throws
   * the moment it is evaluated outside a browser, so a hook that imports it
   * directly becomes a landmine for any future server-rendered caller. Every
   * other library service in this tree (rematchSeries, mergeOps,
   * refreshSeriesMetadata) takes the same parameter with the same type.
   */
  db: Dexie;
}): UseSiteAnimeResult {
  // Dexie's base type declares no table properties — subclassing is how you get
  // them, and this codebase does not subclass. Same narrowing every sibling
  // service does, done once here instead of at each use.
  const bindingDb = db as unknown as BindingDb;
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

    // Spread the three fields explicitly rather than passing `series`: they are
    // what the dependency array lists, and handing the whole object to the
    // helper would make the effect depend on a row identity that changes on
    // every liveQuery emission — a re-search per unrelated library write.
    const keyword = seriesSearchKeyword({
      titleZh: series.titleZh,
      titleEn: series.titleEn,
      titleJa: series.titleJa,
    });
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
        const bound = await readBinding(bindingDb, series.id);
        const data = await searchAnime(keyword);
        if (cancelled) return;
        const hits = animeCacheHits(data);
        // pickBindingHit carries the "a manual binding never falls back to
        // fuzzy matching" rule; an un-enriched card beats a confidently wrong
        // one. See its doc comment.
        const best = pickBindingHit(hits, keyword, bound);
        if (!best) {
          _cache.set(series.id, null);
          setSiteAnime(null);
          setLoading(false);
          return;
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
        // Persist before caching, not after: the write fires the invalidation
        // that clears this very cache, so the other order deletes the entry it
        // just wrote and every mount pays for the round-trip again.
        await persistAutoBinding(bindingDb, series.id, best.anilistId);
        _cache.set(series.id, mapped);
        if (cancelled) return;
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
  }, [bindingDb, series?.id, series?.titleZh, series?.titleEn, series?.titleJa]);

  return { data: siteAnime, loading };
}
