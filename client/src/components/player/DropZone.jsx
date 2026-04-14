import { useState, useRef, useCallback } from 'react';
import { useLang } from '../../context/LanguageContext';

const s = {
  wrapper: {
    maxWidth: 600, margin: '64px auto', padding: '0 24px',
  },
  zone: (dragging) => ({
    border: `2px dashed ${dragging ? '#0a84ff' : 'rgba(84,84,88,0.65)'}`,
    borderRadius: 16,
    padding: 48,
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
    background: dragging ? 'rgba(10,132,255,0.12)' : 'transparent',
    transition: 'all 150ms ease-out',
    cursor: 'pointer',
  }),
  icon: { fontSize: 48, color: 'rgba(235,235,245,0.30)', lineHeight: 1 },
  primary: {
    fontFamily: "'Sora',sans-serif", fontWeight: 600,
    fontSize: 18, color: '#ffffff', textAlign: 'center',
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
        <div style={s.icon}>📂</div>
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
