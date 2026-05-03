import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { createHashPool } from '../lib/library/hashPool';
import { groupByFolder } from '../lib/library/grouping';
import { flattenDropFiles } from '../utils/dropFiles';
import { useLang } from '../context/LanguageContext';
import useVideoFiles from '../hooks/useVideoFiles';
import useDandanMatch from '../hooks/useDandanMatch';
import useDandanComments from '../hooks/useDandanComments';
import usePlaybackSession from '../hooks/usePlaybackSession';
import useFileHandles from '../hooks/useFileHandles';
import useSeriesDetail from '../hooks/useSeriesDetail';
import { db } from '../lib/library/db/db.js';
import { episodeListFromSeriesDetail } from '../lib/library/buildLibraryMatchResult.js';
import DropZone from '../components/player/DropZone';
import MatchProgress from '../components/player/MatchProgress';
import ManualSearch from '../components/player/ManualSearch';
import EpisodeFileList from '../components/player/EpisodeFileList';
import PlayerHudFrame from '../components/player/PlayerHudFrame';
import EpisodeNav from '../components/player/EpisodeNav';
import DanmakuPicker from '../components/player/DanmakuPicker';
import LibraryAccessEmpty from '../components/library/LibraryAccessEmpty';
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
  // Page-level drop overlay — only shown while dragging Files in non-idle phase.
  dropOverlay: {
    position: 'fixed', inset: 0, zIndex: 9000,
    background: `oklch(14% 0.04 ${HUE_DANMAKU} / 0.78)`,
    backdropFilter: 'blur(6px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    pointerEvents: 'none',
  },
  dropOverlayInner: {
    border: `2px dashed oklch(72% 0.19 ${HUE_DANMAKU})`,
    borderRadius: 4,
    padding: '64px 96px',
    textAlign: 'center',
    background: `oklch(14% 0.04 ${HUE_DANMAKU} / 0.55)`,
  },
  dropOverlayEyebrow: {
    ...mono,
    fontSize: 11,
    color: `oklch(78% 0.15 ${HUE_DANMAKU})`,
    textTransform: 'uppercase',
    letterSpacing: '0.20em',
    marginBottom: 12,
  },
  dropOverlayTitle: {
    fontFamily: "'Sora',sans-serif", fontWeight: 700,
    fontSize: 28, color: '#fff', letterSpacing: '-0.01em',
  },
};

// Tiny `{{var}}` interpolation for toast strings — t() doesn't support it.
// Param renamed `tpl` so it doesn't shadow the module-level `s` styles object.
function fmtTpl(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ''));
}

function fmtMmSs(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

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
  // P3: library mode entry — read seriesId + optional resumeEpisode from nav state
  const location = useLocation();
  const navigate = useNavigate();
  const locationSeriesId = location?.state?.seriesId ?? null;
  const locationResumeEpisode =
    typeof location?.state?.resumeEpisode === 'number'
      ? location.state.resumeEpisode
      : null;

  const fileHandles = useFileHandles({ db });
  const seriesDetail = useSeriesDetail(locationSeriesId, { db, fileHandles });

  // Becomes true once a library getFile() returns null while permissions are
  // denied — drives the empty-state switch even before the next render reads
  // fileHandles.status. Reset on seriesId / refresh.
  const [denialDetected, setDenialDetected] = useState(false);
  useEffect(() => { setDenialDetected(false); }, [locationSeriesId]);

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
    resumeAt, setLastTime,
  } = playback;

  const [pickerEp, setPickerEp] = useState(null);
  const [isMobileView, setIsMobileView] = useState(isMobile);

  useEffect(() => {
    const onResize = () => setIsMobileView(isMobile());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const hashPoolRef = useRef(null);
  useEffect(() => {
    hashPoolRef.current = createHashPool();
    return () => {
      hashPoolRef.current?.dispose();
      hashPoolRef.current = null;
    };
  }, []);

  // Determine current UI state — playback overlays match phase
  const uiPhase = playbackPhase === 'playing' ? 'playing' : phase;

  // P2: same-folder grouping. Multi-folder drops auto-pick the largest group;
  // P3 will replace this auto-pick with a real picker UI.
  const groups = useMemo(() => groupByFolder(videoFiles), [videoFiles]);
  const dropZoneItems = groups[0]?.items ?? videoFiles;
  const skippedFileCount = useMemo(
    () => groups.slice(1).reduce((n, g) => n + g.items.length, 0),
    [groups],
  );

  // Library mode pickedItems — episode rows derived from IDB. file=null on
  // each item; getFile() is called lazily via _episodeId when a row is played.
  const libraryVideoFiles = useMemo(() => {
    if (!locationSeriesId || seriesDetail.status !== 'ready') return [];
    return episodeListFromSeriesDetail(
      seriesDetail.episodes,
      seriesDetail.fileRefByEpisode,
    );
  }, [locationSeriesId, seriesDetail]);

  // pickedItems unifies the rendered file list across both entry paths so
  // EpisodeFileList sees the same shape regardless of how matchResult arrived.
  const pickedItems = locationSeriesId ? libraryVideoFiles : dropZoneItems;

  // Episode numbers from matched files (now drawn from picked group only)
  const episodes = useMemo(() => {
    if (!matchResult?.episodeMap) return [];
    return pickedItems
      .filter(f => f.episode != null && matchResult.episodeMap[f.episode])
      .map(f => f.episode)
      .sort((a, b) => a - b);
  }, [pickedItems, matchResult]);

  // Toast on multi-folder auto-pick. Fires once per groups identity.
  const lastGroupsKey = useRef(null);
  useEffect(() => {
    if (!groups.length) { lastGroupsKey.current = null; return; }
    const key = groups.map(g => `${g.groupKey}:${g.items.length}`).join('|');
    if (lastGroupsKey.current === key) return;
    lastGroupsKey.current = key;
    if (groups.length > 1) {
      const picked = groups[0];
      const labelText = picked.groupKey === '__root__' ? t('player.rootFolder') : picked.label;
      toast(fmtTpl(t('player.multiFolderToast'), {
        label: labelText,
        picked: picked.items.length,
        others: skippedFileCount,
      }));
    }
    if (groups[0]?.hasAmbiguity) {
      toast(t('player.alphaFallbackToast'));
    }
  }, [groups, skippedFileCount, t]);

  // Stable per-episode key for progress memory (localStorage)
  const progressKey = useMemo(() => {
    if (playingEp == null || !matchResult?.anime) return null;
    const anime = matchResult.anime;
    const id = anime.anilistId || anime.dandanAnimeId || anime.bgmId;
    if (!id) return null;
    return `animego:progress:${id}:${playingEp}`;
  }, [playingEp, matchResult]);

  const handleFiles = useCallback(async (fileList, opts = {}) => {
    const mode = opts.mode || 'append';
    const { files, keyword: kw } = processFiles(fileList, { mode });
    if (!files.length) {
      toast.error(t('player.noVideos'));
      return;
    }

    const epNums = files.map(f => f.episode).filter(Boolean);
    const firstFile = files[0]?.fileName || '';

    const pool = hashPoolRef.current;
    const getFilesHashes = async () => {
      if (!pool) {
        return files.map(f => ({ fileName: f.fileName, episode: f.episode, fileHash: '', fileSize: f.file.size }));
      }
      const results = await Promise.all(files.map(async (f) => ({
        fileName: f.fileName,
        episode: f.episode,
        fileHash: await pool.hash(f.file),
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

  // P2: throttled progress tick from VideoPlayer → in-memory lastTime Map.
  // playingFile read via ref so the throttled callback in VideoPlayer never
  // sees a stale fileId during the one-render window before its ref syncs.
  const playingFileIdRef = useRef(null);
  useEffect(() => { playingFileIdRef.current = playingFile?.fileId ?? null; }, [playingFile]);
  const handleProgressTick = useCallback((sec) => {
    const id = playingFileIdRef.current;
    if (id) setLastTime(id, sec);
  }, [setLastTime]);

  // P2: resume toast — fires once per play() that actually resumes (>0).
  // Rendered as info, not error; only when no localStorage progressKey exists
  // (matched files keep their own restore semantics).
  const lastResumeToastForFile = useRef(null);
  useEffect(() => {
    if (!playingFile || !resumeAt || progressKey) return;
    if (lastResumeToastForFile.current === playingFile.fileId) return;
    lastResumeToastForFile.current = playingFile.fileId;
    toast(fmtTpl(t('player.resumedAt'), { time: fmtMmSs(resumeAt) }));
  }, [playingFile, resumeAt, progressKey, t]);

  const handleEpisodeSwitch = useCallback((epNum) => {
    const fileItem = pickedItems.find(f => f.episode === epNum);
    if (fileItem) startPlayback(fileItem, matchResult?.episodeMap);
  }, [pickedItems, startPlayback, matchResult]);

  const handleBackToList = useCallback(() => {
    // Reset the once-per-file guard so re-playing the same file with an
    // updated lastTime can re-fire the resume toast.
    lastResumeToastForFile.current = null;
    stopPlayback();
    // Same behavior whether the user arrived via drop-zone import or via the
    // library card → /player path: stop playback and reveal the rich
    // EpisodeFileList list above. The library card's "// 返回库 //" button
    // is the explicit exit back to /library when they want to leave.
  }, [stopPlayback]);

  const handleClearAll = useCallback(() => {
    stopPlayback();
    clearFiles();
    resetMatch();
  }, [stopPlayback, clearFiles, resetMatch]);

  // P3: library mode — sorted episode numbers used by EpisodeNav prev/next.
  // Empty array unless seriesDetail is ready, so non-library mode keeps using
  // the matchResult-derived `episodes` array below.
  const libraryEpisodeNumbers = useMemo(() => {
    if (!locationSeriesId || seriesDetail.status !== 'ready') return [];
    return seriesDetail.episodes
      .filter((e) => e.kind !== 'sp' && e.number != null)
      .map((e) => e.number)
      .sort((a, b) => a - b);
  }, [locationSeriesId, seriesDetail]);

  // Library auto-match — when seriesDetail becomes ready, fire the same
  // startMatch() that the drop-zone flow runs. Inputs come from IDB:
  //   - hashes already computed at import time (fileRef.hash16M)
  //   - episode numbers from db.episodes
  //   - keyword from series titles
  // The server returns matched anime + siteAnime + episodeMap exactly the way
  // it does for an upload, so the post-match UI is bit-for-bit identical.
  const libraryMatchedRef = useRef(/** @type {string|null} */ (null));
  useEffect(() => {
    libraryMatchedRef.current = null;
  }, [locationSeriesId]);
  useEffect(() => {
    if (!locationSeriesId) return;
    if (seriesDetail.status !== 'ready') return;
    if (libraryVideoFiles.length === 0) return;
    if (matchResult) return;
    if (libraryMatchedRef.current === locationSeriesId) return;

    libraryMatchedRef.current = locationSeriesId;

    const epNums = libraryVideoFiles.map((f) => f.episode).filter(Boolean);
    const firstName = libraryVideoFiles[0]?.fileName || '';
    const basicFiles = libraryVideoFiles.map((f) => ({
      fileName: f.fileName,
      episode: f.episode,
      fileSize: f._fileRef?.size ?? 0,
    }));
    const getFilesHashes = async () => libraryVideoFiles.map((f) => ({
      fileName: f.fileName,
      episode: f.episode,
      fileHash: f._fileRef?.hash16M ?? '',
      fileSize: f._fileRef?.size ?? 0,
    }));

    const series = seriesDetail.series;
    const keyword = series?.titleZh || series?.titleEn || series?.titleJa || '';

    startMatch(keyword, epNums, firstName, basicFiles, getFilesHashes);
  }, [locationSeriesId, seriesDetail.status, seriesDetail.series, libraryVideoFiles, matchResult, startMatch]);

  // P3: library mode — episode click handler
  const handleLibraryEpisodePlay = useCallback(async (episodeId) => {
    // Subtitle is no longer auto-attached from a sibling .ass file — that
    // path proved fragile (jassub init in dev was unreliable). mkv internal
    // tracks still flow through the existing extraction worker; users who
    // need a specific external .ass/.vtt/.srt can load it via the player's
    // settings menu ("加载字幕文件").
    const file = await seriesDetail.getFile(episodeId);
    if (!file) {
      // selectFileByName flips fileHandles.status to 'denied' synchronously on
      // NotAllowedError. Read it via the live ref since `fileHandles` from
      // closure is the previous render's snapshot.
      if (fileHandles.status === 'denied') {
        setDenialDetected(true);
      } else {
        toast.error(t('library.fileMissing'));
      }
      return;
    }
    const ep = seriesDetail.episodes.find((e) => e.id === episodeId);
    const fileRef = seriesDetail.fileRefByEpisode.get(episodeId);
    if (!ep || !fileRef) return;

    // Prefer the server-shaped matchResult.episodeMap when the auto-match has
    // landed; fall back to a synthesis from IDB Episode.episodeId so the
    // danmaku pipeline still works during the brief window between
    // "seriesDetail ready" and "matchResult arrived".
    let episodeMap;
    if (matchResult?.episodeMap) {
      episodeMap = matchResult.episodeMap;
    } else {
      episodeMap = {};
      for (const e of seriesDetail.episodes) {
        if (e.number != null) {
          episodeMap[e.number] = { dandanEpisodeId: e.episodeId };
        }
      }
    }

    const fileItem = {
      fileId: fileRef.id,
      file,
      fileName: fileRef.relPath.split('/').pop() || fileRef.relPath,
      relativePath: fileRef.relPath,
      episode: ep.number,
      parsedKind: ep.kind || 'main',
    };

    startPlayback(fileItem, episodeMap);
  }, [seriesDetail, startPlayback, t, fileHandles.status, matchResult]);

  // Library mode empty-state derivations. The denied path takes precedence
  // over 'ready' because IDB is fine but FSA can't reach the file — same UX
  // signal regardless of how denial was detected (proactive at hook level
  // vs reactive after a click).
  const libraryEmptyKind = useMemo(() => {
    if (!locationSeriesId) return null;
    if (seriesDetail.status === 'loading') return 'loading';
    if (seriesDetail.status === 'missing') return 'missing';
    if (seriesDetail.status === 'error') return 'error';
    if (seriesDetail.status === 'ready'
        && (fileHandles.status === 'denied' || denialDetected)) {
      return 'denied';
    }
    return null;
  }, [locationSeriesId, seriesDetail.status, fileHandles.status, denialDetected]);

  const libraryIdsForReauth = useMemo(() => {
    /** @type {Set<string>} */
    const ids = new Set();
    for (const ref of seriesDetail.fileRefByEpisode.values()) {
      if (ref?.libraryId) ids.add(ref.libraryId);
    }
    return Array.from(ids);
  }, [seriesDetail.fileRefByEpisode]);

  const handleReauthorize = useCallback(async () => {
    for (const libId of libraryIdsForReauth) {
      await fileHandles.reauthorize(libId);
    }
    setDenialDetected(false);
    seriesDetail.refresh();
  }, [fileHandles, libraryIdsForReauth, seriesDetail]);

  const handleBackToLibrary = useCallback(() => {
    navigate('/library');
  }, [navigate]);

  // Library mode "back" — exit the player and return to the library grid.
  // Wired to EpisodeFileList's clear button so it stops feeling like a
  // destructive "clear" and reads as "exit player".
  const handleBackToLibraryGrid = useCallback(() => {
    navigate('/library');
  }, [navigate]);

  // Unified click handler for EpisodeFileList rows. Library items carry an
  // `_episodeId` set by the adapter — those route through getFile() so FSA
  // resolves the actual File before playback. Match-flow items already hold
  // their File and can hit startPlayback directly.
  const handleListPlay = useCallback((fileItem) => {
    if (fileItem?._episodeId) {
      handleLibraryEpisodePlay(fileItem._episodeId);
      return;
    }
    handlePlay(fileItem);
  }, [handlePlay, handleLibraryEpisodePlay]);

  const handleRetryLoad = useCallback(() => {
    seriesDetail.refresh();
  }, [seriesDetail]);

  // P3: library mode prev/next — switch by episode number using seriesDetail.
  const handleLibraryEpisodeSwitchByNumber = useCallback((epNum) => {
    if (!locationSeriesId) return;
    const ep = seriesDetail.episodes.find((e) => e.number === epNum && e.kind !== 'sp');
    if (!ep) return;
    handleLibraryEpisodePlay(ep.id);
  }, [locationSeriesId, seriesDetail, handleLibraryEpisodePlay]);

  // P3: auto-play `state.resumeEpisode` when seriesDetail becomes ready.
  // One-shot: state flips after a single attempt (success OR failure) so a
  // failed resume reveals the library list as fallback instead of trapping the
  // user on a blank page.
  const [autoResumeAttempted, setAutoResumeAttempted] = useState(false);
  useEffect(() => {
    if (!locationSeriesId || locationResumeEpisode == null) return;
    if (seriesDetail.status !== 'ready') return;
    if (libraryEmptyKind) return;
    if (playbackPhase === 'playing') return;
    if (autoResumeAttempted) return;
    const ep = seriesDetail.episodes.find(
      (e) => e.number === locationResumeEpisode && e.kind !== 'sp',
    );
    setAutoResumeAttempted(true);
    if (!ep) return;
    handleLibraryEpisodePlay(ep.id);
  }, [locationSeriesId, locationResumeEpisode, seriesDetail, playbackPhase, autoResumeAttempted, handleLibraryEpisodePlay, libraryEmptyKind]);

  // Page-level drag/drop. The inner DropZone only renders in idle phase, so
  // dragging files onto the page when match is ready/playing/manual/error
  // would otherwise be silently ignored. Here we accept a drop in any phase
  // and replace the current session with the new files.
  const [pageDragging, setPageDragging] = useState(false);
  const dragCounter = useRef(0);

  const handlePageDragEnter = useCallback((e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault();
    dragCounter.current += 1;
    if (uiPhase !== 'idle') setPageDragging(true);
  }, [uiPhase]);

  const handlePageDragOver = useCallback((e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault();
  }, []);

  const handlePageDragLeave = useCallback(() => {
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setPageDragging(false);
  }, []);

  const handlePageDrop = useCallback(async (e) => {
    dragCounter.current = 0;
    setPageDragging(false);
    // In idle, DropZone handles its own drop via stopPropagation. We arrive here
    // only when (a) phase is non-idle, or (b) user dropped outside DropZone in idle.
    if (uiPhase === 'idle') return;
    e.preventDefault();
    const files = await flattenDropFiles(e.dataTransfer);
    if (!files.length) return;
    // Replace current session. processFiles({ mode:'replace' }) revokes prior blob URLs
    // synchronously and discards prev state in one dispatch — no clearFiles() race.
    stopPlayback();
    resetMatch();
    handleFiles(files, { mode: 'replace' });
  }, [uiPhase, stopPlayback, resetMatch, handleFiles]);

  const handleManualSelect = useCallback((anime) => {
    const epNums = pickedItems.map(f => f.episode).filter(Boolean);
    selectManual(anime, epNums);
  }, [pickedItems, selectManual]);

  const handleUpdateDanmaku = useCallback(async (epNum, data, newAnime) => {
    // Always update the in-memory matchResult so the row reflects the change
    // immediately. Library mode additionally persists to IDB so re-entering
    // the page on a future visit picks up the corrected episodeId without
    // re-running the picker.
    updateEpisodeMap(epNum, data, newAnime);
    if (locationSeriesId && data?.dandanEpisodeId) {
      const target = seriesDetail.episodes.find(
        (e) => e.number === epNum && e.kind !== 'sp',
      );
      if (target) {
        try {
          await db.episodes.update(target.id, {
            episodeId: data.dandanEpisodeId,
            updatedAt: Date.now(),
          });
          seriesDetail.refresh();
        } catch (err) {
          console.warn('[player] failed to persist danmaku update:', err);
        }
      }
    }
    // If currently playing this episode, reload danmaku
    if (playingEp === epNum && data.dandanEpisodeId) {
      loadComments(data.dandanEpisodeId);
    }
    toast.success(t('player.danmakuUpdated'));
  }, [locationSeriesId, seriesDetail, updateEpisodeMap, playingEp, loadComments, t]);

  const handleVideoEnded = useCallback(() => {
    // Library mode: advance via libraryEpisodeNumbers + library switcher.
    if (locationSeriesId && libraryEpisodeNumbers.length > 0) {
      const idx = libraryEpisodeNumbers.indexOf(playingEp);
      if (idx >= 0 && idx < libraryEpisodeNumbers.length - 1) {
        handleLibraryEpisodeSwitchByNumber(libraryEpisodeNumbers[idx + 1]);
      }
      return;
    }
    const idx = episodes.indexOf(playingEp);
    if (idx >= 0 && idx < episodes.length - 1) {
      handleEpisodeSwitch(episodes[idx + 1]);
    }
  }, [
    locationSeriesId,
    libraryEpisodeNumbers,
    handleLibraryEpisodeSwitchByNumber,
    episodes,
    playingEp,
    handleEpisodeSwitch,
  ]);

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
    <div
      style={s.page}
      onDragEnter={handlePageDragEnter}
      onDragOver={handlePageDragOver}
      onDragLeave={handlePageDragLeave}
      onDrop={handlePageDrop}
    >
      <style>{FADE_UP_CSS}</style>
      {pageDragging && uiPhase !== 'idle' && (
        <div style={s.dropOverlay} aria-hidden>
          <div style={s.dropOverlayInner}>
            <div style={s.dropOverlayEyebrow}>INGEST //</div>
            <div style={s.dropOverlayTitle}>{t('player.dropReplace')}</div>
          </div>
        </div>
      )}

      {/* LIBRARY MODE — empty/denied/error/loading states for seriesId path */}
      {locationSeriesId && libraryEmptyKind && playbackPhase !== 'playing' && (
        <div style={fadeUp}>
          <LibraryAccessEmpty
            kind={libraryEmptyKind}
            onReauthorize={libraryIdsForReauth.length ? handleReauthorize : undefined}
            onRetry={handleRetryLoad}
            onBackToLibrary={handleBackToLibrary}
          />
        </div>
      )}

      {/* IDLE — only shown when NOT in library mode */}
      {uiPhase === 'idle' && !locationSeriesId && (
        <div style={fadeUp}><DropZone onFiles={handleFiles} /></div>
      )}

      {/* IDLE fallback when in library mode but not yet ready */}
      {locationSeriesId && seriesDetail.status === 'idle' && (
        <div style={fadeUp}><DropZone onFiles={handleFiles} /></div>
      )}

      {/* MATCHING — drives BOTH drop-zone uploads and library auto-match.
          Library entry path: keyword falls back to the series title; file
          count is `pickedItems.length` (libraryVideoFiles when locationSeriesId set). */}
      {uiPhase === 'matching' && (
        <div style={{ marginTop: 64, ...fadeUp }}>
          <MatchProgress
            fileCount={pickedItems.length || videoFiles.length}
            keyword={keyword || seriesDetail.series?.titleZh || seriesDetail.series?.titleEn || ''}
            stepStatus={stepStatus}
            onClear={locationSeriesId ? handleBackToLibraryGrid : handleClearAll}
          />
        </div>
      )}

      {/* MANUAL */}
      {uiPhase === 'manual' && (
        <div style={{ marginTop: 32, ...fadeUp }}>
          <ManualSearch
            defaultKeyword={keyword || seriesDetail.series?.titleZh || seriesDetail.series?.titleEn || ''}
            onSelect={handleManualSelect}
            onBack={locationSeriesId ? handleBackToLibraryGrid : handleClearAll}
          />
        </div>
      )}

      {/* ERROR */}
      {uiPhase === 'error' && (
        <div style={{ ...s.errorBox, ...fadeUp }}>
          <div style={s.errorTitle}>{t('player.error')}</div>
          <div>{error || t('player.errorGeneric')}</div>
          <button style={s.retryBtn} onClick={locationSeriesId ? handleBackToLibraryGrid : handleClearAll}>
            {t('player.retry')}
          </button>
        </div>
      )}

      {/* READY — unified across drop-zone and library entry paths. Both
          arrive here with the SAME server-shaped matchResult; only the
          videoFiles source and "clear" semantics diverge. */}
      {uiPhase === 'ready' && matchResult && !libraryEmptyKind && (locationResumeEpisode == null || autoResumeAttempted) && (
        <div data-testid={locationSeriesId ? 'library-episode-list' : undefined} style={{ marginTop: 32, ...fadeUp }}>
          <EpisodeFileList
            anime={matchResult.anime}
            siteAnime={matchResult.siteAnime}
            episodeMap={matchResult.episodeMap}
            videoFiles={pickedItems}
            onPlay={handleListPlay}
            onClear={locationSeriesId ? handleBackToLibraryGrid : handleClearAll}
            onSetDanmaku={setPickerEp}
            clearLabel={locationSeriesId ? '返回库' : undefined}
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
              resumeAt={resumeAt}
              onProgressTick={handleProgressTick}
            />
            {danmakuCount === 0 && (
              <div style={s.danmakuInfo}>{t('player.noDanmaku')}</div>
            )}
            <EpisodeNav
              episodes={locationSeriesId ? libraryEpisodeNumbers : episodes}
              currentEpisode={playingEp}
              onSelect={locationSeriesId ? handleLibraryEpisodeSwitchByNumber : handleEpisodeSwitch}
            />
          </div>
        </div>
      )}

      {/* Shared DanmakuPicker — works from list view and playing view; both
          entry paths populate the same `matchResult`. */}
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
        defaultKeyword={keyword || seriesDetail.series?.titleZh || seriesDetail.series?.titleEn || ''}
      />
    </div>
  );
}
