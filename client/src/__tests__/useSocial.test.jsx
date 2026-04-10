import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useUserProfile, useFollow, useFollowList, useFeed } from '../hooks/useSocial'

const mockGetUserProfile = vi.fn()
const mockFollowUser = vi.fn()
const mockUnfollowUser = vi.fn()
const mockGetFollowers = vi.fn()
const mockGetFollowing = vi.fn()
const mockGetFeed = vi.fn()

vi.mock('../api/social.api', () => ({
  getUserProfile: (...args) => mockGetUserProfile(...args),
  followUser: (...args) => mockFollowUser(...args),
  unfollowUser: (...args) => mockUnfollowUser(...args),
  getFollowers: (...args) => mockGetFollowers(...args),
  getFollowing: (...args) => mockGetFollowing(...args),
  getFeed: (...args) => mockGetFeed(...args),
}))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { username: 'me' } }),
}))

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({ t: (key) => key }),
}))

vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('useUserProfile', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches user profile by username', async () => {
    mockGetUserProfile.mockResolvedValue({ data: { data: { username: 'alice', followersCount: 5 } } })

    const { result } = renderHook(() => useUserProfile('alice'), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual({ username: 'alice', followersCount: 5 })
  })

  it('is disabled when username is falsy', () => {
    const { result } = renderHook(() => useUserProfile(null), { wrapper: createWrapper() })
    expect(result.current.isFetching).toBe(false)
  })
})

describe('useFollow', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls followUser API on follow()', async () => {
    mockFollowUser.mockResolvedValue({ data: { success: true } })

    const { result } = renderHook(() => useFollow('alice'), { wrapper: createWrapper() })

    await act(async () => result.current.follow())
    await waitFor(() => expect(mockFollowUser).toHaveBeenCalledWith('alice'))
  })

  it('calls unfollowUser API on unfollow()', async () => {
    mockUnfollowUser.mockResolvedValue({ data: { success: true } })

    const { result } = renderHook(() => useFollow('alice'), { wrapper: createWrapper() })

    await act(async () => result.current.unfollow())
    await waitFor(() => expect(mockUnfollowUser).toHaveBeenCalledWith('alice'))
  })
})

describe('useFollowList', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches followers list', async () => {
    mockGetFollowers.mockResolvedValue({ data: { data: [{ username: 'bob' }] } })

    const { result } = renderHook(() => useFollowList('alice', 'followers'), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(mockGetFollowers).toHaveBeenCalledWith('alice')
  })

  it('fetches following list', async () => {
    mockGetFollowing.mockResolvedValue({ data: { data: [{ username: 'carol' }] } })

    const { result } = renderHook(() => useFollowList('alice', 'following'), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(mockGetFollowing).toHaveBeenCalledWith('alice')
  })

  it('is disabled when username or type is missing', () => {
    const { result } = renderHook(() => useFollowList(null, null), { wrapper: createWrapper() })
    expect(result.current.isFetching).toBe(false)
  })
})

describe('useFeed', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches activity feed for logged-in user', async () => {
    mockGetFeed.mockResolvedValue({ data: { data: [{ type: 'follow' }], nextPage: null } })

    const { result } = renderHook(() => useFeed(), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(mockGetFeed).toHaveBeenCalledWith(1)
  })
})
