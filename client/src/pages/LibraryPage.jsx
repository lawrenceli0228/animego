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
import { applySeriesFilter } from '../lib/library/seriesFilter.js';
import { db } from '../lib/library/db/db.js';
import { migrateLegacyProgress } from '../lib/library/db/migrateLegacyProgress.js';
import { ulid } from '../lib/library/ulid.js';
import LibraryEmptyState from '../components/library/LibraryEmptyState';
import FsaUnsupportedBanner from '../components/library/FsaUnsupportedBanner';
import SeriesGrid from '../components/library/SeriesGrid';
import FilterChips from '../components/library/FilterChips';
import RecentlyPlayedRow from '../components/library/RecentlyPlayedRow';
import MergeDialog from '../components/library/MergeDialog';
import SplitDialog from '../components/library/SplitDialog';
import RematchDialog from '../components/library/RematchDialog';
import ImportDrawer from '../components/library/ImportDrawer';
import UnclassifiedSection from '../components/library/UnclassifiedSection';
import useUnclassified from '../hooks/useUnclassified';
import useSeriesSelection from '../hooks/useSeriesSelection.js';
import BulkActionToolbar from '../components/library/BulkActionToolbar';
import UndoToast from '../components/shared/UndoToast';
import { splitSeries } from '../services/splitSeries.js';
import { rematchSeries } from '../services/rematchSeries.js';
import { performMerge, undoMerge } from '../services/mergeOps.js';
import { useLang } from '../context/LanguageContext';
import { mono, PLAYER_HUE } from '../components/shared/hud-tokens';

const HUE = PLAYER_HUE.stream;

const s = {
  page: {
    maxWidth: 1120,
    margin: '0 auto',
    padding: '32px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: 24,
  },
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

  const dandanStub = { match: async () => null };
  const { series, loading } = useLibrary({ db });
  const { entries: resumeEntries } = useResume({ db });
  const { status, roots, pickFolder } = useFileHandles({ db });
  const {
    run: runImport,
    progress: importProgress,
    summary: importSummary,
    status: importStatus,
    error: importError,
    cancel: cancelImport,
  } = useImport({ db, dandan: dandanStub });
  const [importDismissed, setImportDismissed] = useState(false);
  const { processFiles } = useVideoFiles();
  const { all: overrides, lock, unlock, clear } = useUserOverride({ db });
  const { entries: unclassifiedEntries } = useUnclassified({ db });
  const { map: progressMap } = useSeriesProgressMap({ db });
  const [activeFilter, setActiveFilter] = useState(/** @type {import('../components/library/FilterChips').LibraryFilter} */ (null));
  const [mergeSourceId, setMergeSourceId] = useState(/** @type {string|null} */ (null));
  const [splitSourceId, setSplitSourceId] = useState(/** @type {string|null} */ (null));
  const [splitSeasons, setSplitSeasons] = useState(/** @type {any[]} */ ([]));
  const [rematchSourceId, setRematchSourceId] = useState(/** @type {string|null} */ (null));
  const [undoToast, setUndoToast] = useState(/** @type {{ opIds: string[], title: string, meta?: string }|null} */ (null));
  const [autoMergeQueue, setAutoMergeQueue] = useState(
    /** @type {Array<{ seriesId: string, title: string, meta: string }>} */ ([]),
  );
  // Track the last importSummary we converted into auto-merge toasts so a
  // re-render with the same summary object doesn't re-enqueue toasts. The
  // useImport hook keeps a stable reference until the next import begins.
  const consumedSummaryRef = useRef(/** @type {object|null} */ (null));
  const selection = useSeriesSelection();

  const visibleSeries = useMemo(
    () => applySeriesFilter(series, progressMap, activeFilter),
    [series, progressMap, activeFilter],
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
    navigate(`/library/${id}`);
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
      } catch (err) {
        console.warn(`[library] override action ${action} failed:`, err);
      }
    },
    [lock, unlock, clear],
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
    navigate(`/library/${currentAutoMerge.seriesId}`);
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

  const showEmptyState = !loading && series.length === 0;
  const showBanner = !fsaSupported;

  return (
    <div style={s.page}>
      {showBanner && <FsaUnsupportedBanner />}

      {selection.selectionMode ? (
        <BulkActionToolbar
          count={selection.count}
          onCancel={selection.clear}
          onSelectAll={handleSelectAllVisible}
          onMerge={handleBulkMerge}
        />
      ) : (
        <div style={s.header}>
          <h1 style={s.title}>Library</h1>
          <div style={s.headerActions}>
            {series.length > 0 && (
              <button style={s.resetBtn} onClick={handleResetLibrary} type="button">
                重置库
              </button>
            )}
            {showAddBtn && (
              <button style={s.addBtn} onClick={handleAddFolder} type="button">
                {t('library.addFolder')}
              </button>
            )}
          </div>
        </div>
      )}

      {showEmptyState ? (
        <LibraryEmptyState
          onAddFolder={handleAddFolder}
          isFsaSupported={fsaSupported}
        />
      ) : (
        <>
          <RecentlyPlayedRow entries={resumeEntries} onPlay={handleResume} />
          <FilterChips active={activeFilter} onChange={setActiveFilter} />
          {activeFilter && visibleSeries.length === 0 ? (
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
              series={visibleSeries}
              onPickSeries={handlePickSeries}
              overrides={overrides}
              progressMap={progressMap}
              onOverrideAction={handleOverrideAction}
              selectionMode={selection.selectionMode}
              selectedIds={new Set(selection.ids)}
              onToggleSelect={(id) => selection.toggle(id)}
              onLongPress={(id) => selection.toggle(id)}
            />
          )}
          <UnclassifiedSection
            entries={unclassifiedEntries}
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
