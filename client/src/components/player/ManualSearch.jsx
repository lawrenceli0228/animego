import { useState, useCallback } from 'react';
import { useLang } from '../../context/LanguageContext';
import { searchAnime } from '../../api/dandanplay.api';
import { ChapterBar, CornerBrackets } from '../shared/hud';
import { mono, PLAYER_HUE } from '../shared/hud-tokens';

const HUE = PLAYER_HUE.ingest;
const HUE_STREAM = PLAYER_HUE.stream;

const s = {
  container: {
    position: 'relative',
    maxWidth: 600, margin: '0 auto',
    padding: '24px 28px 28px 56px',
    background: `linear-gradient(180deg, oklch(14% 0.04 ${HUE} / 0.55) 0%, rgba(20,20,22,0.55) 100%)`,
    border: `1px solid oklch(46% 0.06 ${HUE} / 0.36)`,
    borderRadius: 4,
  },
  backBtn: {
    ...mono,
    background: 'transparent',
    border: '1px solid rgba(235,235,245,0.20)',
    borderRadius: 2,
    color: 'rgba(235,235,245,0.75)',
    fontSize: 11, cursor: 'pointer',
    padding: '6px 12px',
    marginBottom: 18,
    textTransform: 'uppercase', letterSpacing: '0.14em',
  },
  hint: {
    ...mono,
    fontSize: 11,
    color: `oklch(72% 0.15 ${HUE} / 0.85)`,
    marginBottom: 18,
    textTransform: 'uppercase',
    letterSpacing: '0.16em',
  },
  inputRow: {
    display: 'flex', gap: 8, marginBottom: 22,
  },
  input: {
    flex: 1, padding: '10px 4px',
    background: 'transparent',
    border: 'none',
    borderBottom: `1px solid oklch(46% 0.06 ${HUE_STREAM} / 0.55)`,
    color: '#ffffff', fontSize: 16, outline: 'none',
    fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: '0.04em',
  },
  searchBtn: {
    ...mono,
    padding: '10px 18px',
    borderRadius: 2,
    background: 'transparent',
    border: `1px solid oklch(62% 0.19 ${HUE_STREAM} / 0.55)`,
    color: `oklch(78% 0.15 ${HUE_STREAM})`,
    fontSize: 11, fontWeight: 500, cursor: 'pointer', flexShrink: 0,
    textTransform: 'uppercase', letterSpacing: '0.14em',
  },
  resultRow: (hover) => ({
    position: 'relative',
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '10px 14px', borderRadius: 2, marginBottom: 8,
    transition: 'background 150ms, border-color 150ms',
    cursor: 'pointer',
    background: hover ? `oklch(62% 0.19 ${HUE_STREAM} / 0.10)` : 'transparent',
    borderLeft: hover
      ? `2px solid oklch(62% 0.19 ${HUE_STREAM} / 0.85)`
      : '2px solid transparent',
  }),
  cover: {
    width: 60, aspectRatio: '3/4', borderRadius: 2, objectFit: 'cover',
    background: '#2c2c2e', flexShrink: 0,
  },
  info: { flex: 1, minWidth: 0 },
  title: {
    fontFamily: "'Sora',sans-serif",
    fontSize: 15, fontWeight: 600, color: '#ffffff',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  meta: {
    ...mono,
    fontSize: 11, color: 'rgba(235,235,245,0.45)', marginTop: 4,
    letterSpacing: '0.06em',
  },
  selectBtn: {
    ...mono,
    padding: '6px 14px',
    borderRadius: 2,
    background: 'transparent',
    border: `1px solid oklch(62% 0.19 ${HUE} / 0.50)`,
    color: `oklch(78% 0.15 ${HUE})`,
    fontSize: 11, fontWeight: 500,
    cursor: 'pointer', flexShrink: 0,
    textTransform: 'uppercase', letterSpacing: '0.14em',
  },
  empty: {
    ...mono,
    textAlign: 'center', padding: 32,
    color: 'rgba(235,235,245,0.45)', fontSize: 11,
    textTransform: 'uppercase', letterSpacing: '0.14em',
  },
};

function ResultRow({ item, onSelect, t }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      style={s.resultRow(hover)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
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
  );
}

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
      <ChapterBar hue={HUE} height={48} top={20} left={20} trigger="mount" />
      <CornerBrackets inset={6} size={10} opacity={0.32} hue={HUE} />

      <button style={s.backBtn} onClick={onBack}>← {t('player.back')}</button>
      <div style={s.hint}>// {t('player.manualHint')}</div>
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
        <ResultRow
          key={item.anilistId || item.dandanAnimeId || i}
          item={item}
          onSelect={onSelect}
          t={t}
        />
      ))}

      {searched && !results.length && !loading && (
        <div style={s.empty}>{t('player.noResults')}</div>
      )}
    </div>
  );
}
