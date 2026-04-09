import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../hooks/useSocial', () => ({
  useFeed: vi.fn(),
}))
vi.mock('../context/LanguageContext', () => ({
  useLang: vi.fn(),
}))
vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}))

import { useFeed } from '../hooks/useSocial'
import { useLang } from '../context/LanguageContext'
import { useAuth } from '../context/AuthContext'
import ActivityFeed from '../components/social/ActivityFeed'

const t = (key) => key

function renderFeed() {
  return render(
    <MemoryRouter>
      <ActivityFeed />
    </MemoryRouter>
  )
}

describe('ActivityFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useLang.mockReturnValue({ t, lang: 'zh' })
    useAuth.mockReturnValue({ user: { username: 'alice' } })
  })

  const noop = () => {}

  it('renders error message on error', () => {
    useFeed.mockReturnValue({ isLoading: false, isError: true, data: null, hasNextPage: false, fetchNextPage: noop, isFetchingNextPage: false })
    renderFeed()
    expect(screen.getByText('social.feedError')).toBeInTheDocument()
  })

  it('shows placeholder text when logged in but feed is empty', () => {
    useFeed.mockReturnValue({ isLoading: false, isError: false, data: { pages: [{ data: [] }] }, hasNextPage: false, fetchNextPage: noop, isFetchingNextPage: false })
    renderFeed()
    expect(screen.getByText('social.noActivity')).toBeInTheDocument()
  })

  it('shows loading skeletons while fetching', () => {
    useFeed.mockReturnValue({ isLoading: true, isError: false, data: undefined, hasNextPage: false, fetchNextPage: noop, isFetchingNextPage: false })
    const { container } = renderFeed()
    const skeletons = container.querySelectorAll('div[style*="shimmer"]')
    expect(skeletons).toHaveLength(4)
  })

  it('renders feed items when data is available', () => {
    useFeed.mockReturnValue({
      isLoading: false,
      isError: false,
      hasNextPage: false,
      fetchNextPage: noop,
      isFetchingNextPage: false,
      data: { pages: [{ data: [
        {
          username: 'bob',
          anilistId: 101,
          title: 'Test Anime',
          titleChinese: '测试动漫',
          status: 'watching',
          episode: 3,
          lastWatchedAt: new Date().toISOString(),
          coverImageUrl: null,
        },
      ] }] },
    })
    renderFeed()
    expect(screen.getByText('bob')).toBeInTheDocument()
    expect(screen.getByText('测试动漫')).toBeInTheDocument()
  })

  it('renders anime title in English when lang=en', () => {
    useLang.mockReturnValue({ t, lang: 'en' })
    useFeed.mockReturnValue({
      isLoading: false,
      isError: false,
      hasNextPage: false,
      fetchNextPage: noop,
      isFetchingNextPage: false,
      data: { pages: [{ data: [
        {
          username: 'bob',
          anilistId: 101,
          title: 'Test Anime',
          titleChinese: '测试动漫',
          status: 'completed',
          episode: 0,
          lastWatchedAt: new Date().toISOString(),
          coverImageUrl: null,
        },
      ] }] },
    })
    renderFeed()
    expect(screen.getByText('Test Anime')).toBeInTheDocument()
  })
})
