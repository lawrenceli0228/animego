import { useState, useCallback } from 'react';
import { matchAnime, getEpisodes } from '../api/dandanplay.api';
import { buildEpisodeMap } from '../utils/episodeMap';
import useIsMounted from './useIsMounted';

/**
 * Three-tier matching hook.
 * States: idle -> matching -> ready | manual | error
 * Steps:  1=parsing, 2=matching, 3=mapping
 */
export default function useDandanMatch() {
  const [phase, setPhase] = useState('idle'); // idle | matching | ready | manual | error
  const [step, setStep] = useState(0);        // 1,2,3
  const [stepStatus, setStepStatus] = useState({ 1: 'pending', 2: 'pending', 3: 'pending' });
  const [matchResult, setMatchResult] = useState(null);
  const [error, setError] = useState(null);
  const mounted = useIsMounted();

  const startMatch = useCallback(async (keyword, episodes, firstFileName, basicFiles, getFilesHashes) => {
    setPhase('matching');
    setError(null);
    setStep(1);
    setStepStatus({ 1: 'active', 2: 'pending', 3: 'pending' });

    try {
      // Step 1: compute hashes for all files (10s timeout)
      let filesData = null;
      if (getFilesHashes) {
        filesData = await Promise.race([
          getFilesHashes(),
          new Promise(resolve => setTimeout(() => resolve(null), 10000)),
        ]);
      }
      setStepStatus(s => ({ ...s, 1: 'done' }));

      // Step 2: combined matching (all file hashes + keyword in one request)
      setStep(2);
      setStepStatus(s => ({ ...s, 2: 'active' }));

      // Always send files list; use hash data when available, fall back to basic info
      const files = filesData || basicFiles;
      const body = { keyword, episodes, fileName: firstFileName, files };
      if (filesData?.[0]?.fileHash) {
        body.fileHash = filesData[0].fileHash;
        body.fileSize = filesData[0].fileSize;
      }

      const result = await matchAnime(body);
      if (!mounted.current) return;

      if (result.matched) {
        setStepStatus(s => ({ ...s, 2: 'done', 3: 'done' }));
        setStep(3);
        setMatchResult(result);
        setPhase('ready');
        return;
      }

      // All phases failed -> manual
      setStepStatus(s => ({ ...s, 2: 'fail', 3: 'fail' }));
      setPhase('manual');
    } catch (err) {
      if (!mounted.current) return;
      // 401 is handled globally via auth:expired; don't render an error page
      if (err?.response?.status === 401) return;
      setError(err.message || 'Match failed');
      setPhase('error');
    }
  }, [mounted]);

  const selectManual = useCallback(async (anime, episodes) => {
    setPhase('matching');
    setStep(3);
    setStepStatus({ 1: 'done', 2: 'done', 3: 'active' });

    try {
      let epData;
      if (anime.bgmId) {
        epData = await getEpisodes(0, anime.bgmId);
      } else if (anime.dandanAnimeId) {
        epData = await getEpisodes(anime.dandanAnimeId);
      }

      if (!mounted.current) return;

      if (!epData) {
        setPhase('error');
        setError('Could not fetch episode list');
        return;
      }

      // Build episode map using shared three-level fallback (pure number →
      // OVA/Special prefix → index-based on regular episodes). The naive
      // number-only match fails for continuation seasons where dandanplay
      // numbers episodes as 25..35 instead of 1..11.
      const episodeMap = buildEpisodeMap(epData.episodes, episodes);

      setStepStatus(s => ({ ...s, 3: 'done' }));

      // Build siteAnime from animeCache search results
      const siteAnime = anime.anilistId ? {
        anilistId: anime.anilistId,
        titleChinese: anime.titleChinese,
        titleNative: anime.titleNative || anime.title,
        titleRomaji: anime.titleRomaji,
        coverImageUrl: anime.coverImageUrl,
        episodes: anime.episodes,
        status: anime.status,
        season: anime.season,
        seasonYear: anime.seasonYear,
        averageScore: anime.averageScore,
        bangumiScore: anime.bangumiScore,
        bangumiVotes: anime.bangumiVotes,
        genres: anime.genres,
        format: anime.format,
        bgmId: anime.bgmId,
        studios: anime.studios,
        source: anime.animeSource,
        duration: anime.duration,
      } : null;

      setMatchResult({
        matched: true,
        anime: {
          anilistId: anime.anilistId,
          titleChinese: anime.titleChinese,
          titleNative: anime.title || anime.titleNative,
          titleRomaji: anime.titleRomaji,
          coverImageUrl: anime.coverImageUrl || anime.imageUrl,
          episodes: anime.episodes,
        },
        siteAnime,
        episodeMap,
        source: anime.source || 'manual',
      });
      setPhase('ready');
    } catch (err) {
      if (!mounted.current) return;
      if (err?.response?.status === 401) return;
      setError(err.message || 'Episode fetch failed');
      setPhase('error');
    }
  }, [mounted]);

  const reset = useCallback(() => {
    setPhase('idle');
    setStep(0);
    setStepStatus({ 1: 'pending', 2: 'pending', 3: 'pending' });
    setMatchResult(null);
    setError(null);
  }, []);

  const updateEpisodeMap = useCallback((epNum, data, newAnime) => {
    setMatchResult(prev => {
      if (!prev) return prev;
      const updated = {
        ...prev,
        episodeMap: { ...prev.episodeMap, [epNum]: data },
      };
      if (newAnime) {
        updated.anime = {
          ...prev.anime,
          dandanAnimeId: newAnime.dandanAnimeId || prev.anime.dandanAnimeId,
          bgmId: newAnime.bgmId || prev.anime.bgmId,
          titleChinese: newAnime.titleChinese || newAnime.title || prev.anime.titleChinese,
          titleNative: newAnime.titleNative || newAnime.title || prev.anime.titleNative,
          titleRomaji: newAnime.titleRomaji || prev.anime.titleRomaji,
          coverImageUrl: newAnime.coverImageUrl || newAnime.imageUrl || prev.anime.coverImageUrl,
          episodes: newAnime.episodes || prev.anime.episodes,
        };
      }
      return updated;
    });
  }, []);

  return {
    phase, step, stepStatus, matchResult, error,
    startMatch, selectManual, reset, updateEpisodeMap,
  };
}
