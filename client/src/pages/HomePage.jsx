import { useState } from 'react'
import { getCurrentSeason, SEASON_LABELS } from '../utils/constants'
import { useSeasonalAnime } from '../hooks/useAnime'
import AnimeGrid from '../components/anime/AnimeGrid'
import Pagination from '../components/common/Pagination'

export default function HomePage() {
  const currentSeason = getCurrentSeason()
  const currentYear   = new Date().getFullYear()
  const [page, setPage] = useState(1)

  const { data, isLoading, error } = useSeasonalAnime(currentSeason, currentYear, page)

  return (
    <div className="container" style={{ paddingTop:40, paddingBottom:40 }}>
      <div style={{ marginBottom:28, animation:'fadeUp 0.4s ease' }}>
        <p style={{ color:'#7c3aed', fontSize:13, fontWeight:600, letterSpacing:'2px',
          textTransform:'uppercase', marginBottom:8 }}>当前季度</p>
        <h1 style={{ fontSize:'clamp(26px,4vw,40px)', background:'linear-gradient(135deg,#f1f5f9,#94a3b8)',
          WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent' }}>
          {SEASON_LABELS[currentSeason]} {currentYear}
        </h1>
      </div>
      <AnimeGrid animeList={data?.data} loading={isLoading} error={error} />
      <Pagination page={page} totalPages={data?.pagination?.totalPages} onPageChange={setPage} />
    </div>
  )
}
