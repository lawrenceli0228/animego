// @ts-check
import { useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import useLibrary from '../hooks/useLibrary';
import useFileHandles from '../hooks/useFileHandles';
import useImport from '../hooks/useImport';
import useVideoFiles from '../hooks/useVideoFiles';
import { isFsaSupported } from '../lib/library/handles/fsaFeatureCheck.js';
import { collectFromHandle } from '../lib/library/handleTraversal/index.js';
import LibraryEmptyState from '../components/library/LibraryEmptyState';
import FsaUnsupportedBanner from '../components/library/FsaUnsupportedBanner';
import SeriesGrid from '../components/library/SeriesGrid';
import RecentlyPlayedRow from '../components/library/RecentlyPlayedRow';
import { useLang } from '../context/LanguageContext';
import { mono, PLAYER_HUE } from '../components/shared/hud-tokens';

/** Lazy DB singleton — only instantiated when the page mounts */
let _db = null;
function getDb() {
  if (!_db) {
    const { makeDb } = require('../lib/library/db/makeDb.js');
    _db = makeDb();
  }
  return _db;
}

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

  // Deferred DB init to avoid IDB churn in tests (tests mock the hooks)
  const dbRef = useRef(/** @type {any} */ (null));
  function requireDb() {
    if (!dbRef.current) {
      // Dynamic import avoided intentionally — IDB via Dexie is sync-init
      // In tests these hooks are mocked so this branch is never reached
      try {
        const { makeDb } = require('../lib/library/db/makeDb.js');
        dbRef.current = makeDb();
      } catch {
        dbRef.current = null;
      }
    }
    return dbRef.current;
  }

  const db = requireDb();

  const dandanStub = { match: async () => null };
  const { series, loading } = useLibrary({ db: db || {} });
  const { status, roots, pickFolder } = useFileHandles({ db: db || {} });
  const { run: runImport, status: importStatus } = useImport({ db: db || {}, dandan: dandanStub });
  const { processFiles } = useVideoFiles();

  /** Whether to show the add-folder header button (FSA + has series already) */
  const showAddBtn = fsaSupported && series.length > 0;

  const handleAddFolder = useCallback(async () => {
    if (!fsaSupported || !db) return;

    // libraryId is generated inside pickFolder; we need the returned record
    const { ulid } = await import('../lib/library/ulid.js');
    const libraryId = ulid();
    const record = await pickFolder(libraryId);
    if (!record) return;

    const collected = await collectFromHandle(record.handle);
    const allFiles = collected.map(({ file }) => file);
    const { files: items } = processFiles(allFiles);
    await runImport({ items, libraryId: record.libraryId });
  }, [fsaSupported, db, pickFolder, processFiles, runImport]);

  const handlePickSeries = useCallback((id) => {
    navigate('/player', { state: { seriesId: id } });
  }, [navigate]);

  const showEmptyState = !loading && series.length === 0;
  const showBanner = !fsaSupported;

  return (
    <div style={s.page}>
      {showBanner && <FsaUnsupportedBanner />}

      <div style={s.header}>
        <h1 style={s.title}>Library</h1>
        {showAddBtn && (
          <button style={s.addBtn} onClick={handleAddFolder} type="button">
            {t('library.addFolder')}
          </button>
        )}
      </div>

      {showEmptyState ? (
        <LibraryEmptyState
          onAddFolder={handleAddFolder}
          isFsaSupported={fsaSupported}
        />
      ) : (
        <>
          <RecentlyPlayedRow entries={[]} onPlay={() => {}} />
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
