import { useQuery } from '@tanstack/react-query'
import { getSeasonalAnime, searchAnime, getAnimeDetail, getWeeklySchedule } from '../api/anime.api'

export function useSeasonalAnime(season, year, page = 1) {
  return useQuery({
    queryKey: ['seasonal', season, year, page],
    queryFn: () => getSeasonalAnime(season, year, page).then(r => r.data),
    keepPreviousData: true,
    staleTime: 5 * 60 * 1000,
    enabled: !!season && !!year
  })
}

export function useAnimeDetail(id) {
  return useQuery({
    queryKey: ['anime', id],
    queryFn: () => getAnimeDetail(id).then(r => r.data.data),
    enabled: !!id,
    staleTime: 10 * 60 * 1000
  })
}

export function useWeeklySchedule() {
  return useQuery({
    queryKey: ['weeklySchedule'],
    queryFn: () => getWeeklySchedule().then(r => r.data.data),
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false
  })
}

export function useAnimeSearch(q, genre, page = 1) {
  return useQuery({
    queryKey: ['search', q, genre, page],
    queryFn: () => searchAnime(q, genre, page).then(r => r.data),
    enabled: !!(q || genre),
    keepPreviousData: true,
    staleTime: 2 * 60 * 1000
  })
}
