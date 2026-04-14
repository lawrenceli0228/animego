import { useState, useCallback } from 'react';
import { matchAnime, getEpisodes } from '../api/dandanplay.api';

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

  const startMatch = useCallback(async (keyword, episodes, firstFileName, getFilesHashes) => {
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

      const body = { keyword, episodes, fileName: firstFileName };
      if (filesData?.length > 0) {
        body.fileHash = filesData[0].fileHash;
        body.fileSize = filesData[0].fileSize;
        body.files = filesData;
      }

      const result = await matchAnime(body);

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
      setError(err.message || 'Match failed');
      setPhase('error');
    }
  }, []);

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

      if (!epData) {
        setPhase('error');
        setError('Could not fetch episode list');
        return;
      }

      // Build episode map from returned episodes
      const episodeMap = {};
      for (const epNum of episodes) {
        const match = epData.episodes.find(e => e.number === epNum);
        if (match) {
          episodeMap[epNum] = {
            dandanEpisodeId: match.dandanEpisodeId,
            title: match.title,
          };
        }
      }

      setStepStatus(s => ({ ...s, 3: 'done' }));
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
        episodeMap,
        source: anime.source || 'manual',
      });
      setPhase('ready');
    } catch (err) {
      setError(err.message || 'Episode fetch failed');
      setPhase('error');
    }
  }, []);

  const reset = useCallback(() => {
    setPhase('idle');
    setStep(0);
    setStepStatus({ 1: 'pending', 2: 'pending', 3: 'pending' });
    setMatchResult(null);
    setError(null);
  }, []);

  const goManual = useCallback(() => {
    setPhase('manual');
    setMatchResult(null);
  }, []);

  return {
    phase, step, stepStatus, matchResult, error,
    startMatch, selectManual, reset, goManual,
  };
}
