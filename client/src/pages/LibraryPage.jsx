// @ts-check
import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import useLibrary from '../hooks/useLibrary';
import useResume from '../hooks/useResume';
import useFileHandles from '../hooks/useFileHandles';
import useImport from '../hooks/useImport';
import useVideoFiles from '../hooks/useVideoFiles';
import useUserOverride from '../hooks/useUserOverride';
import useSeriesProgressMap from '../hooks/useSeriesProgressMap';
import { isFsaSupported } from '../lib/library/handles/fsaFeatureCheck.js';
import { enumerateAll } from '../lib/library/enumerator.js';
import { applySeriesFilter, computeFilterCounts } from '../lib/library/seriesFilter.js';
import { db } from '../lib/library/db/db.js';
import { migrateLegacyProgress } from '../lib/library/db/migrateLegacyProgress.js';
import { ulid } from '../lib/library/ulid.js';
import LibraryEmptyState from '../components/library/LibraryEmptyState';
import DropZone from '../components/library/DropZone';
import FsaUnsupportedBanner from '../components/library/FsaUnsupportedBanner';
import useSeriesLibraryStatus from '../hooks/useSeriesLibraryStatus';
import SeriesGrid from '../components/library/SeriesGrid';
import FilterChips from '../components/library/FilterChips';
import SearchBar from '../components/library/SearchBar';
import RecentlyPlayedPosterRow from '../components/library/RecentlyPlayedPosterRow';
import NewAdditionsRow from '../components/library/NewAdditionsRow';
import ScrollRow from '../components/library/ScrollRow';
import SeriesCardSkeleton from '../components/library/SeriesCardSkeleton';
import WatchRhythmStrip from '../components/library/WatchRhythmStrip';
import useWatchRhythm from '../hooks/useWatchRhythm';
import MergeDialog from '../components/library/MergeDialog';
import SplitDialog from '../components/library/SplitDialog';
import RematchDialog from '../components/library/RematchDialog';
import ImportDrawer from '../components/library/ImportDrawer';
import ImportMiniPill from '../components/library/ImportMiniPill';
import UnclassifiedSection from '../components/library/UnclassifiedSection';
import UnavailableSeriesSection from '../components/library/UnavailableSeriesSection';
import HudOverflowMenu from '../components/library/HudOverflowMenu';
import HudCelebration from '../components/library/HudCelebration';
import SeriesDetailSheet from '../components/library/SeriesDetailSheet';
import useUnclassified from '../hooks/useUnclassified';
import useSeriesSelection from '../hooks/useSeriesSelection.js';
import BulkActionToolbar from '../components/library/BulkActionToolbar';
import UndoToast from '../components/shared/UndoToast';
import { splitSeries } from '../services/splitSeries.js';
import { rematchSeries } from '../services/rematchSeries.js';
import { performMerge, undoMerge } from '../services/mergeOps.js';
import { deleteSeriesCascade } from '../services/deleteSeries.js';
import { dedupeSeriesByAnimeId } from '../services/dedupeSeries.js';
import { createDandanClient } from '../services/dandanClient.js';
import { refreshAllSeriesMetadata } from '../services/refreshSeriesMetadata.js';
import { useLang } from '../context/LanguageContext';
import { mono, PLAYER_HUE, LOCAL_HEX_GLYPH, useCountUp } from '../components/shared/hud-tokens';
import { CornerBrackets } from '../components/shared/hud';
import { motion, useReducedMotion } from 'motion/react';
import toast from 'react-hot-toast';

// Tiny `{{var}}` interpolation for toast strings — t() doesn't support it.
function fmtTpl(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ''));
}

/**
 * Mount-time count-up wrapper. Pulls useCountUp's ref into the rendered <span>
 * so the value animates from 0 to target on first reveal. Reduced-motion users
 * see the target value immediately.
 *
 * @param {{ value: number, delay?: number, style?: React.CSSProperties }} props
 */
function StatNum({ value, delay = 0, style }) {
  const [ref, n] = useCountUp(value, { duration: 1.0, delay });
  return <span ref={ref} style={style}>{n}</span>;
}

const HUE = PLAYER_HUE.stream;
const PRIVACY_PULSE_CSS = '@keyframes libraryPrivacyPulse{0%,100%{opacity:0.55;transform:scale(0.92)}50%{opacity:1;transform:scale(1)}}';

// §5.x — sparse-row threshold (Q1 design decision A). Below this count we
// skip the discovery rows entirely and surface only the main grid + a
// "drop more folders" hint, matching Apple TV+ small-library behavior.
// Source: ~/.gstack/projects/lawrenceli0228-animego/designs/library-decisions-20260503/
const ROWS_THRESHOLD = 5;

// Skeleton card counts during the availability-loading window. Tuned to
// match the typical first-paint footprint: 2 rows × 8 + a 4×2 grid.
const SKELETON_ROW_COUNT = 8;
const SKELETON_GRID_COUNT = 8;
const SKELETON_GRID_STYLE = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 24 };

const s = {
  page: {
    maxWidth: 1400,
    margin: '0 auto',
    padding: '32px 24px 96px',
    display: 'flex',
    flexDirection: 'column',
    gap: 24,
  },
  hudHeader: {
    position: 'relative',
    padding: '24px 0 32px',
    borderBottom: '1px solid #38383a',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 24,
    flexWrap: 'wrap',
  },
  hudHeaderInner: { flex: 1, minWidth: 0 },
  hudKicker: {
    ...mono,
    fontSize: 11,
    color: 'rgba(235,235,245,0.30)',
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  hudTitle: {
    fontFamily: "'Sora', sans-serif",
    fontWeight: 700,
    fontSize: 32,
    letterSpacing: '-0.02em',
    color: '#fff',
    margin: '0 0 8px',
    display: 'flex',
    alignItems: 'baseline',
    gap: 14,
    flexWrap: 'wrap',
  },
  hudTitleEn: {
    ...mono,
    fontSize: 11,
    color: 'rgba(235,235,245,0.30)',
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
  },
  hudSubtitle: {
    color: 'rgba(235,235,245,0.60)',
    fontSize: 13,
    display: 'flex',
    gap: 14,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  hudNum: {
    ...mono,
    color: '#fff',
  },
  hudDot: { color: 'rgba(235,235,245,0.18)' },
  hudPrivacy: {
    ...mono,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 10,
    color: '#30d158',
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
  },
  hudPrivacyDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#30d158',
    boxShadow: '0 0 8px #30d158',
    animation: 'libraryPrivacyPulse 2s ease-in-out infinite',
  },
  hudActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  // legacy fallback (kept for selection toolbar compose)
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: {
    fontFamily: "'Sora', sans-serif",
    fontWeight: 700,
    fontSize: 22,
    color: '#fff',
    letterSpacing: '-0.01em',
  },
  addBtn: {
    ...mono,
    padding: '8px 16px',
    background: `oklch(62% 0.17 ${HUE} / 0.20)`,
    border: `1px solid oklch(62% 0.17 ${HUE} / 0.55)`,
    borderRadius: 4,
    color: `oklch(72% 0.15 ${HUE})`,
    cursor: 'pointer',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
  },
  resetBtn: {
    ...mono,
    padding: '8px 14px',
    background: 'transparent',
    border: '1px solid oklch(60% 0.20 25 / 0.50)',
    borderRadius: 4,
    color: 'oklch(70% 0.18 25)',
    cursor: 'pointer',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
  },
  refreshBtn: (busy) => ({
    ...mono,
    padding: '8px 14px',
    background: busy
      ? `oklch(46% 0.06 ${HUE} / 0.20)`
      : 'transparent',
    border: `1px solid oklch(46% 0.06 ${HUE} / ${busy ? 0.45 : 0.55})`,
    borderRadius: 4,
    color: busy ? 'rgba(235,235,245,0.45)' : 'rgba(235,235,245,0.78)',
    cursor: busy ? 'wait' : 'pointer',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
    opacity: busy ? 0.7 : 1,
  }),
  headerActions: { display: 'flex', alignItems: 'center', gap: 8 },
  sectionLabel: {
    ...mono,
    fontSize: 10,
    color: `rgba(235,235,245,0.45)`,
    textTransform: 'uppercase',
    letterSpacing: '0.15em',
    marginBottom: 8,
  },
};

/**
 * LibraryPage — browse, import, and manage local anime library.
 * FSA path: pick folder → traverse → processFiles → importPipeline.
 * Safari fallback: drop zone → in-memory only (libraryId = mem:<sessionId>).
 */
export default function LibraryPage() {
  const { t } = useLang();
  const navigate = useNavigate();
  const fsaSupported = isFsaSupported();

  const dandan = useMemo(() => createDandanClient(), []);
  const { series, loading } = useLibrary({ db });
  const { entries: resumeEntries } = useResume({ db });
  const { status, pickFolder, libraryStatus, refresh: refreshHandles } = useFileHandles({ db });
  const { availabilityBySeries, ready: availabilityIndexReady } = useSeriesLibraryStatus({
    db,
    libraryStatus,
  });

  // Combine: index loaded AND handles probed (or known to be never-probing).
  // Used to gate the discovery rows so they don't briefly render offline
  // series as accessible while the async join is still resolving.
  const availabilityReady = availabilityIndexReady && status !== 'idle' && status !== 'loading';
  const {
    run: runImport,
    progress: importProgress,
    summary: importSummary,
    status: importStatus,
    error: importError,
    cancel: cancelImport,
  } = useImport({ db, dandan });
  const [importDismissed, setImportDismissed] = useState(false);
  const { processFiles } = useVideoFiles();
  const { all: overrides, lock, unlock, clear } = useUserOverride({ db });
  const { entries: unclassifiedEntries } = useUnclassified({ db });
  const { map: progressMap } = useSeriesProgressMap({ db });
  const watchRhythm = useWatchRhythm({ db });
  const [activeFilter, setActiveFilter] = useState(/** @type {import('../components/library/FilterChips').LibraryFilter} */ (null));
  const [searchQuery, setSearchQuery] = useState('');
  /** @type {React.MutableRefObject<import('../components/library/SearchBar').SearchBarHandle | null>} */
  const searchRef = useRef(/** @type {any} */ (null));
  const [mergeSourceId, setMergeSourceId] = useState(/** @type {string|null} */ (null));
  const [splitSourceId, setSplitSourceId] = useState(/** @type {string|null} */ (null));
  const [splitSeasons, setSplitSeasons] = useState(/** @type {any[]} */ ([]));
  const [rematchSourceId, setRematchSourceId] = useState(/** @type {string|null} */ (null));
  const [undoToast, setUndoToast] = useState(/** @type {{ opIds: string[], title: string, meta?: string }|null} */ (null));
  const [autoMergeQueue, setAutoMergeQueue] = useState(
    /** @type {Array<{ seriesId: string, title: string, meta: string }>} */ ([]),
  );
  // §5.x — point-click on a grid card opens this sheet instead of navigating
  // straight to /player. Inside the sheet the user picks a specific episode;
  // that click closes the sheet and routes through to the player with the
  // chosen resumeEpisode.
  const [detailSeriesId, setDetailSeriesId] = useState(/** @type {string|null} */ (null));
  // Track the last importSummary we converted into auto-merge toasts so a
  // re-render with the same summary object doesn't re-enqueue toasts. The
  // useImport hook keeps a stable reference until the next import begins.
  const consumedSummaryRef = useRef(/** @type {object|null} */ (null));
  const selection = useSeriesSelection();

  const visibleSeries = useMemo(
    () => applySeriesFilter(series, progressMap, activeFilter, searchQuery),
    [series, progressMap, activeFilter, searchQuery],
  );

  // Main grid only shows accessible series. offline / partial drop into the
  // dedicated UnavailableSeriesSection below the grid so users aren't forced
  // to look at content they can't currently play.
  const mainGridSeries = useMemo(
    () => visibleSeries.filter((sr) => {
      const av = availabilityBySeries.get(sr.id);
      return av !== 'offline' && av !== 'partial';
    }),
    [visibleSeries, availabilityBySeries],
  );

  // Unavailable section is anchored to the full library — search/filter chips
  // don't shrink it. It's an inventory of "what's currently unreachable", not
  // a search result.
  const unavailableSeries = useMemo(
    () => series.filter((sr) => {
      const av = availabilityBySeries.get(sr.id);
      return av === 'offline' || av === 'partial';
    }),
    [series, availabilityBySeries],
  );

  const filterCounts = useMemo(
    () => computeFilterCounts(series, progressMap),
    [series, progressMap],
  );

  const mergeSource = useMemo(
    () => series.find((sr) => sr.id === mergeSourceId) ?? null,
    [series, mergeSourceId],
  );

  const splitSource = useMemo(
    () => series.find((sr) => sr.id === splitSourceId) ?? null,
    [series, splitSourceId],
  );

  const rematchSource = useMemo(
    () => series.find((sr) => sr.id === rematchSourceId) ?? null,
    [series, rematchSourceId],
  );

  // Load seasons for the split source on demand. Cleared when dialog closes
  // so a stale list never leaks into a subsequent open.
  useEffect(() => {
    if (!splitSourceId) {
      setSplitSeasons([]);
      return undefined;
    }
    let cancelled = false;
    db.seasons
      .where('seriesId')
      .equals(splitSourceId)
      .toArray()
      .then((rows) => {
        if (!cancelled) setSplitSeasons(rows);
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('[library] failed to load seasons for split:', err);
          setSplitSeasons([]);
        }
      });
    return () => { cancelled = true; };
  }, [splitSourceId]);

  // Global `/` keybinding — focuses the SearchBar from anywhere on the page,
  // matching the convention used by GitHub / Linear / Vercel. Skips if a text
  // input or contenteditable already has focus so we don't hijack the user.
  useEffect(() => {
    function onKey(e) {
      if (e.key !== '/') return;
      const t = /** @type {HTMLElement|null} */ (e.target);
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // One-shot legacy progress migration on first mount.
  // Idempotent — second run sees zero legacy keys and exits cheaply.
  useEffect(() => {
    let cancelled = false;
    migrateLegacyProgress({ db }).catch((err) => {
      if (!cancelled) {
        console.warn('[LibraryPage] migrateLegacyProgress failed:', err);
      }
    });
    return () => { cancelled = true; };
  }, []);

  /** Whether to show the add-folder header button (FSA + has series already) */
  const showAddBtn = fsaSupported && series.length > 0;

  const handleAddFolder = useCallback(async () => {
    if (!fsaSupported) return;
    const libraryId = ulid();
    const record = await pickFolder(libraryId);
    if (!record) return;

    const collected = await enumerateAll(record.handle);
    const allFiles = collected.map(({ file }) => file);
    const pathMap = new Map(collected.map(({ file, relPath }) => [file, relPath]));
    const { files: items } = processFiles(allFiles, { pathMap });
    setImportDismissed(false);
    await runImport({ items, libraryId: record.libraryId });
  }, [fsaSupported, pickFolder, processFiles, runImport]);

  const handlePickSeries = useCallback((id) => {
    // Open the in-page episode picker. The user picks an exact episode there
    // and `handlePickEpisode` routes to /player with the resume target.
    setDetailSeriesId(id);
  }, []);

  const handlePickEpisode = useCallback((seriesId, episodeNumber) => {
    setDetailSeriesId(null);
    navigate('/player', { state: { seriesId, resumeEpisode: episodeNumber } });
  }, [navigate]);

  // §5.x — "弹幕播放" CTA in the detail sheet. Mirrors the legacy
  // direct-card-click behavior: routes to /player WITHOUT a resumeEpisode
  // hint so the player owns the dandanplay match + episode-pick flow,
  // surfacing the EpisodeFileList + DanmakuPicker that the post-import
  // path already uses.
  const handlePlaySeries = useCallback((seriesId) => {
    setDetailSeriesId(null);
    navigate('/player', { state: { seriesId } });
  }, [navigate]);

  const handleResume = useCallback((id, episodeNumber) => {
    navigate('/player', { state: { seriesId: id, resumeEpisode: episodeNumber } });
  }, [navigate]);

  const handleOverrideAction = useCallback(
    async (seriesId, action) => {
      try {
        if (action === 'lock') await lock(seriesId);
        else if (action === 'unlock') await unlock(seriesId);
        else if (action === 'clear') await clear(seriesId);
        else if (action === 'merge') setMergeSourceId(seriesId);
        else if (action === 'split') setSplitSourceId(seriesId);
        else if (action === 'rematch') setRematchSourceId(seriesId);
        else if (action === 'delete') {
          // Confirm + cascade-delete (series + seasons + episodes + owned
          // fileRefs + progress + userOverride). On-disk video files are NOT
          // touched. Re-importing the same folder will recreate the records.
          const target = series.find((sr) => sr.id === seriesId);
          const title = target?.titleZh || target?.titleEn || target?.titleJa || seriesId;
          const ok = window.confirm(
            `从库里删除「${title}」?\n\n会清掉本地的元数据 / 进度 / 覆盖,但磁盘上的视频文件不会被动。`,
          );
          if (!ok) return;
          await deleteSeriesCascade({ db, seriesId });
          toast.success(`已删除「${title}」`);
        }
      } catch (err) {
        console.warn(`[library] override action ${action} failed:`, err);
        toast.error('删除失败,请重试');
      }
    },
    [lock, unlock, clear, series],
  );

  const handleMergeConfirm = useCallback(
    async (targetSeriesId) => {
      if (!mergeSourceId || mergeSourceId === targetSeriesId) {
        setMergeSourceId(null);
        return;
      }
      const sourceSeries = series.find((sr) => sr.id === mergeSourceId) ?? null;
      const targetSeries = series.find((sr) => sr.id === targetSeriesId) ?? null;
      const targetTitle = targetSeries?.titleZh || targetSeries?.titleEn || targetSeries?.titleJa || targetSeriesId;
      const sourceTitle = sourceSeries?.titleZh || sourceSeries?.titleEn || sourceSeries?.titleJa || mergeSourceId;
      try {
        const op = await performMerge({
          db,
          sourceSeriesId: mergeSourceId,
          targetSeriesId,
          summary: { targetTitle, sourceTitle },
        });
        if (op) {
          setUndoToast({
            opIds: [op.id],
            title: targetTitle,
            meta: `从 ${sourceTitle} 合并`,
          });
        }
      } catch (err) {
        console.warn('[library] merge failed:', err);
      } finally {
        setMergeSourceId(null);
      }
    },
    [mergeSourceId, series],
  );

  const handleBulkDelete = useCallback(async () => {
    const ids = selection.ids;
    if (ids.length === 0) return;
    const titles = ids
      .map((id) => series.find((sr) => sr.id === id))
      .map((sr) => sr?.titleZh || sr?.titleEn || sr?.titleJa || sr?.id || '?');
    const preview = titles.slice(0, 3).join('、') + (titles.length > 3 ? `… (共 ${titles.length} 项)` : '');
    const ok = window.confirm(
      `从库里删除以下 ${ids.length} 项?\n\n${preview}\n\n会清掉本地的元数据 / 进度 / 覆盖,但磁盘上的视频文件不会被动。`,
    );
    if (!ok) return;
    let okCount = 0;
    for (const id of ids) {
      try {
        await deleteSeriesCascade({ db, seriesId: id });
        okCount += 1;
      } catch (err) {
        console.warn('[library] bulk delete step failed:', err);
      }
    }
    selection.clear();
    if (okCount === ids.length) {
      toast.success(`已删除 ${okCount} 项`);
    } else if (okCount > 0) {
      toast.success(`已删除 ${okCount}/${ids.length} 项,部分失败`);
    } else {
      toast.error('删除失败,请重试');
    }
  }, [selection, series]);

  const handleBulkMerge = useCallback(async () => {
    const ids = selection.ids;
    if (ids.length < 2) return;
    const [targetSeriesId, ...sourceIds] = ids;
    const targetSeries = series.find((sr) => sr.id === targetSeriesId) ?? null;
    const targetTitle =
      targetSeries?.titleZh ||
      targetSeries?.titleEn ||
      targetSeries?.titleJa ||
      targetSeriesId;
    const opIds = [];
    for (const sourceId of sourceIds) {
      try {
        const op = await performMerge({
          db,
          sourceSeriesId: sourceId,
          targetSeriesId,
          summary: { targetTitle, batch: true },
        });
        if (op) opIds.push(op.id);
      } catch (err) {
        console.warn('[library] bulk merge step failed:', err);
      }
    }
    selection.clear();
    if (opIds.length > 0) {
      setUndoToast({
        opIds,
        title: `合并到 ${targetTitle}`,
        meta: `${opIds.length} 项`,
      });
    }
  }, [selection, series]);

  const handleSelectAllVisible = useCallback(() => {
    selection.selectAll(visibleSeries.map((sr) => sr.id));
  }, [selection, visibleSeries]);

  const handleUndoMerge = useCallback(async () => {
    if (!undoToast) return;
    // Undo in reverse order so source-overlap edge cases unwind cleanly.
    const ids = [...undoToast.opIds].reverse();
    for (const opId of ids) {
      try {
        await undoMerge({ db, opId });
      } catch (err) {
        console.warn('[library] undo merge step failed:', err);
      }
    }
  }, [undoToast]);

  const reducedMotion = useReducedMotion();

  // §5.x — Q2 import-celebration trigger. Fires HudCelebration once per
  // newly arrived `importSummary`. We dedupe via a ref so a re-render with
  // the same summary doesn't re-trigger the overlay; the same discipline as
  // the auto-merge toast queue below. `celebrationStats` snapshots series /
  // episode counts at trigger time so the readout doesn't morph mid-fade if
  // the user kicks off another import while this one is still on screen.
  const celebrationConsumedRef = useRef(/** @type {object|null} */ (null));
  const [celebrationKey, setCelebrationKey] = useState(/** @type {number|null} */ (null));
  const [celebrationStats, setCelebrationStats] = useState({ seriesCount: 0, episodeCount: 0 });

  useEffect(() => {
    if (!importSummary || importSummary === celebrationConsumedRef.current) return;
    celebrationConsumedRef.current = importSummary;
    setCelebrationStats({
      seriesCount: series.length,
      episodeCount: series.reduce((sum, sr) => sum + (typeof sr.totalEpisodes === 'number' ? sr.totalEpisodes : 0), 0),
    });
    setCelebrationKey(Date.now());
  }, [importSummary, series]);

  // §5.6 auto-merge toast: when an import detects a series spanning ≥2 folders,
  // show an info-only "已合并" toast (no [撤销] — undoing a cross-folder merge
  // means a split-by-folder op, which is a separate workflow).
  useEffect(() => {
    if (!importSummary || importSummary === consumedSummaryRef.current) return;
    consumedSummaryRef.current = importSummary;
    const merges = importSummary.crossFolderMerges || [];
    if (merges.length === 0) return;

    const entries = merges.map((m) => {
      const sr = series.find((s) => s.id === m.seriesId) ?? null;
      const title =
        sr?.titleZh || sr?.titleEn || sr?.titleJa || m.seriesId;
      const folderLabels = m.folders
        .map((f) => f.split('/').pop() || '/')
        .join(' · ');
      return {
        seriesId: m.seriesId,
        title,
        meta: `来自 ${m.folders.length} 个文件夹 (${folderLabels})`,
      };
    });
    setAutoMergeQueue((q) => [...q, ...entries]);
  }, [importSummary, series]);

  const currentAutoMerge = autoMergeQueue[0] ?? null;

  const handleAutoMergeView = useCallback(() => {
    if (!currentAutoMerge) return;
    navigate('/player', { state: { seriesId: currentAutoMerge.seriesId } });
  }, [currentAutoMerge, navigate]);

  const handleAutoMergeDismiss = useCallback(() => {
    setAutoMergeQueue((q) => q.slice(1));
  }, []);

  const handleSplitConfirm = useCallback(
    async ({ seasonIds, name }) => {
      if (!splitSourceId) return;
      try {
        await splitSeries({
          db,
          sourceSeriesId: splitSourceId,
          seasonIds,
          name,
          ulid,
        });
      } catch (err) {
        console.warn('[library] split failed:', err);
      } finally {
        setSplitSourceId(null);
      }
    },
    [splitSourceId],
  );

  const handleRematchConfirm = useCallback(
    async (payload) => {
      if (!rematchSourceId) return;
      try {
        await rematchSeries({
          db,
          seriesId: rematchSourceId,
          animeId: payload.animeId,
          titleZh: payload.titleZh,
          titleEn: payload.titleEn,
          posterUrl: payload.posterUrl,
          type: payload.type,
          ulid,
        });
      } catch (err) {
        console.warn('[library] rematch failed:', err);
      } finally {
        setRematchSourceId(null);
      }
    },
    [rematchSourceId],
  );

  const handleIgnoreUnclassified = useCallback(async (fileRef) => {
    if (!fileRef?.id) return;
    try {
      await db.fileRefs.delete(fileRef.id);
    } catch (err) {
      console.warn('[library] ignore unclassified failed:', err);
    }
  }, []);

  const handleResetLibrary = useCallback(async () => {
    const ok = window.confirm(
      '清空整个本地库?将删除全部 series / episodes / fileRefs / matchCache / fileHandles / opsLog。\n(磁盘上的视频文件不会被动)'
    );
    if (!ok) return;
    await db.transaction('rw', db.tables, async () => {
      await Promise.all(db.tables.map((tbl) => tbl.clear()));
    });
  }, []);

  // Re-probe all persisted FSA handles. Drives that came back online flip
  // 'disconnected' → 'ready' which re-classifies their series and removes
  // them from the UnavailableSeriesSection. Triggered from the section header
  // button or the same action inside the overflow menu.
  const [availRefreshing, setAvailRefreshing] = useState(false);
  const handleRefreshAvailability = useCallback(async () => {
    if (availRefreshing) return;
    setAvailRefreshing(true);
    try {
      await refreshHandles();
    } catch (err) {
      console.warn('[library] refresh handles failed:', err);
    } finally {
      setAvailRefreshing(false);
    }
  }, [refreshHandles, availRefreshing]);

  // One-click "merge duplicates" — find Series sharing a Season.animeId and
  // merge them into the oldest. Fixes libraries imported before the in-batch
  // dedup landed in importPipeline.
  const [dedupeBusy, setDedupeBusy] = useState(false);
  const handleDedupe = useCallback(async () => {
    if (dedupeBusy) return;
    setDedupeBusy(true);
    try {
      const result = await dedupeSeriesByAnimeId({ db });
      if (result.groups === 0) {
        toast.success('库里没有重复的系列');
      } else if (result.merged === 0) {
        toast(`检测到 ${result.groups} 组重复但都已合并过 (skip ${result.skipped})`);
      } else {
        toast.success(`合并 ${result.merged} 项 · 共 ${result.groups} 组重复`);
        if (result.opIds.length > 0) {
          setUndoToast({
            opIds: result.opIds,
            title: `合并重复 (${result.merged} 项)`,
            meta: `${result.groups} 组 · 同 animeId`,
          });
        }
      }
    } catch (err) {
      console.warn('[library] dedupe failed:', err);
      toast.error('合并失败,请重试');
    } finally {
      setDedupeBusy(false);
    }
  }, [dedupeBusy]);

  // Refresh enrichment (titleZh/titleEn/posterUrl) for every series in the
  // library. Pre-2026-05 imports lack these fields because the dandan client
  // wasn't forwarding enrichment — this is the in-place fix that keeps
  // seriesId stable so progress / overrides / opsLog all survive.
  const [refreshingMeta, setRefreshingMeta] = useState(false);
  const handleRefreshMetadata = useCallback(async () => {
    if (refreshingMeta) return;
    setRefreshingMeta(true);
    const toastId = toast.loading(
      fmtTpl(t('library.refreshMetaProgress'), { done: 0, total: series.length }),
    );
    try {
      const summary = await refreshAllSeriesMetadata({
        db,
        dandan,
        onProgress: (done, total, last) => {
          // Per-series detail logging makes the no-change case debuggable
          // without a build-and-redeploy cycle. Cheap — runs N times for
          // small N (library count), never inside a hot loop.
          console.log('[refresh-meta]', last);
          toast.loading(
            fmtTpl(t('library.refreshMetaProgress'), { done, total }),
            { id: toastId },
          );
        },
      });

      // Group skipReasons so the user sees *why* nothing changed (no-fileref
      // means hash16M was never persisted; no-match means dandanplay couldn't
      // identify the file; no-enrichment means matched but server returned
      // no titleChinese/coverImageUrl).
      /** @type {Record<string, number>} */
      const reasonCounts = {};
      for (const r of summary.results) {
        if (r.changed) continue;
        const key = r.skipReason || 'unknown';
        reasonCounts[key] = (reasonCounts[key] || 0) + 1;
      }
      const reasonStr = Object.entries(reasonCounts)
        .map(([k, v]) => `${k}:${v}`)
        .join(' / ');

      console.log('[refresh-meta] summary:', summary);

      if (summary.changed === 0) {
        toast.success(
          `${t('library.refreshMetaNothing')}${reasonStr ? ` · ${reasonStr}` : ''}`,
          { id: toastId, duration: 6000 },
        );
      } else {
        toast.success(
          fmtTpl(t('library.refreshMetaDone'), {
            changed: summary.changed,
            total: summary.total,
          }) + (reasonStr ? ` · ${reasonStr}` : ''),
          { id: toastId, duration: 6000 },
        );
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      toast.error(
        fmtTpl(t('library.refreshMetaFailed'), { error: errMsg }),
        { id: toastId },
      );
    } finally {
      setRefreshingMeta(false);
    }
  }, [refreshingMeta, series.length, dandan, t]);

  const showEmptyState = !loading && series.length === 0;
  const showBanner = !fsaSupported;
  const totalEpisodes = useMemo(
    () => series.reduce((sum, sr) => sum + (typeof sr.totalEpisodes === 'number' ? sr.totalEpisodes : 0), 0),
    [series],
  );

  return (
    <div style={s.page}>
      <style>{PRIVACY_PULSE_CSS}</style>
      {showBanner && <FsaUnsupportedBanner />}

      {selection.selectionMode ? (
        <BulkActionToolbar
          count={selection.count}
          onCancel={selection.clear}
          onSelectAll={handleSelectAllVisible}
          onMerge={handleBulkMerge}
          onDelete={handleBulkDelete}
        />
      ) : (
        <motion.header
          style={s.hudHeader}
          data-testid="library-hud-header"
          initial={reducedMotion ? false : { opacity: 0, y: 6 }}
          animate={reducedMotion ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
        >
          <CornerBrackets inset={-8} size={14} opacity={0.30} />
          <div style={s.hudHeaderInner}>
            <div style={s.hudKicker}>// 02 / LOCAL · MEDIA · LIBRARY //</div>
            <h1 style={s.hudTitle}>
              <span>{t('nav.library')}{` ${LOCAL_HEX_GLYPH}`}</span>
              <span style={s.hudTitleEn}>LIBRARY</span>
            </h1>
            <div style={s.hudSubtitle}>
              <span><StatNum value={series.length} delay={0.20} style={s.hudNum} />&nbsp;series</span>
              {totalEpisodes > 0 && (
                <>
                  <span style={s.hudDot}>·</span>
                  <span><StatNum value={totalEpisodes} delay={0.30} style={s.hudNum} />&nbsp;episodes</span>
                </>
              )}
              <span style={s.hudDot}>·</span>
              <span style={s.hudPrivacy}>
                <span aria-hidden style={s.hudPrivacyDot} />
                stored on this device
              </span>
            </div>
            <div style={{ marginTop: 12 }}>
              <WatchRhythmStrip rhythm={watchRhythm} compact />
            </div>
          </div>
          <div style={s.hudActions}>
            {showAddBtn && (
              <button
                style={s.addBtn}
                onClick={handleAddFolder}
                type="button"
                data-testid="library-add-folder"
              >
                + {t('library.addFolder')}
              </button>
            )}
            {series.length > 0 && (
              <HudOverflowMenu
                testId="library-overflow"
                ariaLabel={t('library.overflow.moreActions')}
                items={[
                  ...(series.length > 1 ? [{
                    id: 'dedupe',
                    label: dedupeBusy
                      ? t('library.overflow.dedupeBusy')
                      : t('library.overflow.dedupe'),
                    onClick: handleDedupe,
                    disabled: dedupeBusy,
                    icon: '⇄',
                    testId: 'library-dedupe',
                  }] : []),
                  {
                    id: 'refresh-meta',
                    label: refreshingMeta
                      ? t('library.overflow.refreshMetaBusy')
                      : t('library.refreshMeta'),
                    onClick: handleRefreshMetadata,
                    disabled: refreshingMeta,
                    icon: '↻',
                    testId: 'library-refresh-meta',
                  },
                  {
                    id: 'refresh-availability',
                    label: availRefreshing
                      ? t('library.overflow.refreshAvailBusy')
                      : t('library.overflow.refreshAvail'),
                    onClick: handleRefreshAvailability,
                    disabled: availRefreshing,
                    icon: '⌐',
                    testId: 'library-refresh-availability',
                  },
                  {
                    id: 'reset',
                    label: t('library.overflow.reset'),
                    onClick: handleResetLibrary,
                    danger: true,
                    divideBefore: true,
                    icon: '⊘',
                    testId: 'library-reset',
                  },
                ]}
              />
            )}
          </div>
        </motion.header>
      )}

      {showEmptyState ? (
        fsaSupported ? (
          <DropZone onPick={handleAddFolder} isFsaSupported={fsaSupported} />
        ) : (
          <LibraryEmptyState
            onAddFolder={handleAddFolder}
            isFsaSupported={fsaSupported}
          />
        )
      ) : (
        <>
          {series.length >= ROWS_THRESHOLD && (
            availabilityReady ? (
              <>
                <RecentlyPlayedPosterRow
                  entries={resumeEntries}
                  onPlay={handleResume}
                  availabilityBySeries={availabilityBySeries}
                />
                <NewAdditionsRow
                  series={series}
                  onPickSeries={handlePickSeries}
                  availabilityBySeries={availabilityBySeries}
                />
              </>
            ) : (
              <>
                <ScrollRow label="// 继续看 //" testId="row-recently-played-skeleton">
                  {Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
                    <SeriesCardSkeleton key={`rp-skel-${i}`} compact />
                  ))}
                </ScrollRow>
                <ScrollRow label="// 最近添加 //" testId="row-new-additions-skeleton">
                  {Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
                    <SeriesCardSkeleton key={`na-skel-${i}`} compact />
                  ))}
                </ScrollRow>
              </>
            )
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <FilterChips
              active={activeFilter}
              counts={filterCounts}
              onChange={setActiveFilter}
            />
            <span style={{ flex: 1 }} />
            <SearchBar
              ref={searchRef}
              value={searchQuery}
              onChange={setSearchQuery}
            />
          </div>
          {!availabilityReady ? (
            <div style={SKELETON_GRID_STYLE} data-testid="library-grid-skeleton">
              {Array.from({ length: SKELETON_GRID_COUNT }).map((_, i) => (
                <SeriesCardSkeleton key={`grid-skel-${i}`} />
              ))}
            </div>
          ) : (activeFilter || searchQuery) && mainGridSeries.length === 0 ? (
            <div
              style={{
                ...mono,
                padding: '32px 16px',
                textAlign: 'center',
                color: 'rgba(235,235,245,0.45)',
                fontSize: 11,
                letterSpacing: '0.10em',
                textTransform: 'uppercase',
                border: `1px dashed oklch(46% 0.06 ${HUE} / 0.30)`,
                borderRadius: 4,
              }}
              data-testid="library-filter-empty"
            >
              {'// NO MATCHES //'}
            </div>
          ) : (
            <SeriesGrid
              series={mainGridSeries}
              onPickSeries={handlePickSeries}
              overrides={overrides}
              progressMap={progressMap}
              onOverrideAction={handleOverrideAction}
              selectionMode={selection.selectionMode}
              selectedIds={new Set(selection.ids)}
              onToggleSelect={(id) => selection.toggle(id)}
              onLongPress={(id) => selection.toggle(id)}
              availabilityBySeries={availabilityBySeries}
            />
          )}
          <UnavailableSeriesSection
            series={unavailableSeries}
            availabilityBySeries={availabilityBySeries}
            onRefresh={handleRefreshAvailability}
            onPickSeries={handlePickSeries}
            onDelete={(seriesId) => handleOverrideAction(seriesId, 'delete')}
            refreshing={availRefreshing}
          />
          <UnclassifiedSection
            entries={unclassifiedEntries}
            defaultOpen
            onIgnore={handleIgnoreUnclassified}
          />
        </>
      )}

      {!importDismissed && importStatus !== 'idle' && (
        <ImportDrawer
          status={importStatus}
          progress={importProgress}
          summary={importSummary}
          error={importError}
          onCancel={cancelImport}
          onDismiss={() => setImportDismissed(true)}
        />
      )}

      {importDismissed && (
        <ImportMiniPill
          status={importStatus}
          progress={importProgress}
          summary={importSummary}
          onExpand={() => setImportDismissed(false)}
        />
      )}

      {mergeSource && (
        <MergeDialog
          open
          sourceSeries={mergeSource}
          allSeries={series}
          onClose={() => setMergeSourceId(null)}
          onConfirm={handleMergeConfirm}
        />
      )}

      {splitSource && (
        <SplitDialog
          open
          sourceSeries={splitSource}
          seasons={splitSeasons}
          onClose={() => setSplitSourceId(null)}
          onConfirm={handleSplitConfirm}
        />
      )}

      {rematchSource && (
        <RematchDialog
          open
          sourceSeries={rematchSource}
          onClose={() => setRematchSourceId(null)}
          onConfirm={handleRematchConfirm}
        />
      )}

      <HudCelebration
        triggerKey={celebrationKey}
        seriesCount={celebrationStats.seriesCount}
        episodeCount={celebrationStats.episodeCount}
        onComplete={() => setCelebrationKey(null)}
      />

      {detailSeriesId && (() => {
        const target = series.find((sr) => sr.id === detailSeriesId);
        if (!target) return null;
        return (
          <SeriesDetailSheet
            series={target}
            onClose={() => setDetailSeriesId(null)}
            onPickEpisode={handlePickEpisode}
            onPlaySeries={handlePlaySeries}
          />
        );
      })()}

      {undoToast ? (
        <UndoToast
          open
          title={undoToast.title}
          meta={undoToast.meta}
          onUndo={handleUndoMerge}
          onDismiss={() => setUndoToast(null)}
        />
      ) : currentAutoMerge ? (
        <UndoToast
          open
          key={currentAutoMerge.seriesId}
          testId="auto-merge-toast"
          title={currentAutoMerge.title}
          meta={currentAutoMerge.meta}
          onView={handleAutoMergeView}
          onDismiss={handleAutoMergeDismiss}
        />
      ) : null}
    </div>
  );
}
