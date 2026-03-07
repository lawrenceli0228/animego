import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAnimeSearch } from '../hooks/useAnime'
import SearchBar from '../components/search/SearchBar'
import GenreFilter from '../components/search/GenreFilter'
import AnimeGrid from '../components/anime/AnimeGrid'
import Pagination from '../components/common/Pagination'

export default function SearchPage() {
  const [params, setParams] = useSearchParams()
  const [page, setPage] = useState(1)

  const q     = params.get('q') || ''
  const genre = params.get('genre') || ''

  const setQ     = (v) => { setParams({ q: v, genre }); setPage(1) }
  const setGenre = (v) => { setParams({ q, genre: v }); setPage(1) }

  const { data, isLoading, error } = useAnimeSearch(q, genre, page)

  return (
    <div className="container" style={{ paddingTop:40, paddingBottom:40 }}>
      <h1 style={{ fontSize:'clamp(22px,3vw,34px)', marginBottom:24,
        background:'linear-gradient(135deg,#f1f5f9,#94a3b8)',
        WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent' }}>
        搜索番剧
      </h1>
      <div style={{ display:'flex', gap:12, flexWrap:'wrap', marginBottom:20 }}>
        <SearchBar value={q} onChange={setQ} />
      </div>
      <GenreFilter selected={genre} onSelect={setGenre} />
      {!q && !genre ? (
        <div style={{ textAlign:'center', padding:'60px 0', color:'#64748b',
          fontFamily:"'Sora',sans-serif", fontSize:15 }}>
          输入关键词或选择类型开始搜索
        </div>
      ) : (
        <>
          <AnimeGrid animeList={data?.data} loading={isLoading} error={error} />
          <Pagination page={page} totalPages={data?.pagination?.totalPages} onPageChange={setPage} />
        </>
      )}
    </div>
  )
}
