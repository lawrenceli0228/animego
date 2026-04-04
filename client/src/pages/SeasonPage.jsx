import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getCurrentSeason } from '../utils/constants'
import { useSeasonalAnime } from '../hooks/useAnime'
import { useLang } from '../context/LanguageContext'
import SeasonSelector from '../components/season/SeasonSelector'
import GenreFilter from '../components/search/GenreFilter'
import AnimeGrid from '../components/anime/AnimeGrid'
import Pagination from '../components/common/Pagination'

export default function SeasonPage() {
  const [params, setParams] = useSearchParams()
  const [page, setPage] = useState(1)
  const [genre, setGenre] = useState('')
  const { t } = useLang()

  const season = params.get('season') || getCurrentSeason()
  const year   = Number(params.get('year')) || new Date().getFullYear()

  const setSeason = (s) => { setParams({ season: s, year }); setPage(1) }
  const setYear   = (y) => { setParams({ season, year: y }); setPage(1) }

  const { data, isLoading, error, dataUpdatedAt } = useSeasonalAnime(season, year, page)

  const filtered = genre && data?.data
    ? data.data.filter(a => a.genres?.includes(genre))
    : data?.data

  return (
    <div className="container" style={{ paddingTop:40, paddingBottom:40 }}>
      <h1 style={{ fontSize:'clamp(22px,3vw,34px)', marginBottom:24, color:'#ffffff' }}>
        {t('seasonPage.title')}
      </h1>
      <SeasonSelector year={year} season={season} onYearChange={setYear} onSeasonChange={setSeason} />
      <GenreFilter selected={genre} onSelect={g => { setGenre(g); setPage(1) }} />
      <AnimeGrid key={dataUpdatedAt} animeList={filtered} loading={isLoading} error={error} />
      <Pagination page={page} totalPages={data?.pagination?.totalPages} onPageChange={setPage} />
    </div>
  )
}
