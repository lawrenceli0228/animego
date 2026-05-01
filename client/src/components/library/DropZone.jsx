// @ts-check
import { useCallback, useState } from 'react';
import { mono } from '../shared/hud-tokens';
import PrivacyHint from '../shared/PrivacyHint';

/** @typedef {'empty'|'hover'|'parsing'} DropZoneState */

const HOVER_GRID_KEYFRAMES = `
@keyframes animego-dropzone-grid {
  from { background-position: 0 0; }
  to   { background-position: 24px 24px; }
}
@keyframes animego-dropzone-cell-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.55; }
}
`;

const s = {
  panel: (state) => ({
    width: '100%',
    maxWidth: 640,
    margin: '0 auto',
    aspectRatio: '4 / 3',
    borderRadius: 16,
    padding: 24,
    display: 'flex',
    flexDirection: 'column',
    alignItems: state === 'parsing' ? 'stretch' : 'center',
    justifyContent: state === 'parsing' ? 'flex-start' : 'center',
    textAlign: state === 'parsing' ? 'left' : 'center',
    gap: state === 'parsing' ? 14 : 16,
    transition: 'all 250ms cubic-bezier(0.4,0,0.2,1)',
    position: 'relative',
    overflow: 'hidden',
    color: '#fff',
    ...(state === 'empty' ? {
      background: 'rgba(28,28,30,0.40)',
      border: '1.5px dashed rgba(84,84,88,0.65)',
    } : null),
    ...(state === 'hover' ? {
      background: 'rgba(10,132,255,0.06)',
      border: '2px solid #0a84ff',
      boxShadow:
        '0 0 0 4px rgba(10,132,255,0.12), 0 8px 32px rgba(10,132,255,0.35)',
    } : null),
    ...(state === 'parsing' ? {
      background: '#1c1c1e',
      border: '1px solid #38383a',
      padding: 20,
    } : null),
  }),
  hoverGrid: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    backgroundImage:
      'linear-gradient(0deg, rgba(10,132,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(10,132,255,0.06) 1px, transparent 1px)',
    backgroundSize: '24px 24px',
    animation: 'animego-dropzone-grid 4s linear infinite',
  },
  hoverTag: {
    ...mono,
    position: 'absolute',
    top: 12,
    right: 12,
    fontSize: 10,
    color: '#0a84ff',
    background: 'rgba(10,132,255,0.12)',
    padding: '4px 8px',
    borderRadius: 8,
    letterSpacing: '0.10em',
    textTransform: 'uppercase',
    border: '1px solid rgba(10,132,255,0.30)',
  },
  icon: (state) => ({
    ...mono,
    fontSize: 56,
    lineHeight: 1,
    color: state === 'hover' ? '#0a84ff' : 'rgba(235,235,245,0.30)',
    transform: state === 'hover' ? 'translateY(-4px) scale(1.1)' : 'none',
    transition: 'all 250ms cubic-bezier(0.4,0,0.2,1)',
  }),
  title: (state) => ({
    fontFamily: "'Sora', sans-serif",
    fontWeight: 600,
    fontSize: 18,
    letterSpacing: '-0.01em',
    color: state === 'hover' ? '#0a84ff' : '#fff',
    margin: 0,
  }),
  help: {
    fontSize: 13,
    color: 'rgba(235,235,245,0.60)',
    lineHeight: 1.5,
    maxWidth: 320,
  },
  helpCode: {
    ...mono,
    fontSize: 11,
    background: 'rgba(255,255,255,0.06)',
    padding: '1px 6px',
    borderRadius: 4,
    color: '#5ac8fa',
  },
  cta: {
    height: 38,
    padding: '0 18px',
    background: '#0a84ff',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
  },
  ctaDisabled: {
    background: 'rgba(120,120,128,0.12)',
    color: 'rgba(235,235,245,0.30)',
    cursor: 'not-allowed',
  },
  secondary: {
    ...mono,
    fontSize: 11,
    color: 'rgba(235,235,245,0.30)',
    letterSpacing: '0.10em',
    marginTop: 4,
  },

  // Parsing state internals (header + bar + stats)
  parseHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  parseHeadNum: {
    ...mono,
    fontSize: 10,
    color: 'rgba(235,235,245,0.30)',
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
  },
  parseCancel: {
    ...mono,
    height: 24,
    padding: '0 10px',
    background: 'transparent',
    color: 'rgba(235,235,245,0.60)',
    border: '1px solid rgba(84,84,88,0.65)',
    borderRadius: 8,
    fontSize: 11,
    cursor: 'pointer',
  },
  parseTitle: {
    fontFamily: "'Sora', sans-serif",
    fontSize: 16,
    fontWeight: 600,
    color: '#fff',
    margin: 0,
  },
  parseCurrent: {
    ...mono,
    fontSize: 11,
    color: 'rgba(235,235,245,0.60)',
    background: 'rgba(0,0,0,0.30)',
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid #38383a',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  parseCurrentPrefix: { color: '#0a84ff', marginRight: 4 },
  chapterbar: {
    display: 'flex',
    gap: 2,
    height: 8,
    borderRadius: 9999,
    overflow: 'hidden',
    background: 'rgba(255,255,255,0.04)',
    padding: 0,
  },
  chapCell: (kind) => {
    const map = {
      done: '#0a84ff',
      now:  '#0a84ff',
      warn: '#ff9f0a',
      err:  '#ff453a',
      idle: '#2c2c2e',
    };
    return {
      flex: 1,
      background: map[kind],
      transition: 'background 200ms cubic-bezier(0.4,0,0.2,1)',
      ...(kind === 'now'
        ? {
            boxShadow: '0 0 8px rgba(10,132,255,0.35)',
            animation: 'animego-dropzone-cell-pulse 1.2s cubic-bezier(0.4,0,0.2,1) infinite',
          }
        : null),
    };
  },
  parseStats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 4,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    color: 'rgba(235,235,245,0.60)',
  },
  parseStatRow: (color) => ({
    color,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  }),
  parseMeter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: 'rgba(235,235,245,0.60)',
    letterSpacing: '0.05em',
  },
  parseMeterPct: { color: '#0a84ff' },
  parseMeterEta: { color: 'rgba(235,235,245,0.30)' },
};

/**
 * Render a 47-cell ChapterBar. Cells fall into kinds:
 *   - done | now | warn | err | idle
 * The caller passes counts for each cell kind plus the currently-active index.
 *
 * @param {{ done: number, warn: number, err: number, total: number, currentIndex?: number }} props
 */
function ChapterBarCells({ done = 0, warn = 0, err = 0, total = 47, currentIndex }) {
  const cells = [];
  let usedDone = 0;
  let usedWarn = 0;
  let usedErr = 0;
  for (let i = 0; i < total; i += 1) {
    let kind = 'idle';
    if (i === currentIndex) kind = 'now';
    else if (usedDone < done) { kind = 'done'; usedDone += 1; }
    else if (usedWarn < warn) { kind = 'warn'; usedWarn += 1; }
    else if (usedErr < err) { kind = 'err'; usedErr += 1; }
    cells.push(<span key={i} style={s.chapCell(kind)} aria-hidden />);
  }
  return cells;
}

/**
 * DropZone — §5.2 three-state drop target.
 *
 *   empty   — dashed box, icon `▤`, primary CTA "选择文件夹"
 *   hover   — accent glow, icon `⇩`, "放下即可开始" + estimated count
 *   parsing — solid card, ChapterBar progress + 4-color stats + ETA
 *
 * The `state` prop is normally driven by parent: render `empty` until a drag
 * event flips it to `hover`, drop flips it to `parsing` (or hand off to
 * ImportDrawer). Drag handlers are wired internally so callers only need to
 * provide `onPick` (button-click) and `onDrop` (folder-handle picker fallback).
 *
 * @param {{
 *   state?: DropZoneState,
 *   onPick?: () => void,
 *   onDrop?: (items: DataTransferItemList) => void,
 *   isFsaSupported?: boolean,
 *   parsing?: {
 *     done: number,
 *     warn: number,
 *     err: number,
 *     total: number,
 *     currentIndex?: number,
 *     currentFile?: string,
 *     etaSec?: number,
 *     stats?: { ok: number, run: number, warn: number, err: number },
 *     onCancel?: () => void,
 *   },
 *   hoverPreview?: { folderName?: string, estimatedCount?: number },
 * }} props
 */
export default function DropZone({
  state: stateProp,
  onPick,
  onDrop,
  isFsaSupported = true,
  parsing,
  hoverPreview,
}) {
  // Internal hover tracking — flips when a drag enters the zone, resets on
  // leave/drop. If a parent supplies `state`, that wins (controlled mode).
  const [internalHover, setInternalHover] = useState(false);
  const state = stateProp ?? (internalHover ? 'hover' : 'empty');

  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer?.types?.includes('Files')) setInternalHover(true);
  }, []);
  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);
  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    // Only collapse hover when the cursor truly leaves the panel — drag
    // events bubble through children, so check relatedTarget.
    if (!e.currentTarget.contains(e.relatedTarget)) setInternalHover(false);
  }, []);
  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      setInternalHover(false);
      if (onDrop && e.dataTransfer?.items) onDrop(e.dataTransfer.items);
    },
    [onDrop],
  );

  return (
    <div
      data-testid="dropzone"
      data-state={state}
      style={s.panel(state)}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      role="button"
      tabIndex={state === 'parsing' ? -1 : 0}
      onKeyDown={(e) => {
        if (state === 'parsing') return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (onPick && isFsaSupported) onPick();
        }
      }}
      aria-label={
        state === 'parsing'
          ? '导入解析中'
          : state === 'hover'
          ? '准备接收文件夹'
          : '把文件夹拖到这里或选择文件夹'
      }
    >
      <style>{HOVER_GRID_KEYFRAMES}</style>

      {state === 'hover' && (
        <>
          <span style={s.hoverGrid} aria-hidden />
          <span style={s.hoverTag}>// 释放以导入</span>
        </>
      )}

      {state !== 'parsing' && (
        <>
          <div style={s.icon(state)} aria-hidden>
            {state === 'hover' ? '⇩' : '▤'}
          </div>
          <h3 style={s.title(state)}>
            {state === 'hover' ? '放下即可开始' : '把文件夹拖到这里'}
          </h3>
          {state === 'hover' ? (
            <p style={s.help}>
              检测到{' '}
              <strong style={{ color: '#fff' }}>
                {hoverPreview?.folderName ? `1 个文件夹` : '1 个文件夹'}
              </strong>
              {hoverPreview?.estimatedCount != null && (
                <>
                  {' · '}估算{' '}
                  <strong style={{ color: '#fff' }}>
                    {hoverPreview.estimatedCount} 个媒体文件
                  </strong>
                </>
              )}
            </p>
          ) : (
            <p style={s.help}>
              支持 <code style={s.helpCode}>.mkv</code>{' '}
              <code style={s.helpCode}>.mp4</code>{' '}
              <code style={s.helpCode}>.mov</code> · 自动按系列归类
              <br />
              所有解析在本地进行,文件不会上传
            </p>
          )}
          {state === 'empty' && (
            <>
              <button
                type="button"
                style={isFsaSupported ? s.cta : { ...s.cta, ...s.ctaDisabled }}
                onClick={onPick}
                disabled={!isFsaSupported}
                data-testid="dropzone-pick"
              >
                ＋ 选择文件夹
              </button>
              <PrivacyHint compact />
            </>
          )}
          {state === 'hover' && hoverPreview?.folderName && (
            <div style={{ ...s.secondary, color: '#0a84ff' }}>
              {hoverPreview.folderName.toUpperCase()}/
            </div>
          )}
        </>
      )}

      {state === 'parsing' && parsing && (
        <>
          <div style={s.parseHead}>
            <span style={s.parseHeadNum}>
              // IMPORT · {String(parsing.done).padStart(4, '0')} /{' '}
              {String(parsing.total).padStart(4, '0')}
            </span>
            {parsing.onCancel && (
              <button
                type="button"
                style={s.parseCancel}
                onClick={parsing.onCancel}
                data-testid="dropzone-cancel"
              >
                ⊘ 取消
              </button>
            )}
          </div>
          <h3 style={s.parseTitle}>解析中…</h3>
          {parsing.currentFile && (
            <div style={s.parseCurrent} title={parsing.currentFile}>
              <span style={s.parseCurrentPrefix}>{'>'}</span>
              {parsing.currentFile}
            </div>
          )}
          <div style={s.chapterbar} aria-label="文件解析进度">
            <ChapterBarCells
              done={parsing.done}
              warn={parsing.warn}
              err={parsing.err}
              total={parsing.total}
              currentIndex={parsing.currentIndex}
            />
          </div>
          <div style={s.parseStats}>
            <span style={s.parseStatRow('#30d158')}>
              ✓ <strong style={{ color: '#fff' }}>{parsing.stats?.ok ?? parsing.done}</strong>
            </span>
            <span style={s.parseStatRow('#0a84ff')}>
              ⟳ <strong style={{ color: '#fff' }}>{parsing.stats?.run ?? 0}</strong>
            </span>
            <span style={s.parseStatRow('#ff9f0a')}>
              ⚠ <strong style={{ color: '#fff' }}>{parsing.stats?.warn ?? parsing.warn}</strong>
            </span>
            <span style={s.parseStatRow('#ff453a')}>
              ✗ <strong style={{ color: '#fff' }}>{parsing.stats?.err ?? parsing.err}</strong>
            </span>
          </div>
          <div style={s.parseMeter}>
            <span>
              <span style={s.parseMeterPct}>
                {Math.round((parsing.done / Math.max(1, parsing.total)) * 100)}%
              </span>
              {' · '}
              {parsing.done} / {parsing.total}
            </span>
            {parsing.etaSec != null && (
              <span style={s.parseMeterEta}>ETA {parsing.etaSec} 秒</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
