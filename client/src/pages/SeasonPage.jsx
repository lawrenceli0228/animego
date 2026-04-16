import { useState, useMemo, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getCurrentSeason } from '../utils/constants'
import { useSeasonalAnime } from '../hooks/useAnime'
import { useLang } from '../context/LanguageContext'
import { pickTitle } from '../utils/formatters'
import SeasonSelector from '../components/season/SeasonSelector'
import GenreFilter from '../components/search/GenreFilter'
import AnimeGrid from '../components/anime/AnimeGrid'

const FORMATS = ['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA']
const STATUSES = ['RELEASING', 'FINISHED', 'NOT_YET_RELEASED']

const FORMAT_LABELS = {
  zh: { TV: 'TV', TV_SHORT: 'TV短篇', MOVIE: '剧场版', SPECIAL: '特别篇', OVA: 'OVA', ONA: 'ONA' },
  en: { TV: 'TV', TV_SHORT: 'Short', MOVIE: 'Movie', SPECIAL: 'Special', OVA: 'OVA', ONA: 'ONA' },
}
const STATUS_LABELS = {
  zh: { RELEASING: '连载中', FINISHED: '已完结', NOT_YET_RELEASED: '未开播' },
  en: { RELEASING: 'Airing', FINISHED: 'Finished', NOT_YET_RELEASED: 'Upcoming' },
}
const SORT_OPTIONS = [
  { value: 'score', zh: '评分', en: 'Score' },
  { value: 'title', zh: '标题', en: 'Title' },
  { value: 'format', zh: '格式', en: 'Format' },
]

function ChipFilter({ options, labels, selected, onSelect, lang }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {options.map(o => (
        <button key={o} onClick={() => onSelect(selected === o ? '' : o)}
          style={{
            padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600,
            cursor: 'pointer', border: 'none', transition: 'all 0.2s',
            background: selected === o ? 'rgba(10,132,255,0.15)' : 'rgba(120,120,128,0.08)',
            color: selected === o ? '#0a84ff' : 'rgba(235,235,245,0.40)',
          }}>
          {labels[lang]?.[o] || o}
        </button>
      ))}
    </div>
  )
}

const INITIAL_COUNT = 20
const LOAD_MORE     = 20  // 4 rows × 5 cols

export default function SeasonPage() {
  const [params, setParams] = useSearchParams()
  const [visibleCount, setVisibleCount] = useState(INITIAL_COUNT)
  const [genre, setGenre] = useState('')
  const [format, setFormat] = useState('')
  const [status, setStatus] = useState('')
  const [sortBy, setSortBy] = useState('score')
  const { t, lang } = useLang()

  const season = params.get('season') || getCurrentSeason()
  const year   = Number(params.get('year')) || new Date().getFullYear()

  const SEASON_ZH = { WINTER: '冬', SPRING: '春', SUMMER: '夏', FALL: '秋' }
  useEffect(() => {
    const s = lang === 'zh' ? `${year}年${SEASON_ZH[season] || ''}季新番` : `${season} ${year} Anime`
    document.title = `${s} — AnimeGo`
    return () => { document.title = 'AnimeGo' }
  }, [season, year, lang])

  const setSeason = (s) => { setParams({ season: s, year }); setVisibleCount(INITIAL_COUNT) }
  const setYear   = (y) => { setParams({ season, year: y }); setVisibleCount(INITIAL_COUNT) }

  const { data, isLoading, error } = useSeasonalAnime(season, year, 1, 200)

  const filtered = useMemo(() => {
    if (!data?.data) return []
    let list = data.data
    if (genre)  list = list.filter(a => a.genres?.includes(genre))
    if (format) list = list.filter(a => a.format === format)
    if (status) list = list.filter(a => a.status === status)

    const sorted = [...list]
    switch (sortBy) {
      case 'title':
        sorted.sort((a, b) => pickTitle(a, lang).localeCompare(pickTitle(b, lang)))
        break
      case 'format':
        sorted.sort((a, b) => (FORMATS.indexOf(a.format) - FORMATS.indexOf(b.format)) || (b.averageScore ?? 0) - (a.averageScore ?? 0))
        break
      default: // score — already sorted from API
        break
    }
    return sorted
  }, [data?.data, genre, format, status, sortBy, lang])

  const displayed = filtered.slice(0, visibleCount)
  const hasMore   = visibleCount < filtered.length

  const resetFilters = () => { setGenre(''); setFormat(''); setStatus(''); setVisibleCount(INITIAL_COUNT) }
  const hasFilters = genre || format || status

  return (
    <div className="container" style={{ paddingTop: 40, paddingBottom: 40 }}>
      <h1 style={{ fontSize: 'clamp(22px,3vw,34px)', marginBottom: 24, color: '#ffffff' }}>
        {t('seasonPage.title')}
      </h1>
      <SeasonSelector year={year} season={season} onYearChange={setYear} onSeasonChange={setSeason} />

      {/* Filters */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
        <GenreFilter selected={genre} onSelect={g => { setGenre(g); setVisibleCount(INITIAL_COUNT) }} />
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <ChipFilter options={FORMATS} labels={FORMAT_LABELS} selected={format} onSelect={f => { setFormat(f); setVisibleCount(INITIAL_COUNT) }} lang={lang} />
          <div style={{ width: 1, height: 20, background: '#38383a' }} />
          <ChipFilter options={STATUSES} labels={STATUS_LABELS} selected={status} onSelect={s => { setStatus(s); setVisibleCount(INITIAL_COUNT) }} lang={lang} />
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select value={sortBy} onChange={e => setSortBy(e.target.value)}
            style={{
              padding: '6px 12px', borderRadius: 8, border: '1px solid #38383a',
              background: '#1c1c1e', color: 'rgba(235,235,245,0.60)', fontSize: 12,
              cursor: 'pointer', outline: 'none',
            }}>
            {SORT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{lang === 'zh' ? o.zh : o.en}</option>
            ))}
          </select>
          {hasFilters && (
            <button onClick={resetFilters} style={{
              padding: '5px 12px', borderRadius: 8, border: 'none',
              background: 'rgba(255,69,58,0.1)', color: '#ff453a',
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}>
              {lang === 'zh' ? '清除筛选' : 'Clear Filters'}
            </button>
          )}
          {!isLoading && (
            <span style={{ fontSize: 12, color: 'rgba(235,235,245,0.30)' }}>
              {filtered.length} {lang === 'zh' ? '部' : 'anime'}
            </span>
          )}
        </div>
      </div>

      <AnimeGrid animeList={displayed} loading={isLoading} error={error} />

      {hasMore && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 32 }}>
          <button
            onClick={() => setVisibleCount(v => v + LOAD_MORE)}
            style={{
              padding: '10px 36px', borderRadius: 10, border: '1px solid #38383a',
              background: 'rgba(120,120,128,0.08)', color: 'rgba(235,235,245,0.60)',
              fontSize: 14, fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s',
            }}
            onMouseEnter={e => { e.target.style.background = 'rgba(10,132,255,0.15)'; e.target.style.color = '#0a84ff'; e.target.style.borderColor = 'rgba(10,132,255,0.3)' }}
            onMouseLeave={e => { e.target.style.background = 'rgba(120,120,128,0.08)'; e.target.style.color = 'rgba(235,235,245,0.60)'; e.target.style.borderColor = '#38383a' }}
          >
            {lang === 'zh' ? '显示更多' : 'Show More'}
          </button>
        </div>
      )}
    </div>
  )
}
