// @ts-check
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useSeriesDetail from '../hooks/useSeriesDetail';
import useFileHandles from '../hooks/useFileHandles';
import useLibrary from '../hooks/useLibrary';
import useSiteAnimeForSeries from '../hooks/useSiteAnimeForSeries';
import { db } from '../lib/library/db/db.js';
import { makeProgressRepo } from '../lib/library/db/progressRepo.js';
import { ulid } from '../lib/library/ulid.js';
import { buildLibraryMatchResult } from '../lib/library/buildLibraryMatchResult.js';
import { mono, PLAYER_HUE } from '../components/shared/hud-tokens';
import EpisodeFileList from '../components/player/EpisodeFileList';
import DanmakuPicker from '../components/player/DanmakuPicker';
import MergeDialog from '../components/library/MergeDialog';
import SplitDialog from '../components/library/SplitDialog';
import RematchDialog from '../components/library/RematchDialog';
import SeriesActionsMenu from '../components/library/SeriesActionsMenu';
import OpsLogDrawer from '../components/library/OpsLogDrawer';
import UndoToast from '../components/shared/UndoToast';
import { performMerge, undoMerge } from '../services/mergeOps.js';
import { splitSeries } from '../services/splitSeries.js';
import { rematchSeries } from '../services/rematchSeries.js';
import { deleteSeriesCascade } from '../services/deleteSeries.js';
import { makeOpsLogRepo } from '../lib/library/db/opsLogRepo.js';
import toast from 'react-hot-toast';

/** @typedef {import('../lib/library/types').Progress} Progress */

const HUE = PLAYER_HUE.local;

const s = {
  page: {
    maxWidth: 1120,
    margin: '0 auto',
    padding: '24px 24px 48px',
    display: 'flex',
    flexDirection: 'column',
    gap: 24,
    color: '#fff',
  },
  topbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  topbarSpacer: {
    flex: 1,
  },
  backBtn: {
    ...mono,
    padding: '6px 12px',
    background: 'transparent',
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.50)`,
    borderRadius: 3,
    color: 'rgba(235,235,245,0.85)',
    cursor: 'pointer',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
  },
  sectionLabel: {
    ...mono,
    fontSize: 10,
    color: 'rgba(235,235,245,0.45)',
    textTransform: 'uppercase',
    letterSpacing: '0.15em',
  },
  folderTree: {
    ...mono,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    fontSize: 11,
    color: 'rgba(235,235,245,0.55)',
    padding: 12,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.20)`,
    borderRadius: 4,
  },
  folderGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
  },
  folderRow: {
    ...mono,
    fontSize: 11,
    color: 'rgba(235,235,245,0.85)',
    padding: '2px 0',
    letterSpacing: '0.04em',
  },
  fileRow: {
    ...mono,
    display: 'grid',
    gridTemplateColumns: '14px 36px 1fr 16px',
    alignItems: 'center',
    gap: 8,
    fontSize: 10.5,
    color: 'rgba(235,235,245,0.55)',
    padding: '2px 0 2px 12px',
  },
  fileBranch: {
    color: 'rgba(235,235,245,0.30)',
    textAlign: 'center',
  },
  fileEpBadge: {
    color: `oklch(72% 0.15 ${HUE})`,
    letterSpacing: '0.06em',
  },
  fileName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  watchedMark: {
    color: `oklch(70% 0.16 ${HUE})`,
    textAlign: 'center',
  },
  emptyState: {
    ...mono,
    fontSize: 12,
    color: 'rgba(235,235,245,0.55)',
    textAlign: 'center',
    padding: 32,
  },
};

function pickTitle(series) {
  return (
    series?.titleZh ||
    series?.titleEn ||
    series?.titleJa ||
    series?.id ||
    ''
  );
}

/**
 * LocalSeriesPage — series detail for a locally-imported series.
 *
 * URL: /library/:seriesId
 *
 * Renders the same rich EpisodeFileList that the player uses post-match, so
 * the user sees one consistent surface whether they came from import or from
 * the library grid. The file-tree breakdown stays below for folder-level
 * context the EpisodeFileList doesn't show.
 *
 * Click EP → /player with `state.seriesId + resumeEpisode`.
 * DANMAKU button → local DanmakuPicker; confirm writes the new dandanEpisodeId
 * back to the IDB Episode record so the next play picks it up.
 */
export default function LocalSeriesPage() {
  const navigate = useNavigate();
  const { seriesId } = useParams();
  const fileHandles = useFileHandles({ db });
  const seriesDetail = useSeriesDetail(seriesId ?? null, { db, fileHandles });
  const { status, series, episodes, fileRefByEpisode, refresh } = seriesDetail;

  const libraryMatchResult = useMemo(
    () => buildLibraryMatchResult(seriesDetail),
    [seriesDetail],
  );

  // Fetch siteAnime (rich AniList metadata) by re-searching dandanplay with the
  // series title. Slot it into libraryMatchResult so EpisodeFileList renders
  // the same site-info row (score / format / season / studios / genres) the
  // post-match drop-zone flow shows.
  const { data: siteAnime, loading: siteAnimeLoading } = useSiteAnimeForSeries({ series });
  const enrichedMatchResult = useMemo(() => {
    if (!libraryMatchResult) return null;
    if (!siteAnime) return libraryMatchResult;
    return { ...libraryMatchResult, siteAnime };
  }, [libraryMatchResult, siteAnime]);

  const [progressByEp, setProgressByEp] = useState(/** @type {Map<string, Progress>} */ (new Map()));

  useEffect(() => {
    if (!seriesId) return undefined;
    let cancelled = false;
    const repo = makeProgressRepo(db);
    repo
      .getBySeries(seriesId)
      .then((rows) => {
        if (cancelled) return;
        const m = new Map();
        for (const p of rows) m.set(p.episodeId, p);
        setProgressByEp(m);
      })
      .catch(() => {
        if (!cancelled) setProgressByEp(new Map());
      });
    return () => { cancelled = true; };
  }, [seriesId, episodes]);

  // §5.6 file tree — Array<[folder, files[]]>. Files sorted by epNumber, folders alpha.
  const filesByFolder = useMemo(() => {
    /** @type {Map<string, { epId: string, epNumber: number, fileName: string, watched: boolean }[]>} */
    const folders = new Map();
    for (const ep of episodes) {
      const ref = fileRefByEpisode.get(ep.id);
      if (!ref) continue;
      const slash = ref.relPath.lastIndexOf('/');
      const dir = slash >= 0 ? ref.relPath.slice(0, slash) : '(根)';
      const fileName = slash >= 0 ? ref.relPath.slice(slash + 1) : ref.relPath;
      if (!folders.has(dir)) folders.set(dir, []);
      folders.get(dir).push({
        epId: ep.id,
        epNumber: ep.number,
        fileName,
        watched: !!progressByEp.get(ep.id)?.completed,
      });
    }
    const entries = Array.from(folders.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [, files] of entries) files.sort((a, b) => a.epNumber - b.epNumber);
    return entries;
  }, [episodes, fileRefByEpisode, progressByEp]);

  const handleBack = useCallback(() => {
    navigate('/library');
  }, [navigate]);

  // EpisodeFileList click → jump straight into the player with a resume hint.
  const handlePlayItem = useCallback((fileItem) => {
    if (!seriesId) return;
    navigate('/player', {
      state: { seriesId, resumeEpisode: fileItem.episode },
    });
  }, [navigate, seriesId]);

  // DanmakuPicker for the EpisodeFileList rows (// DANMAKU // button).
  // We mount it locally rather than navigating to the player because users
  // often want to fix mismatched danmaku before pressing play.
  const [pickerEp, setPickerEp] = useState(/** @type {number|null} */ (null));

  const handleDanmakuConfirm = useCallback(
    async (data, _newAnime) => {
      if (pickerEp == null || !data?.dandanEpisodeId) {
        setPickerEp(null);
        return;
      }
      // Persist new dandanEpisodeId on the matching IDB Episode row so next
      // play() picks it up. Match by number, skipping kinds that don't own
      // the danmaku slot ('sp' has its own picker flow; 'commentary' inherits
      // from the main cut and must not be redirected here).
      const target = episodes.find((e) => e.number === pickerEp && e.kind !== 'sp' && e.kind !== 'commentary');
      if (!target) {
        setPickerEp(null);
        return;
      }
      try {
        await db.episodes.update(target.id, {
          episodeId: data.dandanEpisodeId,
          updatedAt: Date.now(),
        });
        refresh();
        toast.success('弹幕来源已更新');
      } catch (err) {
        console.warn('[localseries] failed to update episode danmaku id:', err);
        toast.error('更新失败');
      } finally {
        setPickerEp(null);
      }
    },
    [pickerEp, episodes, refresh],
  );

  // §5.6 Actions menu — 详情页是移动端唯一管理入口。共享 LibraryPage 的 dialog/服务/撤销。
  const { series: allSeries } = useLibrary({ db });
  const [activeDialog, setActiveDialog] = useState(
    /** @type {'merge'|'split'|'rematch'|'opslog'|null} */ (null),
  );
  const [splitSeasons, setSplitSeasons] = useState(/** @type {any[]} */ ([]));
  const [opsLogEntries, setOpsLogEntries] = useState(/** @type {any[]} */ ([]));
  const [undoToast, setUndoToast] = useState(
    /** @type {{ opIds: string[], title: string, meta?: string }|null} */ (null),
  );

  // SplitDialog seasons — load on demand, clear on close (mirrors LibraryPage).
  useEffect(() => {
    if (activeDialog !== 'split' || !seriesId) {
      setSplitSeasons([]);
      return undefined;
    }
    let cancelled = false;
    db.seasons
      .where('seriesId')
      .equals(seriesId)
      .toArray()
      .then((rows) => { if (!cancelled) setSplitSeasons(rows); })
      .catch((err) => {
        if (!cancelled) {
          console.warn('[localseries] failed to load seasons for split:', err);
          setSplitSeasons([]);
        }
      });
    return () => { cancelled = true; };
  }, [activeDialog, seriesId]);

  // 24h ops log — load on demand, clear on close.
  useEffect(() => {
    if (activeDialog !== 'opslog' || !seriesId) {
      setOpsLogEntries([]);
      return undefined;
    }
    let cancelled = false;
    makeOpsLogRepo(db)
      .listForSeries(seriesId, { limit: 50 })
      .then((rows) => { if (!cancelled) setOpsLogEntries(rows); })
      .catch((err) => {
        if (!cancelled) {
          console.warn('[localseries] failed to load opsLog:', err);
          setOpsLogEntries([]);
        }
      });
    return () => { cancelled = true; };
  }, [activeDialog, seriesId]);

  const closeDialog = useCallback(() => setActiveDialog(null), []);

  const handleMergeConfirm = useCallback(
    async (targetSeriesId) => {
      if (!seriesId || !series || seriesId === targetSeriesId) {
        setActiveDialog(null);
        return;
      }
      const targetSeries = allSeries.find((sr) => sr.id === targetSeriesId) ?? null;
      const targetTitle = pickTitle(targetSeries) || targetSeriesId;
      const sourceTitle = pickTitle(series) || seriesId;
      try {
        const op = await performMerge({
          db,
          sourceSeriesId: seriesId,
          targetSeriesId,
          summary: { targetTitle, sourceTitle },
        });
        if (op) {
          setUndoToast({ opIds: [op.id], title: targetTitle, meta: `从 ${sourceTitle} 合并` });
          // Source vanishes after merge — navigate so back-button stays sane.
          navigate('/player', { state: { seriesId: targetSeriesId }, replace: true });
        }
      } catch (err) {
        console.warn('[localseries] merge failed:', err);
      } finally {
        setActiveDialog(null);
      }
    },
    [seriesId, series, allSeries, navigate],
  );

  const handleSplitConfirm = useCallback(async ({ seasonIds, name }) => {
    if (!seriesId) return;
    try {
      await splitSeries({ db, sourceSeriesId: seriesId, seasonIds, name, ulid });
    } catch (err) {
      console.warn('[localseries] split failed:', err);
    } finally {
      setActiveDialog(null);
    }
  }, [seriesId]);

  const handleRematchConfirm = useCallback(async (payload) => {
    if (!seriesId) return;
    try {
      await rematchSeries({
        db,
        seriesId,
        animeId: payload.animeId,
        titleZh: payload.titleZh,
        titleEn: payload.titleEn,
        posterUrl: payload.posterUrl,
        type: payload.type,
        ulid,
      });
    } catch (err) {
      console.warn('[localseries] rematch failed:', err);
    } finally {
      setActiveDialog(null);
    }
  }, [seriesId]);

  const handleUndoMerge = useCallback(async () => {
    if (!undoToast) return;
    for (const opId of [...undoToast.opIds].reverse()) {
      try {
        await undoMerge({ db, opId });
      } catch (err) {
        console.warn('[localseries] undo merge failed:', err);
      }
    }
  }, [undoToast]);

  const handleDelete = useCallback(async () => {
    if (!seriesId || !series) return;
    const title = pickTitle(series) || seriesId;
    const ok = window.confirm(
      `从库里删除「${title}」?\n\n会清掉本地的元数据 / 进度 / 覆盖,但磁盘上的视频文件不会被动。`,
    );
    if (!ok) return;
    try {
      await deleteSeriesCascade({ db, seriesId });
      toast.success(`已删除「${title}」`);
      navigate('/library');
    } catch (err) {
      console.warn('[localseries] delete failed:', err);
      toast.error('删除失败,请重试');
    }
  }, [seriesId, series, navigate]);

  if (status === 'loading' || status === 'idle') {
    return (
      <div style={s.page}>
        <div style={s.topbar}>
          <button style={s.backBtn} onClick={handleBack} type="button">← 返回</button>
        </div>
        <div style={s.emptyState} data-testid="loading-state">载入中…</div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div style={s.page}>
        <div style={s.topbar}>
          <button style={s.backBtn} onClick={handleBack} type="button">← 返回</button>
        </div>
        <div style={s.emptyState} data-testid="error-state">载入失败,请重试</div>
      </div>
    );
  }

  if (status === 'missing' || !series || !libraryMatchResult) {
    return (
      <div style={s.page}>
        <div style={s.topbar}>
          <button style={s.backBtn} onClick={handleBack} type="button">← 返回</button>
        </div>
        <div style={s.emptyState} data-testid="missing-state">该系列不存在或已被删除</div>
      </div>
    );
  }

  return (
    <div style={s.page}>
      <div style={s.topbar}>
        <button style={s.backBtn} onClick={handleBack} type="button" data-testid="back-btn">
          ← 返回
        </button>
        <div style={s.topbarSpacer} />
        <SeriesActionsMenu
          onMerge={() => setActiveDialog('merge')}
          onSplit={() => setActiveDialog('split')}
          onRematch={() => setActiveDialog('rematch')}
          onOpsLog={() => setActiveDialog('opslog')}
          onDelete={handleDelete}
        />
      </div>

      <div data-testid="series-list">
        <EpisodeFileList
          anime={enrichedMatchResult.anime}
          siteAnime={enrichedMatchResult.siteAnime}
          episodeMap={enrichedMatchResult.episodeMap}
          videoFiles={enrichedMatchResult.videoFiles}
          supplementaryFiles={enrichedMatchResult.supplementaryFiles || []}
          onPlay={handlePlayItem}
          onClear={handleBack}
          onSetDanmaku={(epNum) => setPickerEp(epNum)}
          clearLabel="返回库"
          siteAnimeLoading={siteAnimeLoading}
        />
      </div>

      {filesByFolder.length > 0 && (
        <div>
          <div style={{ ...s.sectionLabel, marginBottom: 8 }}>// FILE SOURCES //</div>
          <div style={s.folderTree} data-testid="source-list">
            {filesByFolder.map(([dir, files]) => (
              <div
                key={dir}
                style={s.folderGroup}
                data-testid={`folder-group-${dir}`}
              >
                <div style={s.folderRow}>📁 {dir}/</div>
                {files.map((f, i) => {
                  const branch = i === files.length - 1 ? '└' : '├';
                  return (
                    <div
                      key={f.epId}
                      style={s.fileRow}
                      data-testid={`file-row-${f.epId}`}
                    >
                      <span style={s.fileBranch} aria-hidden>{branch}</span>
                      <span style={s.fileEpBadge}>EP{String(f.epNumber).padStart(2, '0')}</span>
                      <span style={s.fileName}>{f.fileName}</span>
                      <span
                        style={s.watchedMark}
                        aria-hidden
                        data-testid={`file-watched-${f.epId}`}
                      >
                        {f.watched ? '✓' : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      <DanmakuPicker
        isOpen={pickerEp != null}
        onClose={() => setPickerEp(null)}
        onConfirm={handleDanmakuConfirm}
        currentAnime={libraryMatchResult.anime}
        currentEpisodeId={pickerEp != null ? libraryMatchResult.episodeMap?.[pickerEp]?.dandanEpisodeId : null}
        episodeNumber={pickerEp}
        defaultKeyword={libraryMatchResult.anime.titleRomaji || libraryMatchResult.anime.titleChinese || ''}
      />

      {activeDialog === 'merge' && series && (
        <MergeDialog
          open
          sourceSeries={series}
          allSeries={allSeries}
          onClose={closeDialog}
          onConfirm={handleMergeConfirm}
        />
      )}

      {activeDialog === 'split' && series && (
        <SplitDialog
          open
          sourceSeries={series}
          seasons={splitSeasons}
          onClose={closeDialog}
          onConfirm={handleSplitConfirm}
        />
      )}

      {activeDialog === 'rematch' && series && (
        <RematchDialog
          open
          sourceSeries={series}
          onClose={closeDialog}
          onConfirm={handleRematchConfirm}
        />
      )}

      <OpsLogDrawer
        open={activeDialog === 'opslog'}
        entries={opsLogEntries}
        onClose={closeDialog}
      />

      {undoToast && (
        <UndoToast
          open
          title={undoToast.title}
          meta={undoToast.meta}
          onUndo={handleUndoMerge}
          onDismiss={() => setUndoToast(null)}
        />
      )}
    </div>
  );
}
