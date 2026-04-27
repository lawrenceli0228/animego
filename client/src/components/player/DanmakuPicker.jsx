import { useState, useCallback, useEffect } from 'react';
import { motion as Motion, useReducedMotion } from 'motion/react';
import { searchAnime, getEpisodes } from '../../api/dandanplay.api';
import { useLang } from '../../context/LanguageContext';
import { ChapterBar, CornerBrackets } from '../shared/hud';
import { mono, PLAYER_HUE } from '../shared/hud-tokens';

const HUE = PLAYER_HUE.ingest;
const HUE_STREAM = PLAYER_HUE.stream;

const s = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 9999,
    background: 'rgba(0,0,0,0.72)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    paddingTop: '8vh',
  },
  modal: {
    position: 'relative',
    width: '100%', maxWidth: 720, maxHeight: '80vh',
    background: `linear-gradient(180deg, oklch(14% 0.04 ${HUE} / 0.55) 0%, rgba(20,20,22,0.82) 100%)`,
    borderRadius: 4,
    display: 'flex', flexDirection: 'column',
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.45)`,
    overflow: 'hidden',
  },
  header: {
    position: 'relative',
    padding: '20px 24px 16px 56px',
    borderBottom: `1px solid oklch(46% 0.06 ${HUE} / 0.30)`,
  },
  headerEyebrow: {
    ...mono,
    fontSize: 10,
    color: `oklch(72% 0.15 ${HUE} / 0.85)`,
    textTransform: 'uppercase',
    letterSpacing: '0.18em',
    marginBottom: 6,
  },
  headerTitleRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12,
  },
  headerTitle: {
    fontFamily: "'Sora',sans-serif", fontWeight: 700,
    fontSize: 18, color: '#ffffff', letterSpacing: '-0.01em',
    minWidth: 0,
  },
  headerSub: {
    ...mono,
    fontWeight: 400,
    color: 'rgba(235,235,245,0.50)',
    marginLeft: 10, fontSize: 12,
    letterSpacing: '0.06em',
  },
  closeBtn: {
    background: 'transparent',
    border: '1px solid rgba(235,235,245,0.20)',
    borderRadius: 2,
    color: 'rgba(235,235,245,0.75)',
    fontSize: 14,
    cursor: 'pointer',
    padding: '4px 10px',
    lineHeight: 1,
    fontFamily: "'JetBrains Mono',monospace",
  },
  tabs: {
    display: 'flex', gap: 8, padding: '12px 24px 0 56px',
  },
  tab: (active) => ({
    ...mono,
    padding: '6px 14px',
    borderRadius: 2,
    fontSize: 11,
    fontWeight: 500,
    border: active
      ? `1px solid oklch(62% 0.19 ${HUE} / 0.55)`
      : '1px solid rgba(235,235,245,0.16)',
    cursor: 'pointer',
    background: active ? `oklch(62% 0.19 ${HUE} / 0.16)` : 'transparent',
    color: active ? `oklch(82% 0.15 ${HUE})` : 'rgba(235,235,245,0.65)',
    transition: 'all 150ms',
    textTransform: 'uppercase',
    letterSpacing: '0.14em',
  }),
  body: {
    flex: 1, overflowY: 'auto', padding: '14px 24px 20px 56px',
    minHeight: 200,
  },
  // Search input — underline border (HUD style).
  inputRow: { display: 'flex', gap: 8, marginBottom: 14 },
  input: {
    flex: 1, padding: '8px 4px', borderRadius: 0,
    background: 'transparent',
    border: 'none',
    borderBottom: `1px solid oklch(46% 0.06 ${HUE_STREAM} / 0.55)`,
    color: '#ffffff',
    fontSize: 14, outline: 'none',
    fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: '0.04em',
  },
  searchBtn: {
    ...mono,
    padding: '8px 16px',
    borderRadius: 2,
    background: 'transparent',
    border: `1px solid oklch(62% 0.19 ${HUE_STREAM} / 0.55)`,
    color: `oklch(78% 0.15 ${HUE_STREAM})`,
    fontSize: 11, fontWeight: 500, cursor: 'pointer', flexShrink: 0,
    textTransform: 'uppercase', letterSpacing: '0.14em',
  },
  // Anime result row (HUD pattern).
  animeRow: (hover) => ({
    position: 'relative',
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 12px', borderRadius: 2, marginBottom: 6,
    cursor: 'pointer', transition: 'background 150ms',
    background: hover ? `oklch(62% 0.19 ${HUE_STREAM} / 0.10)` : 'transparent',
    borderLeft: hover
      ? `2px solid oklch(62% 0.19 ${HUE_STREAM} / 0.85)`
      : '2px solid transparent',
  }),
  animeCover: {
    width: 44, aspectRatio: '3/4', borderRadius: 2, objectFit: 'cover',
    background: '#2c2c2e', flexShrink: 0,
  },
  animeInfo: { flex: 1, minWidth: 0 },
  animeTitle: {
    fontFamily: "'Sora',sans-serif",
    fontSize: 14, fontWeight: 600, color: '#ffffff',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  animeMeta: {
    ...mono,
    fontSize: 11, color: 'rgba(235,235,245,0.45)', marginTop: 3,
    letterSpacing: '0.06em',
  },
  // Episode row
  epRow: (selected) => ({
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '8px 12px', borderRadius: 2, marginBottom: 4,
    cursor: 'pointer', transition: 'background 150ms',
    background: selected ? `oklch(62% 0.19 ${HUE_STREAM} / 0.16)` : 'transparent',
    borderLeft: selected
      ? `2px solid oklch(62% 0.19 ${HUE_STREAM})`
      : '2px solid transparent',
  }),
  epNum: (selected) => ({
    ...mono,
    fontWeight: 600, fontSize: 12, width: 56, flexShrink: 0,
    color: selected ? `oklch(82% 0.15 ${HUE_STREAM})` : 'rgba(235,235,245,0.55)',
    letterSpacing: '0.10em',
  }),
  epTitle: {
    flex: 1, fontSize: 13, color: 'rgba(235,235,245,0.65)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  epCurrent: {
    ...mono,
    fontSize: 10,
    color: `oklch(72% 0.15 ${HUE})`,
    flexShrink: 0,
    textTransform: 'uppercase', letterSpacing: '0.14em',
  },
  confirmBtn: {
    ...mono,
    margin: '12px 24px 16px 56px',
    padding: '12px 0',
    borderRadius: 2,
    background: `oklch(62% 0.19 ${HUE} / 0.16)`,
    border: `1px solid oklch(62% 0.19 ${HUE} / 0.65)`,
    color: `oklch(82% 0.15 ${HUE})`,
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
    transition: 'opacity 150ms',
    textTransform: 'uppercase', letterSpacing: '0.16em',
  },
  backRow: {
    display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12,
  },
  backBtn: {
    background: 'transparent',
    border: '1px solid rgba(235,235,245,0.20)',
    borderRadius: 2,
    color: `oklch(78% 0.15 ${HUE_STREAM})`,
    fontSize: 12, cursor: 'pointer',
    padding: '4px 10px',
    fontFamily: "'JetBrains Mono',monospace",
  },
  backLabel: {
    ...mono,
    fontSize: 12, color: 'rgba(235,235,245,0.45)',
    letterSpacing: '0.04em',
  },
  loading: {
    ...mono,
    textAlign: 'center', padding: 32,
    color: 'rgba(235,235,245,0.45)', fontSize: 11,
    textTransform: 'uppercase', letterSpacing: '0.14em',
  },
  empty: {
    ...mono,
    textAlign: 'center', padding: 32,
    color: 'rgba(235,235,245,0.45)', fontSize: 11,
    textTransform: 'uppercase', letterSpacing: '0.14em',
  },
};

function AnimeRow({ item, onPick }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      style={s.animeRow(hover)}
      role="button"
      tabIndex={0}
      onClick={() => onPick(item)}
      onKeyDown={e => { if (e.key === 'Enter') onPick(item); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {(item.coverImageUrl || item.imageUrl) && (
        <img style={s.animeCover} src={item.coverImageUrl || item.imageUrl} alt="" loading="lazy" />
      )}
      <div style={s.animeInfo}>
        <div style={s.animeTitle}>{item.titleChinese || item.title}</div>
        <div style={s.animeMeta}>
          {item.seasonYear && `${item.seasonYear} `}
          {item.format && `· ${item.format} `}
          {item.episodes && `· ${item.episodes}集`}
        </div>
      </div>
    </div>
  );
}

export default function DanmakuPicker({ isOpen, onClose, onConfirm, currentAnime, currentEpisodeId, episodeNumber, defaultKeyword }) {
  const { t } = useLang();
  const reduced = useReducedMotion();
  const hasCurrentAnime = !!(currentAnime?.dandanAnimeId || currentAnime?.bgmId);
  const [tab, setTab] = useState(hasCurrentAnime ? 'current' : 'search');
  const [episodes, setEpisodes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);

  // Search tab state
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [pickedAnime, setPickedAnime] = useState(null);

  // Derive a default search keyword from the current anime
  const inferredKeyword = defaultKeyword
    || currentAnime?.titleNative
    || currentAnime?.titleRomaji
    || currentAnime?.titleChinese
    || '';

  // Load episodes for current anime on open + auto-search for search tab
  useEffect(() => {
    if (!isOpen) return;
    // Reset state
    setSelected(null);
    setPickedAnime(null);
    setSearchResults([]);
    setSearched(false);
    setTab(hasCurrentAnime ? 'current' : 'search');
    setQuery(inferredKeyword);

    if (hasCurrentAnime) {
      loadEpisodes(currentAnime.dandanAnimeId, currentAnime.bgmId);
    }

    // Auto-search so the search tab is not empty
    if (inferredKeyword) {
      autoSearch(inferredKeyword);
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const autoSearch = useCallback(async (kw) => {
    setSearchLoading(true);
    try {
      const data = await searchAnime(kw);
      setSearchResults(data.results || []);
    } catch {
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
      setSearched(true);
    }
  }, []);

  const loadEpisodes = useCallback(async (animeId, bgmId) => {
    setLoading(true);
    setEpisodes([]);
    try {
      const data = await getEpisodes(animeId || 0, bgmId);
      setEpisodes(data.episodes || []);
    } catch {
      setEpisodes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const doSearch = useCallback(async () => {
    if (!query.trim()) return;
    setSearchLoading(true);
    try {
      const data = await searchAnime(query.trim());
      setSearchResults(data.results || []);
    } catch {
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
      setSearched(true);
    }
  }, [query]);

  const handlePickAnime = useCallback((anime) => {
    setPickedAnime(anime);
    const animeId = anime.dandanAnimeId || 0;
    const bgmId = anime.bgmId;
    loadEpisodes(animeId, bgmId);
  }, [loadEpisodes]);

  const handleBackToSearch = useCallback(() => {
    setPickedAnime(null);
    setEpisodes([]);
    setSelected(null);
  }, []);

  const handleConfirm = useCallback(() => {
    if (!selected) return;
    onConfirm({
      dandanEpisodeId: selected.dandanEpisodeId,
      title: selected.title,
    }, pickedAnime || null);
  }, [selected, pickedAnime, onConfirm]);

  // ESC to close
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Determine what to show in the body based on tab + state
  const showEpisodeList = tab === 'current' || (tab === 'search' && pickedAnime);

  // Motion #10 — modal entrance: scale 0.96→1, opacity 0→1, 200ms
  const modalMotion = reduced
    ? { initial: false }
    : {
        initial: { opacity: 0, scale: 0.96 },
        animate: { opacity: 1, scale: 1 },
        transition: { duration: 0.2, ease: 'easeOut' },
      };

  return (
    <div style={s.overlay} onClick={onClose}>
      <Motion.div
        style={s.modal}
        onClick={e => e.stopPropagation()}
        {...modalMotion}
      >
        <ChapterBar hue={HUE} height={56} top={20} left={20} trigger="mount" />
        <CornerBrackets inset={6} size={10} opacity={0.36} hue={HUE} />

        {/* Header — HUD eyebrow + Sora title */}
        <div style={s.header}>
          <div style={s.headerEyebrow} aria-hidden>DANMAKU // PICKER</div>
          <div style={s.headerTitleRow}>
            <span style={s.headerTitle}>
              {t('player.setDanmaku')} — EP{String(episodeNumber).padStart(2, '0')}
              {currentAnime?.titleChinese && (
                <span style={s.headerSub}>
                  {currentAnime.titleChinese}
                </span>
              )}
            </span>
            <button style={s.closeBtn} onClick={onClose}>✕</button>
          </div>
        </div>

        {/* Tabs */}
        <div style={s.tabs}>
          {hasCurrentAnime && (
            <button style={s.tab(tab === 'current')} onClick={() => { setTab('current'); setSelected(null); }}>
              {t('player.currentAnime')}
            </button>
          )}
          <button style={s.tab(tab === 'search')} onClick={() => { setTab('search'); setSelected(null); }}>
            {t('player.searchOther')}
          </button>
        </div>

        {/* Body */}
        <div style={s.body}>
          {/* Search tab - anime search */}
          {tab === 'search' && !pickedAnime && (
            <>
              <div style={s.inputRow}>
                <input
                  style={s.input}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && doSearch()}
                  placeholder={t('player.searchPlaceholder')}
                  autoFocus
                />
                <button style={s.searchBtn} onClick={doSearch} disabled={searchLoading}>
                  {searchLoading ? '...' : t('player.searchBtn')}
                </button>
              </div>
              {searchResults.map((item, i) => (
                <AnimeRow
                  key={item.anilistId || item.dandanAnimeId || i}
                  item={item}
                  onPick={handlePickAnime}
                />
              ))}
              {searched && !searchResults.length && !searchLoading && (
                <div style={s.empty}>{t('player.noResults')}</div>
              )}
            </>
          )}

          {/* Search tab - picked anime, show back button */}
          {tab === 'search' && pickedAnime && (
            <div style={s.backRow}>
              <button style={s.backBtn} onClick={handleBackToSearch}>←</button>
              <span style={s.backLabel}>{pickedAnime.titleChinese || pickedAnime.title}</span>
            </div>
          )}

          {/* Episode list (both tabs) */}
          {showEpisodeList && loading && (
            <div style={s.loading}>{t('player.loadingEpisodes')}</div>
          )}
          {showEpisodeList && !loading && episodes.length === 0 && (
            <div style={s.empty}>{t('player.noEpisodesFound')}</div>
          )}
          {showEpisodeList && !loading && episodes.map(ep => {
            const isCurrent = ep.dandanEpisodeId === currentEpisodeId;
            const isSelected = selected?.dandanEpisodeId === ep.dandanEpisodeId;
            return (
              <div
                key={ep.dandanEpisodeId}
                style={s.epRow(isSelected)}
                role="button"
                tabIndex={0}
                onClick={() => setSelected(ep)}
                onKeyDown={e => { if (e.key === 'Enter') setSelected(ep); }}
              >
                <span style={s.epNum(isSelected)}>
                  {ep.number != null ? `EP${String(ep.number).padStart(2, '0')}` : ep.rawEpisodeNumber || '—'}
                </span>
                <span style={s.epTitle}>{ep.title || ''}</span>
                {isCurrent && <span style={s.epCurrent}>{t('player.currentMatch')}</span>}
              </div>
            );
          })}
        </div>

        {/* Confirm button */}
        {showEpisodeList && selected && (
          <button
            style={{ ...s.confirmBtn, opacity: selected ? 1 : 0.4 }}
            onClick={handleConfirm}
          >
            {t('player.confirmDanmaku')}
          </button>
        )}
      </Motion.div>
    </div>
  );
}
