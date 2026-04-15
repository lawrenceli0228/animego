import { useState, useCallback, useMemo } from 'react';
import { useLang } from '../context/LanguageContext';
import useVideoFiles from '../hooks/useVideoFiles';
import useDandanMatch from '../hooks/useDandanMatch';
import useDandanComments from '../hooks/useDandanComments';
import DropZone from '../components/player/DropZone';
import MatchProgress from '../components/player/MatchProgress';
import ManualSearch from '../components/player/ManualSearch';
import EpisodeFileList from '../components/player/EpisodeFileList';
import VideoPlayer from '../components/player/VideoPlayer';
import EpisodeNav from '../components/player/EpisodeNav';
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
    maxWidth: 1400, margin: '0 auto', padding: '16px 0',
  },
  backBtn: {
    background: 'none', border: 'none', color: 'rgba(235,235,245,0.60)',
    fontSize: 14, cursor: 'pointer',
  },
  epTitle: {
    fontFamily: "'Sora',sans-serif", fontWeight: 600,
    fontSize: 16, color: '#ffffff',
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
    startMatch, selectManual, reset: resetMatch,
  } = useDandanMatch();
  const { danmakuList, count: danmakuCount, loadComments, clearComments } = useDandanComments();

  const [playingFile, setPlayingFile] = useState(null);
  const [playingEp, setPlayingEp] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [subtitleUrl, setSubtitleUrl] = useState(null);
  const [subtitleType, setSubtitleType] = useState(null);
  const [subtitleContent, setSubtitleContent] = useState(null);

  // Mobile guard
  if (isMobile()) {
    return (
      <div style={s.mobile}>
        <div style={s.mobileTitle}>{t('player.desktopOnly')}</div>
        <div>{t('player.desktopHint')}</div>
      </div>
    );
  }

  // Determine current UI state
  const uiPhase = playingFile ? 'playing' : phase;

  // Episode numbers from matched files
  const episodes = useMemo(() => {
    if (!matchResult?.episodeMap) return [];
    return videoFiles
      .filter(f => f.episode != null && matchResult.episodeMap[f.episode])
      .map(f => f.episode)
      .sort((a, b) => a - b);
  }, [videoFiles, matchResult]);

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

  const handlePlay = useCallback(async (fileItem) => {
    let subUrl = null;
    let subType = null;
    let subContent = null;

    if (fileItem.subtitle) {
      subUrl = getSubtitleUrl(fileItem.subtitle.file);
      subType = fileItem.subtitle.type;
    } else if (/\.mkv$/i.test(fileItem.fileName)) {
      // Extract embedded subtitle from MKV container
      const extracted = await new Promise((resolve) => {
        const w = new Worker(
          new URL('../workers/mkvSubtitle.worker.js', import.meta.url),
          { type: 'module' },
        );
        const timer = setTimeout(() => { w.terminate(); resolve(null); }, 30000);
        w.onmessage = (e) => { clearTimeout(timer); w.terminate(); resolve(e.data.result || null); };
        w.onerror = () => { clearTimeout(timer); w.terminate(); resolve(null); };
        w.postMessage({ file: fileItem.file });
      });
      if (extracted) {
        subType = extracted.type;
        if (extracted.type === 'vtt') {
          subUrl = URL.createObjectURL(new Blob([extracted.content], { type: 'text/vtt' }));
        } else {
          // ASS/SSA: pass content for JASSUB, VTT blob as Artplayer fallback
          subContent = extracted.content;
          const vtt = extracted.vtt || extracted.content;
          subUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
        }
      }
    }

    const url = getVideoUrl(fileItem.file);
    setVideoUrl(url);
    setPlayingFile(fileItem);
    setPlayingEp(fileItem.episode);
    setSubtitleUrl(subUrl);
    setSubtitleType(subType);
    setSubtitleContent(subContent);

    // Load danmaku
    const epData = matchResult?.episodeMap?.[fileItem.episode];
    if (epData?.dandanEpisodeId) {
      loadComments(epData.dandanEpisodeId);
    } else {
      clearComments();
    }
  }, [getVideoUrl, getSubtitleUrl, matchResult, loadComments, clearComments]);

  const handleEpisodeSwitch = useCallback((epNum) => {
    const fileItem = videoFiles.find(f => f.episode === epNum);
    if (fileItem) handlePlay(fileItem);
  }, [videoFiles, handlePlay]);

  const handleBackToList = useCallback(() => {
    setPlayingFile(null);
    setPlayingEp(null);
    setVideoUrl(null);
    setSubtitleUrl(null);
    setSubtitleType(null);
    setSubtitleContent(null);
    clearComments();
  }, [clearComments]);

  const handleClearAll = useCallback(() => {
    handleBackToList();
    clearFiles();
    resetMatch();
  }, [handleBackToList, clearFiles, resetMatch]);

  const handleManualSelect = useCallback((anime) => {
    const epNums = videoFiles.map(f => f.episode).filter(Boolean);
    selectManual(anime, epNums);
  }, [videoFiles, selectManual]);

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
          />
        </div>
      )}

      {/* PLAYING */}
      {uiPhase === 'playing' && (
        <div style={fadeUp}>
          <div style={s.playHeader}>
            <button style={s.backBtn} onClick={handleBackToList}>
              ← {t('player.backToList')}
            </button>
            <span style={s.epTitle}>
              EP{String(playingEp).padStart(2, '0')}
              {matchResult?.anime?.titleChinese && ` · ${matchResult.anime.titleChinese}`}
            </span>
            <div />
          </div>
          <div style={s.playerWrap}>
            <VideoPlayer
              videoUrl={videoUrl}
              danmakuList={danmakuList}
              subtitleUrl={subtitleUrl}
              subtitleType={subtitleType}
              subtitleContent={subtitleContent}
            />
            <div style={s.danmakuInfo}>
              {danmakuCount > 0
                ? `${danmakuCount} ${t('player.danmakuCount')}`
                : t('player.noDanmaku')}
            </div>
            <EpisodeNav
              episodes={episodes}
              currentEpisode={playingEp}
              onSelect={handleEpisodeSwitch}
            />
          </div>
        </div>
      )}
    </div>
  );
}
