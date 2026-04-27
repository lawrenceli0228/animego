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
import PlayerHudFrame from '../components/player/PlayerHudFrame';
import EpisodeNav from '../components/player/EpisodeNav';
import DanmakuPicker from '../components/player/DanmakuPicker';
import { ChapterBar, SectionNum, CornerBrackets } from '../components/shared/hud';
import { mono, PLAYER_HUE } from '../components/shared/hud-tokens';
import toast from 'react-hot-toast';

const FADE_UP_CSS = `@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}`;
const fadeUp = { animation: 'fadeUp 300ms cubic-bezier(0.4,0,0.2,1) both' };

const HUE = PLAYER_HUE.stream;
const HUE_DANMAKU = PLAYER_HUE.ingest;

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
  // HUD-styled play header — replaces the old rounded glass card.
  // Pattern matches landing primitives: relative parent + ChapterBar + SectionNum + CornerBrackets.
  playHeader: {
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: 'auto 1fr auto',
    alignItems: 'center',
    gap: 24,
    maxWidth: 1400, margin: '16px auto 12px',
    padding: '20px 28px 20px 56px',
    background: `linear-gradient(180deg, oklch(14% 0.04 ${HUE} / 0.55) 0%, rgba(20,20,22,0.55) 100%)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.36)`,
    borderRadius: 4,
  },
  epEyebrow: {
    ...mono,
    fontSize: 10,
    color: `oklch(72% 0.15 ${HUE} / 0.85)`,
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  epTitle: {
    fontFamily: "'Sora',sans-serif", fontWeight: 600,
    fontSize: 18, color: '#ffffff', letterSpacing: '-0.01em', lineHeight: 1.25,
  },
  epSubtitle: {
    fontSize: 13, color: 'rgba(235,235,245,0.45)', marginTop: 4,
    fontFamily: "'JetBrains Mono',monospace", letterSpacing: '0.04em',
  },
  // Outline back button — corner brackets reveal on hover (Motion #12).
  backBtn: (hover) => ({
    position: 'relative',
    background: hover ? `oklch(62% 0.19 ${HUE} / 0.10)` : 'transparent',
    border: `1px solid oklch(46% 0.06 ${HUE} / ${hover ? 0.65 : 0.40})`,
    borderRadius: 2,
    padding: '8px 14px',
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 11,
    fontWeight: 500, letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: hover ? '#fff' : 'rgba(235,235,245,0.75)',
    cursor: 'pointer',
    transition: 'all 150ms cubic-bezier(0.16,1,0.3,1)',
    overflow: 'visible',
  }),
  // Danmaku count chip — OKLCH, monospace, tabular nums.
  danmakuChip: {
    ...mono,
    padding: '5px 12px',
    borderRadius: 9999,
    fontSize: 11,
    background: `oklch(62% 0.19 ${HUE} / 0.10)`,
    color: `oklch(78% 0.15 ${HUE})`,
    border: `1px solid oklch(62% 0.19 ${HUE} / 0.28)`,
    letterSpacing: '0.10em',
  },
  loadingChip: {
    ...mono,
    padding: '5px 12px',
    borderRadius: 9999,
    fontSize: 11,
    background: 'rgba(235,235,245,0.06)',
    color: 'rgba(235,235,245,0.55)',
    border: '1px solid rgba(235,235,245,0.16)',
    letterSpacing: '0.10em',
  },
  // HUD-style "set danmaku" button — transparent + 1px border + mono label.
  danmakuBtn: (hover) => ({
    background: hover ? `oklch(62% 0.19 ${HUE_DANMAKU} / 0.12)` : 'transparent',
    border: `1px solid oklch(62% 0.19 ${HUE_DANMAKU} / ${hover ? 0.55 : 0.32})`,
    borderRadius: 2,
    padding: '7px 14px',
    fontFamily: "'JetBrains Mono',monospace",
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: hover ? `oklch(78% 0.15 ${HUE_DANMAKU})` : `oklch(72% 0.15 ${HUE_DANMAKU} / 0.85)`,
    cursor: 'pointer',
    transition: 'all 150ms',
  }),
  headerActions: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 },
  playerWrap: { maxWidth: 1400, margin: '0 auto' },
  danmakuInfo: {
    ...mono,
    fontSize: 11, color: 'rgba(235,235,245,0.30)',
    textAlign: 'center', padding: '8px 0',
    textTransform: 'uppercase', letterSpacing: '0.14em',
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

// Header back button — split out so corner-brackets fade-in (Motion #12) can
// hook into hover state without bloating the parent's render path.
function HudBackButton({ onClick, label }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      style={s.backBtn(hover)}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <CornerBrackets show={hover} animate inset={-3} size={6} opacity={0.5} hue={PLAYER_HUE.stream} />
      ← {label}
    </button>
  );
}

function HudDanmakuButton({ onClick, label }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      style={s.danmakuBtn(hover)}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      DANMAKU // {label}
    </button>
  );
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
    playingFile, playingEp, videoUrl, subtitleUrl,
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
          <header style={s.playHeader}>
            {/* HUD identity strip — bar + chapter num + corners */}
            <ChapterBar hue={HUE} height={56} top={8} left={20} trigger="mount" />
            <SectionNum n="01" style={{ top: 12, right: 16, fontSize: 10 }} />
            <CornerBrackets inset={6} size={8} opacity={0.32} />

            <HudBackButton onClick={handleBackToList} label={t('player.backToList')} />

            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
              <div style={s.epEyebrow} aria-hidden>EPISODE / 集</div>
              <div style={s.epTitle}>
                EP{String(playingEp).padStart(2, '0')}
                {matchResult?.anime?.titleChinese && ` · ${matchResult.anime.titleChinese}`}
              </div>
              {matchResult?.episodeMap?.[playingEp]?.title && (
                <div style={s.epSubtitle}>{matchResult.episodeMap[playingEp].title}</div>
              )}
            </div>

            <div style={s.headerActions}>
              {loadingDanmaku ? (
                <span style={s.loadingChip}>{t('player.loadingDanmaku')}</span>
              ) : danmakuCount > 0 ? (
                <span style={s.danmakuChip}>
                  {danmakuCount.toLocaleString()} {t('player.danmakuCount')}
                </span>
              ) : null}
              <HudDanmakuButton onClick={() => setPickerEp(playingEp)} label={t('player.setDanmaku')} />
            </div>
          </header>

          <div style={s.playerWrap}>
            <PlayerHudFrame
              videoUrl={videoUrl}
              danmakuList={danmakuList}
              subtitleUrl={subtitleUrl}
              onEnded={handleVideoEnded}
              progressKey={progressKey}
              episode={playingEp}
              danmakuCount={danmakuCount}
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
