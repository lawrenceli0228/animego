import { useState, useRef, useCallback } from 'react';
import { useLang } from '../../context/LanguageContext';

const PULSE_CSS = `@keyframes dropPulse{0%,100%{border-color:rgba(84,84,88,0.40)}50%{border-color:rgba(84,84,88,0.70)}}`;

const s = {
  wrapper: {
    maxWidth: 720, margin: '64px auto', padding: '0 24px',
  },
  zone: (dragging) => ({
    border: `2px dashed ${dragging ? '#0a84ff' : 'rgba(84,84,88,0.50)'}`,
    borderRadius: 16,
    padding: '56px 48px',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
    background: dragging ? 'rgba(10,132,255,0.12)' : '#1c1c1e',
    transition: 'all 200ms ease-out',
    cursor: 'pointer',
    animation: dragging ? 'none' : 'dropPulse 3s ease-in-out infinite',
  }),
  icon: { color: 'rgba(235,235,245,0.25)', lineHeight: 1 },
  primary: {
    fontFamily: "'Sora',sans-serif", fontWeight: 600,
    fontSize: 20, color: '#ffffff', textAlign: 'center',
  },
  secondary: {
    fontSize: 14, color: 'rgba(235,235,245,0.30)', textAlign: 'center',
  },
  link: {
    marginTop: 16, fontSize: 14, color: '#0a84ff',
    background: 'none', border: 'none', cursor: 'pointer',
    textAlign: 'center', display: 'block', width: '100%',
  },
};

export default function DropZone({ onFiles }) {
  const { t } = useLang();
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
        <div style={s.icon}>
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <circle cx="24" cy="24" r="23" stroke="currentColor" strokeWidth="2" opacity="0.5" />
            <path d="M19 15.5V32.5L34 24L19 15.5Z" fill="currentColor" opacity="0.7" />
          </svg>
        </div>
        <div style={s.primary}>{t('player.dropTitle')}</div>
        <div style={s.secondary}>mkv · mp4 · avi · webm</div>
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
