import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getSeasonalAnime, searchAnime, getAnimeDetail, getWeeklySchedule, getTorrents, getTrending, getWatchers } from '../api/anime.api'

export function useSeasonalAnime(season, year, page = 1) {
  return useQuery({
    queryKey: ['seasonal', season, year, page],
    queryFn: () => getSeasonalAnime(season, year, page).then(r => r.data),
    keepPreviousData: true,
    staleTime: 1 * 60 * 1000,
    enabled: !!season && !!year,
    refetchInterval: (data) => {
      const items = data?.data ?? []
      return items.length > 0 && items.some(a => !a.bangumiVersion) ? 20 * 1000 : false
    }
  })
}

export function useAnimeDetail(id) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: ['anime', id],
    queryFn: () => getAnimeDetail(id).then(r => r.data.data),
    enabled: !!id,
    staleTime: 0,
    placeholderData: () => {
      const numId = Number(id)
      for (const [, d] of queryClient.getQueriesData({ queryKey: ['seasonal'] })) {
        const hit = d?.data?.find(a => a.anilistId === numId)
        if (hit) return hit
      }
      for (const [, d] of queryClient.getQueriesData({ queryKey: ['trending'] })) {
        if (Array.isArray(d)) {
          const hit = d.find(a => a.anilistId === numId)
          if (hit) return hit
        }
      }
      for (const [, d] of queryClient.getQueriesData({ queryKey: ['search'] })) {
        const hit = d?.data?.find(a => a.anilistId === numId)
        if (hit) return hit
      }
      return undefined
    },
    refetchInterval: (data) => {
      const anime = data?.data ?? data
      if (!anime) return false
      if ((anime.bangumiVersion ?? 0) < 2) return 4000
      if (anime.episodes > 0 && !anime.episodeTitles?.length) return 4000
      return false
    }
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

export function useTorrents(q) {
  return useQuery({
    queryKey: ['torrents', q],
    queryFn: () => getTorrents(q).then(r => r.data.data),
    enabled: !!q,
    staleTime: 5 * 60 * 1000,
    retry: false
  })
}

export function useTrending(limit = 10) {
  return useQuery({
    queryKey: ['trending', limit],
    queryFn: () => getTrending(limit).then(r => r.data.data),
    staleTime: 60 * 60 * 1000,
    retry: false
  })
}

export function useWatchers(anilistId, limit = 5) {
  return useQuery({
    queryKey: ['watchers', anilistId, limit],
    queryFn: () => getWatchers(anilistId, limit).then(r => r.data),
    enabled: !!anilistId,
    staleTime: 5 * 60 * 1000,
    retry: false
  })
}
