import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  useSeasonalAnime,
  useAnimeDetail,
  useWeeklySchedule,
  useAnimeSearch,
  useTorrents,
  useTrending,
  useWatchers,
  useCompletedGems,
  useYearlyTop,
} from '../hooks/useAnime'

const mockGetSeasonalAnime = vi.fn()
const mockSearchAnime = vi.fn()
const mockGetAnimeDetail = vi.fn()
const mockGetWeeklySchedule = vi.fn()
const mockGetTorrents = vi.fn()
const mockGetTrending = vi.fn()
const mockGetWatchers = vi.fn()
const mockGetCompletedGems = vi.fn()
const mockGetYearlyTop = vi.fn()

vi.mock('../api/anime.api', () => ({
  getSeasonalAnime: (...args) => mockGetSeasonalAnime(...args),
  searchAnime: (...args) => mockSearchAnime(...args),
  getAnimeDetail: (...args) => mockGetAnimeDetail(...args),
  getWeeklySchedule: (...args) => mockGetWeeklySchedule(...args),
  getTorrents: (...args) => mockGetTorrents(...args),
  getTrending: (...args) => mockGetTrending(...args),
  getWatchers: (...args) => mockGetWatchers(...args),
  getCompletedGems: (...args) => mockGetCompletedGems(...args),
  getYearlyTop: (...args) => mockGetYearlyTop(...args),
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('useSeasonalAnime', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches seasonal anime with correct params', async () => {
    mockGetSeasonalAnime.mockResolvedValue({ data: { data: [{ anilistId: 1 }] } })

    const { result } = renderHook(() => useSeasonalAnime('WINTER', 2025, 1, 20), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(mockGetSeasonalAnime).toHaveBeenCalledWith('WINTER', 2025, 1, 20)
  })

  it('is disabled when season or year is falsy', () => {
    const { result } = renderHook(() => useSeasonalAnime(null, null), {
      wrapper: createWrapper(),
    })
    expect(result.current.isFetching).toBe(false)
  })
})

describe('useAnimeDetail', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches anime detail by id', async () => {
    mockGetAnimeDetail.mockResolvedValue({ data: { data: { anilistId: 101, title: 'Test' } } })

    const { result } = renderHook(() => useAnimeDetail(101), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual({ anilistId: 101, title: 'Test' })
  })

  it('is disabled when id is falsy', () => {
    const { result } = renderHook(() => useAnimeDetail(null), {
      wrapper: createWrapper(),
    })
    expect(result.current.isFetching).toBe(false)
  })
})

describe('useWeeklySchedule', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches weekly schedule', async () => {
    const schedule = [{ day: 'Monday', anime: [] }]
    mockGetWeeklySchedule.mockResolvedValue({ data: { data: schedule } })

    const { result } = renderHook(() => useWeeklySchedule(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(schedule)
  })
})

describe('useAnimeSearch', () => {
  beforeEach(() => vi.clearAllMocks())

  it('searches anime by query', async () => {
    mockSearchAnime.mockResolvedValue({ data: { data: [{ anilistId: 1 }] } })

    const { result } = renderHook(() => useAnimeSearch('naruto', null, 1), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(mockSearchAnime).toHaveBeenCalledWith('naruto', null, 1)
  })

  it('is disabled when neither q nor genre is provided', () => {
    const { result } = renderHook(() => useAnimeSearch(null, null), {
      wrapper: createWrapper(),
    })
    expect(result.current.isFetching).toBe(false)
  })

  it('enables when genre is provided without query', async () => {
    mockSearchAnime.mockResolvedValue({ data: { data: [] } })

    const { result } = renderHook(() => useAnimeSearch(null, 'Action', 1), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(mockSearchAnime).toHaveBeenCalledWith(null, 'Action', 1)
  })
})

describe('useTorrents', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches torrents for a query', async () => {
    mockGetTorrents.mockResolvedValue({ data: { data: [{ title: 'Torrent 1' }] } })

    const { result } = renderHook(() => useTorrents('naruto'), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual([{ title: 'Torrent 1' }])
  })

  it('is disabled when query is empty', () => {
    const { result } = renderHook(() => useTorrents(''), {
      wrapper: createWrapper(),
    })
    expect(result.current.isFetching).toBe(false)
  })
})

describe('useTrending', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches trending anime with default limit', async () => {
    mockGetTrending.mockResolvedValue({ data: { data: [{ anilistId: 1 }] } })

    const { result } = renderHook(() => useTrending(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(mockGetTrending).toHaveBeenCalledWith(10)
  })
})

describe('useWatchers', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches watchers for an anime', async () => {
    mockGetWatchers.mockResolvedValue({ data: { data: [{ username: 'alice' }], total: 1 } })

    const { result } = renderHook(() => useWatchers(101), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(mockGetWatchers).toHaveBeenCalledWith(101, 5)
  })

  it('is disabled when anilistId is falsy', () => {
    const { result } = renderHook(() => useWatchers(null), {
      wrapper: createWrapper(),
    })
    expect(result.current.isFetching).toBe(false)
  })
})

describe('useYearlyTop', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches yearly top anime', async () => {
    mockGetYearlyTop.mockResolvedValue({ data: { data: [{ anilistId: 1 }] } })

    const { result } = renderHook(() => useYearlyTop(2024), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(mockGetYearlyTop).toHaveBeenCalledWith(2024, 10)
  })

  it('is disabled when year is falsy', () => {
    const { result } = renderHook(() => useYearlyTop(null), {
      wrapper: createWrapper(),
    })
    expect(result.current.isFetching).toBe(false)
  })
})

describe('useCompletedGems', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches completed gems with default limit', async () => {
    mockGetCompletedGems.mockResolvedValue({ data: { data: [{ anilistId: 42 }] } })

    const { result } = renderHook(() => useCompletedGems(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual([{ anilistId: 42 }])
    expect(mockGetCompletedGems).toHaveBeenCalledWith(6)
  })
})
