import { useState, useRef, useCallback } from 'react';
import { motion as Motion, useReducedMotion } from 'motion/react';
import { useLang } from '../../context/LanguageContext';
import { ChapterBar, CornerBrackets } from '../shared/hud';
import { mono, PLAYER_HUE } from '../shared/hud-tokens';

const HUE = PLAYER_HUE.ingest;

const PULSE_CSS = `@keyframes dropPulse{0%,100%{border-color:oklch(46% 0.06 ${HUE} / 0.40)}50%{border-color:oklch(62% 0.19 ${HUE} / 0.65)}}`;

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
};

export default function DropZone({ onFiles }) {
  const { t } = useLang();
  const reduced = useReducedMotion();
  const [dragging, setDragging] = useState(false);
  const folderRef = useRef(null);
  const fileRef = useRef(null);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => setDragging(false), []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    const files = e.dataTransfer?.files;
    if (files?.length) onFiles(files);
  }, [onFiles]);

  const handleFolderChange = useCallback((e) => {
    if (e.target.files?.length) onFiles(e.target.files);
  }, [onFiles]);

  const handleFileChange = useCallback((e) => {
    if (e.target.files?.length) onFiles(e.target.files);
  }, [onFiles]);

  return (
    <div style={s.wrapper}>
      <style>{PULSE_CSS}</style>
      {/* Left chapter bar — amber denotes ingest */}
      <ChapterBar hue={HUE} height={64} top={-4} left={4} trigger="mount" />

      <div
        style={s.zone(dragging)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => folderRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-label={t('player.dropLabel')}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') folderRef.current?.click(); }}
      >
        <CornerBrackets inset={6} size={10} opacity={0.34} hue={HUE} />

        {/* Scan line — Motion #4: infinite vertical traversal during drag-over */}
        {dragging && !reduced && (
          <Motion.span
            style={s.scanLine}
            initial={{ y: 0 }}
            animate={{ y: ['0%', '5800%'] }}
            transition={{ duration: 1.6, ease: 'linear', repeat: Infinity }}
            aria-hidden
          />
        )}

        <div style={s.eyebrow} aria-hidden>INGEST //</div>
        <div style={s.primary}>{t('player.dropTitle')}</div>
        <div style={s.secondary}>MKV · MP4 · AVI · WEBM</div>
      </div>

      <button style={s.link} onClick={() => fileRef.current?.click()}>
        {t('player.singleFile')}
      </button>

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
