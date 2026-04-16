import { useState, useCallback, useEffect } from 'react';
import { searchAnime, getEpisodes } from '../../api/dandanplay.api';
import { useLang } from '../../context/LanguageContext';

const s = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 9999,
    background: 'rgba(0,0,0,0.60)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    paddingTop: '8vh',
  },
  modal: {
    width: '100%', maxWidth: 720, maxHeight: '80vh',
    background: '#1c1c1e', borderRadius: 16,
    display: 'flex', flexDirection: 'column',
    border: '1px solid rgba(84,84,88,0.36)',
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '16px 20px 12px', borderBottom: '1px solid rgba(84,84,88,0.36)',
  },
  headerTitle: {
    fontFamily: "'Sora',sans-serif", fontWeight: 600,
    fontSize: 16, color: '#ffffff',
  },
  closeBtn: {
    background: 'none', border: 'none', color: 'rgba(235,235,245,0.60)',
    fontSize: 20, cursor: 'pointer', padding: '0 4px', lineHeight: 1,
  },
  tabs: {
    display: 'flex', gap: 8, padding: '12px 20px 0',
  },
  tab: (active) => ({
    padding: '6px 16px', borderRadius: 9999, fontSize: 13, fontWeight: 500,
    border: 'none', cursor: 'pointer',
    background: active ? 'rgba(10,132,255,0.15)' : 'rgba(120,120,128,0.12)',
    color: active ? '#0a84ff' : 'rgba(235,235,245,0.60)',
    transition: 'all 150ms',
  }),
  body: {
    flex: 1, overflowY: 'auto', padding: '12px 20px 20px',
    minHeight: 200,
  },
  // Search tab
  inputRow: { display: 'flex', gap: 8, marginBottom: 12 },
  input: {
    flex: 1, padding: '8px 14px', borderRadius: 8,
    background: '#2c2c2e', border: '1px solid rgba(84,84,88,0.65)',
    color: '#ffffff', fontSize: 14, outline: 'none',
  },
  searchBtn: {
    padding: '8px 16px', borderRadius: 8,
    background: '#0a84ff', color: '#fff', border: 'none',
    fontSize: 13, fontWeight: 500, cursor: 'pointer', flexShrink: 0,
  },
  // Anime result row (search tab step 1)
  animeRow: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 10px', borderRadius: 8, marginBottom: 6,
    cursor: 'pointer', transition: 'background 150ms',
  },
  animeCover: {
    width: 44, aspectRatio: '3/4', borderRadius: 6, objectFit: 'cover',
    background: '#2c2c2e', flexShrink: 0,
  },
  animeInfo: { flex: 1, minWidth: 0 },
  animeTitle: {
    fontSize: 14, fontWeight: 500, color: '#ffffff',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  animeMeta: { fontSize: 12, color: 'rgba(235,235,245,0.30)', marginTop: 2 },
  // Episode row
  epRow: (selected) => ({
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '8px 12px', borderRadius: 8, marginBottom: 4,
    cursor: 'pointer', transition: 'background 150ms',
    background: selected ? 'rgba(10,132,255,0.15)' : 'transparent',
  }),
  epNum: (selected) => ({
    fontWeight: 600, fontSize: 13, width: 48, flexShrink: 0,
    color: selected ? '#0a84ff' : 'rgba(235,235,245,0.60)',
    fontFamily: "'JetBrains Mono',monospace",
  }),
  epTitle: {
    flex: 1, fontSize: 13, color: 'rgba(235,235,245,0.60)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  epCurrent: {
    fontSize: 11, color: '#5ac8fa', flexShrink: 0,
  },
  confirmBtn: {
    margin: '12px 20px 16px', padding: '10px 0', borderRadius: 8,
    background: '#0a84ff', color: '#fff', border: 'none',
    fontSize: 14, fontWeight: 500, cursor: 'pointer',
    transition: 'opacity 150ms',
  },
  backRow: {
    display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10,
  },
  backBtn: {
    background: 'none', border: 'none', color: '#0a84ff',
    fontSize: 13, cursor: 'pointer', padding: 0,
  },
  backLabel: { fontSize: 13, color: 'rgba(235,235,245,0.40)' },
  loading: {
    textAlign: 'center', padding: 32,
    color: 'rgba(235,235,245,0.30)', fontSize: 13,
  },
  empty: {
    textAlign: 'center', padding: 32,
    color: 'rgba(235,235,245,0.30)', fontSize: 13,
  },
};

export default function DanmakuPicker({ isOpen, onClose, onConfirm, currentAnime, currentEpisodeId, episodeNumber, defaultKeyword }) {
  const { t } = useLang();
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

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={s.header}>
          <span style={s.headerTitle}>
            {t('player.setDanmaku')} — EP{String(episodeNumber).padStart(2, '0')}
          </span>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
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
                <div
                  key={item.anilistId || item.dandanAnimeId || i}
                  style={s.animeRow}
                  role="button"
                  tabIndex={0}
                  onClick={() => handlePickAnime(item)}
                  onKeyDown={e => { if (e.key === 'Enter') handlePickAnime(item); }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(10,132,255,0.12)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
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
                onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'rgba(120,120,128,0.08)'; }}
                onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
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
      </div>
    </div>
  );
}
