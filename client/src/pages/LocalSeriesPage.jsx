// @ts-check
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import useSeriesDetail from '../hooks/useSeriesDetail';
import useFileHandles from '../hooks/useFileHandles';
import { db } from '../lib/library/db/db.js';
import { makeProgressRepo } from '../lib/library/db/progressRepo.js';
import { mono, PLAYER_HUE } from '../components/shared/hud-tokens';
import { CornerBrackets } from '../components/shared/hud';

/** @typedef {import('../lib/library/types').Progress} Progress */

const HUE = PLAYER_HUE.stream;

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
  hero: {
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: '180px 1fr',
    gap: 24,
    padding: 20,
    background: `oklch(14% 0.04 ${HUE} / 0.55)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.35)`,
    borderRadius: 6,
  },
  poster: {
    width: 180,
    aspectRatio: '2/3',
    borderRadius: 4,
    objectFit: 'cover',
    display: 'block',
    background: `oklch(18% 0.06 ${HUE} / 0.80)`,
  },
  monogram: {
    width: 180,
    aspectRatio: '2/3',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: `oklch(18% 0.06 ${HUE} / 0.80)`,
    fontFamily: "'Sora', sans-serif",
    fontSize: 64,
    fontWeight: 700,
    color: `oklch(72% 0.15 ${HUE})`,
    borderRadius: 4,
  },
  heroBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    minWidth: 0,
  },
  badgeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  localBadge: {
    ...mono,
    fontSize: 10,
    padding: '3px 7px',
    background: `oklch(62% 0.17 ${HUE} / 0.20)`,
    border: `1px solid oklch(62% 0.17 ${HUE} / 0.45)`,
    color: `oklch(72% 0.15 ${HUE})`,
    borderRadius: 2,
    textTransform: 'uppercase',
    letterSpacing: '0.14em',
  },
  typeBadge: {
    ...mono,
    fontSize: 10,
    padding: '3px 7px',
    background: 'transparent',
    border: '1px solid rgba(235,235,245,0.25)',
    color: 'rgba(235,235,245,0.65)',
    borderRadius: 2,
    textTransform: 'uppercase',
    letterSpacing: '0.14em',
  },
  title: {
    fontFamily: "'Sora', sans-serif",
    fontWeight: 700,
    fontSize: 22,
    color: '#fff',
    letterSpacing: '-0.01em',
    lineHeight: 1.25,
  },
  subtitle: {
    ...mono,
    fontSize: 11,
    color: 'rgba(235,235,245,0.55)',
  },
  overallProgress: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginTop: 4,
  },
  progressMeta: {
    ...mono,
    fontSize: 10,
    color: 'rgba(235,235,245,0.55)',
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
  },
  progressTrack: {
    height: 3,
    background: `oklch(62% 0.17 ${HUE} / 0.18)`,
    borderRadius: 1.5,
    overflow: 'hidden',
  },
  progressFill: (pct) => ({
    height: '100%',
    width: `${Math.max(0, Math.min(1, pct)) * 100}%`,
    background: `oklch(62% 0.17 ${HUE})`,
  }),
  ctaRow: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 8,
  },
  primaryBtn: {
    ...mono,
    padding: '10px 18px',
    background: `oklch(62% 0.17 ${HUE} / 0.25)`,
    border: `1px solid oklch(62% 0.17 ${HUE} / 0.65)`,
    borderRadius: 4,
    color: `oklch(80% 0.13 ${HUE})`,
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
  episodeList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  episodeRow: {
    display: 'grid',
    gridTemplateColumns: '64px 1fr 90px 24px',
    alignItems: 'center',
    gap: 12,
    padding: '10px 14px',
    background: `oklch(14% 0.04 ${HUE} / 0.40)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.20)`,
    borderRadius: 4,
    cursor: 'pointer',
    color: '#fff',
    textAlign: 'left',
    width: '100%',
  },
  epNumber: {
    ...mono,
    fontSize: 12,
    color: `oklch(72% 0.15 ${HUE})`,
    letterSpacing: '0.08em',
  },
  epTitleCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 0,
  },
  epTitle: {
    fontSize: 13,
    color: '#fff',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  epMini: {
    ...mono,
    fontSize: 10,
    color: 'rgba(235,235,245,0.45)',
  },
  statusCol: {
    ...mono,
    fontSize: 10,
    textAlign: 'right',
    color: 'rgba(235,235,245,0.55)',
    textTransform: 'uppercase',
    letterSpacing: '0.10em',
  },
  arrow: {
    ...mono,
    fontSize: 14,
    color: 'rgba(235,235,245,0.35)',
    textAlign: 'right',
  },
  sourceList: {
    ...mono,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    fontSize: 11,
    color: 'rgba(235,235,245,0.55)',
    padding: 12,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.20)`,
    borderRadius: 4,
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

function fmtDuration(sec) {
  if (!sec || !Number.isFinite(sec)) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Status label per episode: ✓看过 / 进行中 / 未看
 */
function statusOf(progress) {
  if (!progress) return { label: '未看', cls: 'idle' };
  if (progress.completed) return { label: '✓ 看过', cls: 'done' };
  return { label: `进行中 ${fmtDuration(progress.positionSec)}`, cls: 'active' };
}

/**
 * Pick the best episode to resume:
 * - prefer the most-recently-watched non-completed episode
 * - fall back to the first not-yet-watched episode
 * - else the first episode
 *
 * @param {{ id: string, number: number }[]} episodes
 * @param {Map<string, Progress>} progressByEp
 * @returns {{ id: string, number: number } | null}
 */
function pickResumeEpisode(episodes, progressByEp) {
  if (!episodes.length) return null;

  let bestActive = null;
  for (const ep of episodes) {
    const p = progressByEp.get(ep.id);
    if (p && !p.completed) {
      if (!bestActive || p.updatedAt > (progressByEp.get(bestActive.id)?.updatedAt ?? 0)) {
        bestActive = ep;
      }
    }
  }
  if (bestActive) return bestActive;

  const firstUnseen = episodes.find((ep) => !progressByEp.get(ep.id)?.completed);
  return firstUnseen ?? episodes[0];
}

/**
 * LocalSeriesPage — series detail for a locally-imported series.
 *
 * URL: /library/:seriesId
 * Reads seriesId from the route, hydrates via useSeriesDetail, fetches per-episode
 * progress via progressRepo. Renders hero + episode list + file-source breakdown.
 * Episode click navigates to /player with state.
 */
export default function LocalSeriesPage() {
  const navigate = useNavigate();
  const { seriesId } = useParams();
  const fileHandles = useFileHandles({ db });
  const { status, series, episodes, fileRefByEpisode } = useSeriesDetail(
    seriesId ?? null,
    { db, fileHandles },
  );

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

  const watchedCount = useMemo(() => {
    let n = 0;
    for (const ep of episodes) {
      if (progressByEp.get(ep.id)?.completed) n++;
    }
    return n;
  }, [episodes, progressByEp]);

  const overallPct = episodes.length > 0 ? watchedCount / episodes.length : 0;

  const resumeEp = useMemo(
    () => pickResumeEpisode(episodes, progressByEp),
    [episodes, progressByEp],
  );

  const sourceFolders = useMemo(() => {
    const s = new Set();
    for (const ref of fileRefByEpisode.values()) {
      const dir = ref.relPath.includes('/')
        ? ref.relPath.slice(0, ref.relPath.lastIndexOf('/'))
        : '(根)';
      s.add(dir);
    }
    return Array.from(s).sort();
  }, [fileRefByEpisode]);

  const handleBack = useCallback(() => {
    navigate('/library');
  }, [navigate]);

  const handlePlayEpisode = useCallback((episodeNumber) => {
    if (!seriesId) return;
    navigate('/player', { state: { seriesId, resumeEpisode: episodeNumber } });
  }, [navigate, seriesId]);

  const handleResume = useCallback(() => {
    if (!resumeEp) return;
    handlePlayEpisode(resumeEp.number);
  }, [resumeEp, handlePlayEpisode]);

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

  if (status === 'missing' || !series) {
    return (
      <div style={s.page}>
        <div style={s.topbar}>
          <button style={s.backBtn} onClick={handleBack} type="button">← 返回</button>
        </div>
        <div style={s.emptyState} data-testid="missing-state">该系列不存在或已被删除</div>
      </div>
    );
  }

  const title = pickTitle(series);
  const initial = title.charAt(0).toUpperCase();
  const safePoster = typeof series.posterUrl === 'string' && /^https:\/\//i.test(series.posterUrl)
    ? series.posterUrl
    : null;

  return (
    <div style={s.page}>
      <div style={s.topbar}>
        <button style={s.backBtn} onClick={handleBack} type="button" data-testid="back-btn">
          ← 返回
        </button>
      </div>

      <div style={s.hero} data-testid="series-hero">
        <CornerBrackets inset={4} size={10} opacity={0.30} hue={HUE} />

        {safePoster ? (
          <img src={safePoster} alt={title} style={s.poster} />
        ) : (
          <div style={s.monogram} aria-hidden data-testid="hero-monogram">{initial}</div>
        )}

        <div style={s.heroBody}>
          <div style={s.badgeRow}>
            <span style={s.localBadge} data-testid="hero-local-badge">⬡ LOCAL</span>
            <span style={s.typeBadge}>{(series.type ?? 'tv').toUpperCase()}</span>
            {series.totalEpisodes != null && (
              <span style={s.typeBadge}>{series.totalEpisodes} 集</span>
            )}
          </div>

          <h1 style={s.title} data-testid="hero-title">{title}</h1>

          {episodes.length > 0 && (
            <div style={s.overallProgress} data-testid="overall-progress">
              <span style={s.progressMeta}>
                已看 {watchedCount} / {episodes.length}
              </span>
              <div style={s.progressTrack}>
                <div style={s.progressFill(overallPct)} />
              </div>
            </div>
          )}

          {resumeEp && (
            <div style={s.ctaRow}>
              <button
                type="button"
                style={s.primaryBtn}
                onClick={handleResume}
                data-testid="continue-btn"
              >
                继续播放 EP{String(resumeEp.number).padStart(2, '0')}
              </button>
            </div>
          )}
        </div>
      </div>

      <div>
        <div style={{ ...s.sectionLabel, marginBottom: 8 }}>// EPISODES //</div>
        {episodes.length === 0 ? (
          <div style={s.emptyState} data-testid="no-episodes">尚无剧集</div>
        ) : (
          <div style={s.episodeList} data-testid="episode-list">
            {episodes.map((ep) => {
              const progress = progressByEp.get(ep.id);
              const status = statusOf(progress);
              const pct = progress && progress.durationSec > 0
                ? progress.positionSec / progress.durationSec
                : 0;
              return (
                <button
                  key={ep.id}
                  type="button"
                  style={s.episodeRow}
                  onClick={() => handlePlayEpisode(ep.number)}
                  data-testid={`episode-row-${ep.number}`}
                >
                  <span style={s.epNumber}>EP{String(ep.number).padStart(2, '0')}</span>
                  <div style={s.epTitleCol}>
                    <span style={s.epTitle}>{ep.title || `第 ${ep.number} 集`}</span>
                    {progress && !progress.completed && pct > 0 && (
                      <div style={s.progressTrack}>
                        <div style={s.progressFill(pct)} />
                      </div>
                    )}
                  </div>
                  <span style={s.statusCol} data-testid={`episode-status-${ep.number}`}>
                    {status.label}
                  </span>
                  <span style={s.arrow}>▶</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {sourceFolders.length > 0 && (
        <div>
          <div style={{ ...s.sectionLabel, marginBottom: 8 }}>// FILE SOURCES //</div>
          <div style={s.sourceList} data-testid="source-list">
            {sourceFolders.map((dir) => (
              <div key={dir}>📁 {dir}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
