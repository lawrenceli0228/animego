import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

vi.mock('../hooks/useSocial', () => ({
  useUserProfile: vi.fn(),
}))
vi.mock('../context/LanguageContext', () => ({
  useLang: vi.fn(),
}))
vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}))
vi.mock('../components/social/FollowButton', () => ({
  default: () => <button data-testid="follow-btn">Follow</button>,
}))
vi.mock('../components/social/UserStatsPanel', () => ({
  default: () => <div data-testid="stats-panel" />,
}))
vi.mock('../components/anime/AnimeCard', () => ({
  default: ({ anime }) => <div data-testid={`card-${anime.anilistId}`} />,
}))
vi.mock('../components/common/LoadingSpinner', () => ({
  default: () => <div data-testid="spinner" />,
}))

import { useUserProfile } from '../hooks/useSocial'
import { useLang } from '../context/LanguageContext'
import { useAuth } from '../context/AuthContext'
import UserProfilePage from '../pages/UserProfilePage'

const t = (key) => key

function renderPage(username = 'bob') {
  return render(
    <MemoryRouter initialEntries={[`/u/${username}`]}>
      <Routes>
        <Route path="/u/:username" element={<UserProfilePage />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('UserProfilePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useLang.mockReturnValue({ t, lang: 'zh' })
    useAuth.mockReturnValue({ user: { username: 'alice' } })
  })

  it('shows loading spinner while fetching', () => {
    useUserProfile.mockReturnValue({ isLoading: true, isError: false, data: undefined })
    renderPage()
    expect(screen.getByTestId('spinner')).toBeInTheDocument()
  })

  it('shows error state when profile not found', () => {
    useUserProfile.mockReturnValue({ isLoading: false, isError: true, data: undefined })
    renderPage()
    expect(screen.getByText('social.userNotFound')).toBeInTheDocument()
  })

  it('renders profile header with username and follow counts', () => {
    useUserProfile.mockReturnValue({
      isLoading: false, isError: false,
      data: {
        username: 'bob', followerCount: 10, followingCount: 5,
        isFollowing: false, watching: [],
      },
    })
    renderPage()
    expect(screen.getByText('bob')).toBeInTheDocument()
    expect(screen.getByText('10')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
  })

  it('renders anime cards grouped by status', () => {
    useUserProfile.mockReturnValue({
      isLoading: false, isError: false,
      data: {
        username: 'bob', followerCount: 0, followingCount: 0,
        isFollowing: false,
        watching: [
          { anilistId: 101, subscriptionStatus: 'watching', currentEpisode: 3 },
          { anilistId: 102, subscriptionStatus: 'completed', currentEpisode: 12 },
        ],
      },
    })
    renderPage()
    expect(screen.getByTestId('card-101')).toBeInTheDocument()
    expect(screen.getByTestId('card-102')).toBeInTheDocument()
  })

  it('shows empty list message when no watching data', () => {
    useUserProfile.mockReturnValue({
      isLoading: false, isError: false,
      data: {
        username: 'bob', followerCount: 0, followingCount: 0,
        isFollowing: null, watching: [],
      },
    })
    renderPage()
    expect(screen.getByText('social.emptyList')).toBeInTheDocument()
  })

  it('sets document title to username', () => {
    useUserProfile.mockReturnValue({
      isLoading: false, isError: false,
      data: {
        username: 'bob', followerCount: 0, followingCount: 0,
        isFollowing: null, watching: [],
      },
    })
    renderPage()
    expect(document.title).toContain('bob')
  })

  it('renders stats panel and follow button', () => {
    useUserProfile.mockReturnValue({
      isLoading: false, isError: false,
      data: {
        username: 'bob', followerCount: 0, followingCount: 0,
        isFollowing: false, watching: [],
      },
    })
    renderPage()
    expect(screen.getByTestId('stats-panel')).toBeInTheDocument()
    expect(screen.getByTestId('follow-btn')).toBeInTheDocument()
  })
})
