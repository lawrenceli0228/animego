// @ts-check
import { useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import useLibrary from '../hooks/useLibrary';
import useResume from '../hooks/useResume';
import useFileHandles from '../hooks/useFileHandles';
import useImport from '../hooks/useImport';
import useVideoFiles from '../hooks/useVideoFiles';
import { isFsaSupported } from '../lib/library/handles/fsaFeatureCheck.js';
import { enumerateAll } from '../lib/library/enumerator.js';
import { db } from '../lib/library/db/db.js';
import { migrateLegacyProgress } from '../lib/library/db/migrateLegacyProgress.js';
import { ulid } from '../lib/library/ulid.js';
import LibraryEmptyState from '../components/library/LibraryEmptyState';
import FsaUnsupportedBanner from '../components/library/FsaUnsupportedBanner';
import SeriesGrid from '../components/library/SeriesGrid';
import RecentlyPlayedRow from '../components/library/RecentlyPlayedRow';
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
  toast: {
    ...mono,
    position: 'fixed',
    bottom: 24,
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '8px 18px',
    background: `oklch(18% 0.04 ${HUE})`,
    border: `1px solid oklch(62% 0.17 ${HUE} / 0.40)`,
    borderRadius: 4,
    color: `oklch(72% 0.15 ${HUE})`,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.10em',
    pointerEvents: 'none',
    zIndex: 9999,
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
  const { run: runImport, status: importStatus } = useImport({ db, dandan: dandanStub });
  const { processFiles } = useVideoFiles();

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
    await runImport({ items, libraryId: record.libraryId });
  }, [fsaSupported, pickFolder, processFiles, runImport]);

  const handlePickSeries = useCallback((id) => {
    navigate('/player', { state: { seriesId: id } });
  }, [navigate]);

  const handleResume = useCallback((id, episodeNumber) => {
    navigate('/player', { state: { seriesId: id, resumeEpisode: episodeNumber } });
  }, [navigate]);

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

      {showEmptyState ? (
        <LibraryEmptyState
          onAddFolder={handleAddFolder}
          isFsaSupported={fsaSupported}
        />
      ) : (
        <>
          <RecentlyPlayedRow entries={resumeEntries} onPlay={handleResume} />
          <SeriesGrid series={series} onPickSeries={handlePickSeries} />
        </>
      )}

      {importStatus === 'running' && (
        <div style={s.toast} aria-live="polite">Importing…</div>
      )}
      {importStatus === 'done' && (
        <div style={s.toast} aria-live="polite">Import complete</div>
      )}
    </div>
  );
}
