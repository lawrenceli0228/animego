import { useState, useCallback } from 'react';
import { searchAnime } from '../../api/dandanplay.api';
import { useLang } from '../../context/LanguageContext';

const s = {
  container: { maxWidth: 600, margin: '0 auto' },
  hint: {
    fontSize: 14, color: 'rgba(235,235,245,0.60)', marginBottom: 16, textAlign: 'center',
  },
  inputRow: {
    display: 'flex', gap: 8, marginBottom: 20,
  },
  input: {
    flex: 1, padding: '10px 16px', borderRadius: 8,
    background: '#2c2c2e', border: '1px solid rgba(84,84,88,0.65)',
    color: '#ffffff', fontSize: 16, outline: 'none',
  },
  searchBtn: {
    padding: '10px 20px', borderRadius: 8,
    background: '#0a84ff', color: '#fff', border: 'none',
    fontSize: 14, fontWeight: 500, cursor: 'pointer', flexShrink: 0,
  },
  resultRow: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '10px 12px', borderRadius: 8, marginBottom: 8,
    transition: 'background 150ms',
    cursor: 'pointer',
  },
  cover: {
    width: 60, height: 84, borderRadius: 8, objectFit: 'cover',
    background: '#2c2c2e', flexShrink: 0,
  },
  info: { flex: 1, minWidth: 0 },
  title: {
    fontSize: 15, fontWeight: 500, color: '#ffffff',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  meta: { fontSize: 13, color: 'rgba(235,235,245,0.30)', marginTop: 4 },
  selectBtn: {
    padding: '6px 14px', borderRadius: 8,
    background: 'rgba(120,120,128,0.12)', border: 'none',
    color: '#0a84ff', fontSize: 14, fontWeight: 500,
    cursor: 'pointer', flexShrink: 0,
  },
  empty: {
    textAlign: 'center', padding: 32,
    color: 'rgba(235,235,245,0.30)', fontSize: 14,
  },
  backBtn: {
    background: 'none', border: 'none', color: 'rgba(235,235,245,0.60)',
    fontSize: 14, cursor: 'pointer', marginBottom: 16,
  },
};

export default function ManualSearch({ defaultKeyword, onSelect, onBack }) {
  const { t } = useLang();
  const [query, setQuery] = useState(defaultKeyword || '');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const doSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const data = await searchAnime(query.trim());
      setResults(data.results || []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
      setSearched(true);
    }
  }, [query]);

  return (
    <div style={s.container}>
      <button style={s.backBtn} onClick={onBack}>← {t('player.back')}</button>
      <div style={s.hint}>{t('player.manualHint')}</div>
      <div style={s.inputRow}>
        <input
          style={s.input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSearch()}
          placeholder={t('player.searchPlaceholder')}
        />
        <button style={s.searchBtn} onClick={doSearch} disabled={loading}>
          {loading ? '...' : t('player.searchBtn')}
        </button>
      </div>

      {results.map((item, i) => (
        <div
          key={item.anilistId || item.dandanAnimeId || i}
          style={s.resultRow}
          onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(10,132,255,0.12)'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
        >
          <img
            style={s.cover}
            src={item.coverImageUrl || item.imageUrl || ''}
            alt=""
            loading="lazy"
          />
          <div style={s.info}>
            <div style={s.title}>{item.titleChinese || item.title}</div>
            <div style={s.meta}>
              {item.seasonYear && `${item.seasonYear} `}
              {item.format && `· ${item.format} `}
              {item.episodes && `· ${item.episodes}${t('detail.epUnit')}`}
              {item.averageScore && ` · ★ ${item.averageScore}`}
            </div>
          </div>
          <button style={s.selectBtn} onClick={() => onSelect(item)}>
            {t('player.select')}
          </button>
        </div>
      ))}

      {searched && !results.length && !loading && (
        <div style={s.empty}>{t('player.noResults')}</div>
      )}
    </div>
  );
}
