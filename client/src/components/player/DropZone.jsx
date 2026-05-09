import { useState, useRef, useCallback } from 'react';
import { motion as Motion, useReducedMotion } from 'motion/react';
import { useLang } from '../../context/LanguageContext';
import { ChapterBar, CornerBrackets } from '../shared/hud';
import { mono, PLAYER_HUE } from '../shared/hud-tokens';
import { flattenDropFiles } from '../../utils/dropFiles';
import PrivacyHint from '../shared/PrivacyHint';

const HUE = PLAYER_HUE.ingest;

const PULSE_CSS = `@keyframes dropPulse{0%,100%{border-color:oklch(46% 0.06 ${HUE} / 0.40)}50%{border-color:oklch(62% 0.19 ${HUE} / 0.65)}}`;

const PARSE_PULSE_CSS = `@keyframes parsePulse{0%,100%{opacity:0.55}50%{opacity:1}}`;

const s = {
  wrapper: {
    position: 'relative',
    maxWidth: 720, margin: '64px auto', padding: '0 24px',
  },
  zone: (dragging) => ({
    position: 'relative',
    border: `2px dashed ${dragging ? `oklch(72% 0.19 ${HUE})` : `oklch(46% 0.06 ${HUE} / 0.50)`}`,
    borderRadius: 4,
    padding: '64px 56px 56px',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
    background: dragging
      ? `oklch(62% 0.19 ${HUE} / 0.10)`
      : `linear-gradient(180deg, oklch(14% 0.04 ${HUE} / 0.55) 0%, rgba(20,20,22,0.6) 100%)`,
    transition: 'background 200ms ease-out, border-color 200ms ease-out',
    cursor: 'pointer',
    overflow: 'hidden',
    animation: dragging ? 'none' : 'dropPulse 3s ease-in-out infinite',
  }),
  eyebrow: {
    ...mono,
    fontSize: 11,
    color: `oklch(72% 0.15 ${HUE} / 0.85)`,
    textTransform: 'uppercase',
    letterSpacing: '0.18em',
    marginBottom: 4,
  },
  primary: {
    fontFamily: "'Sora',sans-serif", fontWeight: 700,
    fontSize: 24, color: '#ffffff', textAlign: 'center',
    letterSpacing: '-0.01em',
  },
  secondary: {
    ...mono,
    fontSize: 11, color: 'rgba(235,235,245,0.45)',
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: '0.18em',
  },
  link: {
    ...mono,
    marginTop: 18, fontSize: 11,
    color: `oklch(72% 0.15 ${HUE} / 0.85)`,
    background: 'none', border: 'none', cursor: 'pointer',
    textAlign: 'center', display: 'block', width: '100%',
    textTransform: 'uppercase', letterSpacing: '0.18em',
  },
  // Vertical scan line — only animates when dragging-over (Motion #4).
  scanLine: {
    position: 'absolute',
    left: 0, right: 0, top: 0,
    height: 1,
    background: `linear-gradient(90deg, transparent 0%, oklch(72% 0.19 ${HUE} / 0.85) 50%, transparent 100%)`,
    boxShadow: `0 0 14px oklch(72% 0.19 ${HUE} / 0.6)`,
    pointerEvents: 'none',
  },
  parseHead: {
    ...mono,
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    width: '100%', marginBottom: 12,
    fontSize: 10,
    color: `oklch(72% 0.15 ${HUE})`,
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
  },
  parseTitle: {
    fontFamily: "'Sora',sans-serif", fontWeight: 700,
    fontSize: 22, color: '#fff',
    letterSpacing: '-0.01em',
    animation: 'parsePulse 1.4s ease-in-out infinite',
  },
  parseCurrent: {
    ...mono,
    fontSize: 10,
    color: 'rgba(235,235,245,0.55)',
    letterSpacing: '0.04em',
    textAlign: 'center',
    marginTop: 6,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    maxWidth: '100%',
  },
  // ChapterBar-style progress: filled portion vs remaining track.
  progressTrack: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    height: 4,
    background: `oklch(20% 0.02 ${HUE} / 0.4)`,
    overflow: 'hidden',
  },
  progressFill: (pct) => ({
    width: `${pct}%`,
    height: '100%',
    background: `oklch(72% 0.19 ${HUE})`,
    boxShadow: `0 0 8px oklch(72% 0.19 ${HUE} / 0.7)`,
    transition: 'width 200ms ease-out',
  }),
};

/**
 * DropZone — drag-and-drop / pick entry for video files.
 *
 * Three visual states (§5.2):
 *   - idle      → dashed border + subtle pulse
 *   - dragging  → accent border + scan line + "release to start" copy
 *   - parsing   → progress fill + current file name (parent-driven)
 *
 * Parsing is opt-in: parents that have a fast sync handoff (e.g. PlayerPage)
 * never set it; parents with async enumeration (LibraryPage AddFolder) can
 * surface progress without re-mounting a different component.
 *
 * @param {{
 *   onFiles: (files: FileList | File[]) => void,
 *   parsing?: boolean,
 *   parsedCount?: number,
 *   totalCount?: number,
 *   currentFileName?: string,
 *   onCancelParsing?: () => void,
 * }} props
 */
export default function DropZone({
  onFiles,
  parsing = false,
  parsedCount = 0,
  totalCount = 0,
  currentFileName = '',
  onCancelParsing,
}) {
  const { t } = useLang();
  const reduced = useReducedMotion();
  const [dragging, setDragging] = useState(false);
  const folderRef = useRef(null);
  const fileRef = useRef(null);

  const handleDragOver = useCallback((e) => {
    if (parsing) return;
    e.preventDefault();
    setDragging(true);
  }, [parsing]);

  const handleDragLeave = useCallback(() => setDragging(false), []);

  const handleDrop = useCallback(async (e) => {
    if (parsing) return;
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const files = await flattenDropFiles(e.dataTransfer);
    if (files.length) onFiles(files);
  }, [onFiles, parsing]);

  const handleFolderChange = useCallback((e) => {
    if (e.target.files?.length) onFiles(e.target.files);
  }, [onFiles]);

  const handleFileChange = useCallback((e) => {
    if (e.target.files?.length) onFiles(e.target.files);
  }, [onFiles]);

  const handleClick = useCallback(() => {
    if (parsing) return;
    folderRef.current?.click();
  }, [parsing]);

  const handleKeyDown = useCallback((e) => {
    if (parsing) return;
    if (e.key === 'Enter' || e.key === ' ') folderRef.current?.click();
  }, [parsing]);

  const pct = totalCount > 0 ? Math.min(100, Math.round((parsedCount / totalCount) * 100)) : 0;

  return (
    <div style={s.wrapper}>
      <style>{PULSE_CSS}</style>
      <style>{PARSE_PULSE_CSS}</style>
      {/* Left chapter bar — amber denotes ingest */}
      <ChapterBar hue={HUE} height={64} top={-4} left={4} trigger="mount" />

      <div
        style={s.zone(dragging || parsing)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
        role="button"
        tabIndex={parsing ? -1 : 0}
        aria-label={t('player.dropLabel')}
        aria-busy={parsing || undefined}
        aria-disabled={parsing || undefined}
        onKeyDown={handleKeyDown}
        data-testid="dropzone"
        data-state={parsing ? 'parsing' : dragging ? 'dragging' : 'idle'}
      >
        <CornerBrackets inset={6} size={10} opacity={0.34} hue={HUE} />

        {/* Scan line — Motion #4: infinite vertical traversal during drag-over */}
        {dragging && !parsing && !reduced && (
          <Motion.span
            style={s.scanLine}
            initial={{ y: 0 }}
            animate={{ y: ['0%', '5800%'] }}
            transition={{ duration: 1.6, ease: 'linear', repeat: Infinity }}
            aria-hidden
          />
        )}

        {parsing ? (
          <>
            <div style={s.parseHead}>
              <span data-testid="dropzone-parse-counter">
                {`// IMPORT · ${String(parsedCount).padStart(4, '0')} / ${String(totalCount).padStart(4, '0')}`}
              </span>
              {onCancelParsing && (
                <button
                  type="button"
                  data-testid="dropzone-parse-cancel"
                  onClick={(e) => { e.stopPropagation(); onCancelParsing(); }}
                  style={{
                    ...mono, fontSize: 10, padding: '4px 10px',
                    background: 'transparent',
                    border: '1px solid oklch(60% 0.20 25 / 0.50)',
                    borderRadius: 2,
                    color: 'oklch(72% 0.18 25)',
                    cursor: 'pointer',
                    letterSpacing: '0.10em', textTransform: 'uppercase',
                  }}
                >
                  ⊘ {t('player.parseCancel') || '取消'}
                </button>
              )}
            </div>
            <div style={s.parseTitle} data-testid="dropzone-parse-title">
              {t('player.parsing') || '解析中…'}
            </div>
            {currentFileName && (
              <div style={s.parseCurrent} title={currentFileName} data-testid="dropzone-parse-current">
                {currentFileName}
              </div>
            )}
            <div style={s.progressTrack} aria-hidden>
              <div style={s.progressFill(pct)} data-testid="dropzone-parse-fill" />
            </div>
          </>
        ) : (
          <>
            <div style={s.eyebrow} aria-hidden>INGEST //</div>
            <div style={s.primary}>
              {dragging ? (t('player.dropRelease') || t('player.dropTitle')) : t('player.dropTitle')}
            </div>
            <div style={s.secondary}>MKV · MP4 · AVI · WEBM</div>
          </>
        )}
      </div>

      <button
        style={s.link}
        onClick={() => fileRef.current?.click()}
        disabled={parsing}
      >
        {t('player.singleFile')}
      </button>

      {!parsing && (
        <div style={{ marginTop: 14, textAlign: 'center' }}>
          <PrivacyHint />
        </div>
      )}

      <input
        ref={folderRef}
        type="file"
        webkitdirectory=""
        style={{ display: 'none' }}
        onChange={handleFolderChange}
      />
      <input
        ref={fileRef}
        type="file"
        accept="video/*"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </div>
  );
}
