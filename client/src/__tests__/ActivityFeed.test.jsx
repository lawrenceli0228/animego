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

  it('renders nothing on error', () => {
    useFeed.mockReturnValue({ isLoading: false, isError: true, data: null })
    const { container } = renderFeed()
    expect(container.firstChild).toBeNull()
  })

  it('shows placeholder text when logged in but feed is empty', () => {
    useFeed.mockReturnValue({ isLoading: false, isError: false, data: [] })
    renderFeed()
    expect(screen.getByText('social.noActivity')).toBeInTheDocument()
  })

  it('shows loading skeletons while fetching', () => {
    useFeed.mockReturnValue({ isLoading: true, isError: false, data: undefined })
    renderFeed()
    // Section renders with shimmer placeholders (4 skeleton divs)
    const section = document.querySelector('section')
    expect(section).toBeInTheDocument()
  })

  it('renders feed items when data is available', () => {
    useFeed.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [
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
      ],
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
      data: [
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
      ],
    })
    renderFeed()
    expect(screen.getByText('Test Anime')).toBeInTheDocument()
  })
})
