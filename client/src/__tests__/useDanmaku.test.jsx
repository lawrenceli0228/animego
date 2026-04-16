import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useDanmakuHistory } from '../hooks/useDanmaku'

const mockGetDanmaku = vi.fn()

vi.mock('../api/danmaku.api', () => ({
  getDanmaku: (...args) => mockGetDanmaku(...args),
}))

vi.mock('../api/axiosClient', () => ({
  default: { get: vi.fn() },
  getAccessToken: () => 'mock-token',
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('useDanmakuHistory', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches danmaku history for an episode', async () => {
    const danmakuList = [
      { _id: 'd1', content: 'Hello', username: 'alice' },
      { _id: 'd2', content: 'World', username: 'bob' },
    ]
    mockGetDanmaku.mockResolvedValue({ data: danmakuList })

    const { result } = renderHook(() => useDanmakuHistory(101, 3, true), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(danmakuList)
    expect(mockGetDanmaku).toHaveBeenCalledWith(101, 3)
  })

  it('is disabled when enabled is false', () => {
    const { result } = renderHook(() => useDanmakuHistory(101, 3, false), {
      wrapper: createWrapper(),
    })
    expect(result.current.isFetching).toBe(false)
  })
})
