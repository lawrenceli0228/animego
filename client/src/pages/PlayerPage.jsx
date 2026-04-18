import { useState, useCallback, useMemo, useEffect } from 'react';
import { useLang } from '../context/LanguageContext';
import useVideoFiles from '../hooks/useVideoFiles';
import useDandanMatch from '../hooks/useDandanMatch';
import useDandanComments from '../hooks/useDandanComments';
import usePlaybackSession from '../hooks/usePlaybackSession';
import DropZone from '../components/player/DropZone';
import MatchProgress from '../components/player/MatchProgress';
import ManualSearch from '../components/player/ManualSearch';
import EpisodeFileList from '../components/player/EpisodeFileList';
import VideoPlayer from '../components/player/VideoPlayer';
import EpisodeNav from '../components/player/EpisodeNav';
import DanmakuPicker from '../components/player/DanmakuPicker';
import toast from 'react-hot-toast';

const FADE_UP_CSS = `@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}`;
const fadeUp = { animation: 'fadeUp 300ms cubic-bezier(0.4,0,0.2,1) both' };

const s = {
  page: { minHeight: 'calc(100vh - 56px)', padding: '0 24px 48px' },
  mobile: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', minHeight: 'calc(100vh - 56px)',
    color: 'rgba(235,235,245,0.60)', textAlign: 'center', gap: 16, padding: 24,
  },
  mobileTitle: {
    fontFamily: "'Sora',sans-serif", fontWeight: 600,
    fontSize: 20, color: '#ffffff',
  },
  playHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    maxWidth: 1400, margin: '16px auto 0', padding: '12px 16px',
    background: 'rgba(28,28,30,0.80)',
    backdropFilter: 'saturate(180%) blur(20px)',
    WebkitBackdropFilter: 'saturate(180%) blur(20px)',
    borderRadius: 12, marginBottom: 12,
  },
  backBtn: {
    background: 'rgba(120,120,128,0.12)', border: 'none', borderRadius: 8,
    padding: '8px 16px', fontSize: 14, fontWeight: 500,
    color: '#0a84ff', cursor: 'pointer',
    transition: 'background 150ms',
  },
  epTitle: {
    fontFamily: "'Sora',sans-serif", fontWeight: 600,
    fontSize: 16, color: '#ffffff', textAlign: 'center',
  },
  epSubtitle: {
    fontSize: 13, color: 'rgba(235,235,245,0.40)', marginTop: 2,
    textAlign: 'center',
  },
  playerWrap: { maxWidth: 1400, margin: '0 auto' },
  danmakuInfo: {
    fontSize: 13, color: 'rgba(235,235,245,0.30)',
    textAlign: 'center', padding: '8px 0',
  },
  errorBox: {
    maxWidth: 600, margin: '64px auto', textAlign: 'center',
    padding: 48, color: 'rgba(235,235,245,0.60)',
  },
  errorTitle: {
    fontSize: 18, fontWeight: 600, color: '#ff453a', marginBottom: 12,
  },
  retryBtn: {
    marginTop: 16, padding: '10px 20px', borderRadius: 8,
    background: '#0a84ff', color: '#fff', border: 'none',
    fontSize: 14, fontWeight: 500, cursor: 'pointer',
  },
};

function isMobile() {
  return window.innerWidth <= 600;
}

export default function PlayerPage() {
  const { t } = useLang();
  const { videoFiles, keyword, processFiles, getVideoUrl, getSubtitleUrl, clear: clearFiles } = useVideoFiles();
  const {
    phase, stepStatus, matchResult, error,
    startMatch, selectManual, reset: resetMatch, updateEpisodeMap,
  } = useDandanMatch();
  const { danmakuList, count: danmakuCount, loading: loadingDanmaku, loadComments, clearComments } = useDandanComments();
  const playback = usePlaybackSession({ getVideoUrl, getSubtitleUrl, loadComments, clearComments });
  const {
    phase: playbackPhase,
    playingFile, playingEp, videoUrl, subtitleUrl, subtitleType, subtitleContent,
    play: startPlayback, back: stopPlayback,
  } = playback;

  const [pickerEp, setPickerEp] = useState(null);
  const [isMobileView, setIsMobileView] = useState(isMobile);

  useEffect(() => {
    const onResize = () => setIsMobileView(isMobile());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Determine current UI state — playback overlays match phase
  const uiPhase = playbackPhase === 'playing' ? 'playing' : phase;

  // Episode numbers from matched files
  const episodes = useMemo(() => {
    if (!matchResult?.episodeMap) return [];
    return videoFiles
      .filter(f => f.episode != null && matchResult.episodeMap[f.episode])
      .map(f => f.episode)
      .sort((a, b) => a - b);
  }, [videoFiles, matchResult]);

  // Stable per-episode key for progress memory (localStorage)
  const progressKey = useMemo(() => {
    if (playingEp == null || !matchResult?.anime) return null;
    const anime = matchResult.anime;
    const id = anime.anilistId || anime.dandanAnimeId || anime.bgmId;
    if (!id) return null;
    return `animego:progress:${id}:${playingEp}`;
  }, [playingEp, matchResult]);

  const handleFiles = useCallback(async (fileList) => {
    const { files, keyword: kw } = processFiles(fileList);
    if (!files.length) {
      toast.error(t('player.noVideos'));
      return;
    }

    const epNums = files.map(f => f.episode).filter(Boolean);
    const firstFile = files[0]?.fileName || '';

    const hashFile = (file) => new Promise((resolve) => {
      try {
        const worker = new Worker(
          new URL('../workers/md5.worker.js', import.meta.url),
          { type: 'module' }
        );
        worker.onmessage = (e) => { worker.terminate(); resolve(e.data.hash); };
        worker.onerror = () => { worker.terminate(); resolve(null); };
        worker.postMessage({ file });
      } catch { resolve(null); }
    });

    const getFilesHashes = async () => {
      const results = await Promise.all(files.map(async (f) => ({
        fileName: f.fileName,
        episode: f.episode,
        fileHash: await hashFile(f.file),
        fileSize: f.file.size,
      })));
      return results;
    };

    const basicFiles = files.map(f => ({ fileName: f.fileName, episode: f.episode, fileSize: f.file.size }));
    startMatch(kw, epNums, firstFile, basicFiles, getFilesHashes);
  }, [processFiles, startMatch, t]);

  const handlePlay = useCallback((fileItem) => {
    startPlayback(fileItem, matchResult?.episodeMap);
  }, [startPlayback, matchResult]);

  const handleEpisodeSwitch = useCallback((epNum) => {
    const fileItem = videoFiles.find(f => f.episode === epNum);
    if (fileItem) startPlayback(fileItem, matchResult?.episodeMap);
  }, [videoFiles, startPlayback, matchResult]);

  const handleBackToList = useCallback(() => {
    stopPlayback();
  }, [stopPlayback]);

  const handleClearAll = useCallback(() => {
    stopPlayback();
    clearFiles();
    resetMatch();
  }, [stopPlayback, clearFiles, resetMatch]);

  const handleManualSelect = useCallback((anime) => {
    const epNums = videoFiles.map(f => f.episode).filter(Boolean);
    selectManual(anime, epNums);
  }, [videoFiles, selectManual]);

  const handleUpdateDanmaku = useCallback((epNum, data, newAnime) => {
    updateEpisodeMap(epNum, data, newAnime);
    // If currently playing this episode, reload danmaku
    if (playingEp === epNum && data.dandanEpisodeId) {
      loadComments(data.dandanEpisodeId);
    }
    toast.success(t('player.danmakuUpdated'));
  }, [updateEpisodeMap, playingEp, loadComments, t]);

  const handleVideoEnded = useCallback(() => {
    const idx = episodes.indexOf(playingEp);
    if (idx >= 0 && idx < episodes.length - 1) {
      handleEpisodeSwitch(episodes[idx + 1]);
    }
  }, [episodes, playingEp, handleEpisodeSwitch]);

  // Mobile guard — after all hooks to satisfy Rules of Hooks
  if (isMobileView) {
    return (
      <div style={s.mobile}>
        <div style={s.mobileTitle}>{t('player.desktopOnly')}</div>
        <div>{t('player.desktopHint')}</div>
      </div>
    );
  }

  return (
    <div style={s.page}>
      <style>{FADE_UP_CSS}</style>

      {/* IDLE */}
      {uiPhase === 'idle' && (
        <div style={fadeUp}><DropZone onFiles={handleFiles} /></div>
      )}

      {/* MATCHING */}
      {uiPhase === 'matching' && (
        <div style={{ marginTop: 64, ...fadeUp }}>
          <MatchProgress
            fileCount={videoFiles.length}
            keyword={keyword}
            stepStatus={stepStatus}
            onClear={handleClearAll}
          />
        </div>
      )}

      {/* MANUAL */}
      {uiPhase === 'manual' && (
        <div style={{ marginTop: 32, ...fadeUp }}>
          <ManualSearch
            defaultKeyword={keyword}
            onSelect={handleManualSelect}
            onBack={handleClearAll}
          />
        </div>
      )}

      {/* ERROR */}
      {uiPhase === 'error' && (
        <div style={{ ...s.errorBox, ...fadeUp }}>
          <div style={s.errorTitle}>{t('player.error')}</div>
          <div>{error || t('player.errorGeneric')}</div>
          <button style={s.retryBtn} onClick={handleClearAll}>
            {t('player.retry')}
          </button>
        </div>
      )}

      {/* READY */}
      {uiPhase === 'ready' && matchResult && (
        <div style={{ marginTop: 32, ...fadeUp }}>
          <EpisodeFileList
            anime={matchResult.anime}
            siteAnime={matchResult.siteAnime}
            episodeMap={matchResult.episodeMap}
            videoFiles={videoFiles}
            onPlay={handlePlay}
            onClear={handleClearAll}
            onSetDanmaku={setPickerEp}
          />
        </div>
      )}

      {/* PLAYING */}
      {uiPhase === 'playing' && (
        <div style={fadeUp}>
          <div style={s.playHeader}>
            <button
              style={s.backBtn}
              onClick={handleBackToList}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(120,120,128,0.20)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(120,120,128,0.12)'; }}
            >
              ← {t('player.backToList')}
            </button>
            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
              <div style={s.epTitle}>
                EP{String(playingEp).padStart(2, '0')}
                {matchResult?.anime?.titleChinese && ` · ${matchResult.anime.titleChinese}`}
              </div>
              {matchResult?.episodeMap?.[playingEp]?.title && (
                <div style={s.epSubtitle}>{matchResult.episodeMap[playingEp].title}</div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {loadingDanmaku ? (
                <span style={{
                  padding: '4px 10px', borderRadius: 9999, fontSize: 12,
                  background: 'rgba(235,235,245,0.08)', color: 'rgba(235,235,245,0.60)',
                  fontFamily: "'JetBrains Mono',monospace", fontWeight: 500,
                }}>
                  {t('player.loadingDanmaku')}
                </span>
              ) : danmakuCount > 0 ? (
                <span style={{
                  padding: '4px 10px', borderRadius: 9999, fontSize: 12,
                  background: 'rgba(90,200,250,0.10)', color: '#5ac8fa',
                  fontFamily: "'JetBrains Mono',monospace", fontWeight: 500,
                }}>
                  {danmakuCount} {t('player.danmakuCount')}
                </span>
              ) : null}
              <button
                style={{
                  background: 'rgba(120,120,128,0.12)', border: 'none', borderRadius: 8,
                  padding: '6px 12px', fontSize: 13, fontWeight: 500,
                  color: '#5ac8fa', cursor: 'pointer', transition: 'background 150ms',
                }}
                onClick={() => setPickerEp(playingEp)}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(120,120,128,0.20)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(120,120,128,0.12)'; }}
              >
                💬 {t('player.setDanmaku')}
              </button>
            </div>
          </div>
          <div style={s.playerWrap}>
            <VideoPlayer
              videoUrl={videoUrl}
              danmakuList={danmakuList}
              subtitleUrl={subtitleUrl}
              subtitleType={subtitleType}
              subtitleContent={subtitleContent}
              onEnded={handleVideoEnded}
              progressKey={progressKey}
            />
            {danmakuCount === 0 && (
              <div style={s.danmakuInfo}>{t('player.noDanmaku')}</div>
            )}
            <EpisodeNav
              episodes={episodes}
              currentEpisode={playingEp}
              onSelect={handleEpisodeSwitch}
            />
          </div>
        </div>
      )}

      {/* Shared DanmakuPicker — works from both list view and playing view */}
      <DanmakuPicker
        isOpen={pickerEp != null}
        onClose={() => setPickerEp(null)}
        onConfirm={(data, newAnime) => {
          handleUpdateDanmaku(pickerEp, data, newAnime);
          setPickerEp(null);
        }}
        currentAnime={matchResult?.anime}
        currentEpisodeId={pickerEp != null ? matchResult?.episodeMap?.[pickerEp]?.dandanEpisodeId : null}
        episodeNumber={pickerEp}
        defaultKeyword={keyword}
      />
    </div>
  );
}
