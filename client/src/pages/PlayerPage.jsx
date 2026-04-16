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
  const { danmakuList, count: danmakuCount, loadComments, clearComments } = useDandanComments();

  const [playingFile, setPlayingFile] = useState(null);
  const [playingEp, setPlayingEp] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [subtitleUrl, setSubtitleUrl] = useState(null);
  const [subtitleType, setSubtitleType] = useState(null);
  const [subtitleContent, setSubtitleContent] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);

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

  const handlePlay = useCallback((fileItem) => {
    // Immediately start playback — no blocking await
    const url = getVideoUrl(fileItem.file);
    setVideoUrl(url);
    setPlayingFile(fileItem);
    setPlayingEp(fileItem.episode);

    // Handle external subtitle files synchronously
    if (fileItem.subtitle) {
      setSubtitleUrl(getSubtitleUrl(fileItem.subtitle.file));
      setSubtitleType(fileItem.subtitle.type);
      setSubtitleContent(null);
    } else {
      setSubtitleUrl(null);
      setSubtitleType(null);
      setSubtitleContent(null);
    }

    // Load danmaku (non-blocking)
    const epData = matchResult?.episodeMap?.[fileItem.episode];
    if (epData?.dandanEpisodeId) {
      loadComments(epData.dandanEpisodeId);
    } else {
      clearComments();
    }

    // MKV embedded subtitle extraction — async, patches in after ready
    if (!fileItem.subtitle && /\.mkv$/i.test(fileItem.fileName)) {
      const w = new Worker(
        new URL('../workers/mkvSubtitle.worker.js', import.meta.url),
        { type: 'module' },
      );
      const timer = setTimeout(() => { w.terminate(); }, 30000);
      w.onmessage = (e) => {
        clearTimeout(timer);
        w.terminate();
        const extracted = e.data.result;
        if (!extracted) return;
        if (extracted.type === 'vtt') {
          setSubtitleUrl(URL.createObjectURL(new Blob([extracted.content], { type: 'text/vtt' })));
          setSubtitleType('vtt');
        } else {
          setSubtitleContent(extracted.content);
          const vtt = extracted.vtt || extracted.content;
          setSubtitleUrl(URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })));
          setSubtitleType(extracted.type);
        }
      };
      w.onerror = () => { clearTimeout(timer); w.terminate(); };
      w.postMessage({ file: fileItem.file });
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

  const handleUpdateDanmaku = useCallback((epNum, data, newAnime) => {
    updateEpisodeMap(epNum, data, newAnime);
    // If currently playing this episode, reload danmaku
    if (playingEp === epNum && data.dandanEpisodeId) {
      loadComments(data.dandanEpisodeId);
    }
    toast.success(t('player.danmakuUpdated'));
  }, [updateEpisodeMap, playingEp, loadComments, t]);

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
            onUpdateDanmaku={handleUpdateDanmaku}
            keyword={keyword}
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
            <div>
              <div style={s.epTitle}>
                EP{String(playingEp).padStart(2, '0')}
                {matchResult?.anime?.titleChinese && ` · ${matchResult.anime.titleChinese}`}
              </div>
              {matchResult?.episodeMap?.[playingEp]?.title && (
                <div style={s.epSubtitle}>{matchResult.episodeMap[playingEp].title}</div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {danmakuCount > 0 && (
                <span style={{
                  padding: '4px 10px', borderRadius: 9999, fontSize: 12,
                  background: 'rgba(90,200,250,0.10)', color: '#5ac8fa',
                  fontFamily: "'JetBrains Mono',monospace", fontWeight: 500,
                }}>
                  {danmakuCount} {t('player.danmakuCount')}
                </span>
              )}
              <button
                style={{
                  background: 'rgba(120,120,128,0.12)', border: 'none', borderRadius: 8,
                  padding: '6px 12px', fontSize: 13, fontWeight: 500,
                  color: '#5ac8fa', cursor: 'pointer', transition: 'background 150ms',
                }}
                onClick={() => setPickerOpen(true)}
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
          <DanmakuPicker
            isOpen={pickerOpen}
            onClose={() => setPickerOpen(false)}
            onConfirm={(data, newAnime) => {
              handleUpdateDanmaku(playingEp, data, newAnime);
              setPickerOpen(false);
            }}
            currentAnime={matchResult?.anime}
            currentEpisodeId={matchResult?.episodeMap?.[playingEp]?.dandanEpisodeId}
            episodeNumber={playingEp}
            defaultKeyword={keyword}
          />
        </div>
      )}
    </div>
  );
}
