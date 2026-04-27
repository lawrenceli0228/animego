import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAnimeSearch } from '../hooks/useAnime'
import { useLang } from '../context/LanguageContext'
import SearchBar from '../components/search/SearchBar'
import GenreFilter from '../components/search/GenreFilter'
import AnimeGrid from '../components/anime/AnimeGrid'
import Pagination from '../components/common/Pagination'

export default function SearchPage() {
  const [params, setParams] = useSearchParams()
  const [page, setPage] = useState(1)
  const { t, lang } = useLang()

  const q     = params.get('q') || ''
  const genre = params.get('genre') || ''

  const setQ     = (v) => { setParams({ q: v, genre }); setPage(1) }
  const setGenre = (v) => { setParams({ q, genre: v }); setPage(1) }

  const { data, isLoading, error } = useAnimeSearch(q, genre, page)

  // Dynamic heading reflects the active query — both for users and for clients
  // that read DOM text (Bing/百度 client renderers, accessibility tools).
  const heading = q
    ? (lang === 'zh' ? `搜索"${q}"的动画结果` : `Search results for "${q}"`)
    : genre
      ? (lang === 'zh' ? `${genre} 类型的动画` : `${genre} anime`)
      : t('search.title')

  // Document title mirrors heading so SPA navigations show the right tab title.
  useEffect(() => {
    const suffix = ' — AnimeGoClub'
    document.title = heading + suffix
    return () => { document.title = 'AnimeGoClub' }
  }, [heading])

  return (
    <div className="container" style={{ paddingTop:40, paddingBottom:40 }}>
      <h1 style={{ fontSize:'clamp(22px,3vw,34px)', marginBottom:24,
        background:'linear-gradient(135deg,#ffffff,rgba(235,235,245,0.60))',
        WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent' }}>
        {heading}
      </h1>
      <div style={{ display:'flex', gap:12, flexWrap:'wrap', marginBottom:20 }}>
        <SearchBar value={q} onChange={setQ} />
      </div>
      <GenreFilter selected={genre} onSelect={setGenre} />
      {!q && !genre ? (
        <div style={{ textAlign:'center', padding:'60px 0', color:'rgba(235,235,245,0.30)',
          fontFamily:"'Sora',sans-serif", fontSize:15 }}>
          {t('search.prompt')}
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
