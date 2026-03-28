import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import EpisodeList from '../components/anime/EpisodeList'
import { LanguageProvider } from '../context/LanguageContext'
import { AuthProvider } from '../context/AuthContext'

// Mock child components that have complex dependencies
vi.mock('../components/anime/DanmakuSection', () => ({
  default: () => <div data-testid="danmaku-section" />,
}))
vi.mock('../components/anime/EpisodeComments', () => ({
  default: () => <div data-testid="episode-comments" />,
}))
vi.mock('../hooks/useSubscription', () => ({
  useSubscription: vi.fn(),
}))

import { useSubscription } from '../hooks/useSubscription'

const anime4eps = { anilistId: 1, episodes: 4 }

function renderList(currentEpisode = 0, episodes = 4) {
  useSubscription.mockReturnValue({ data: { currentEpisode } })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <LanguageProvider>
          <AuthProvider>
            <EpisodeList anime={{ anilistId: 1, episodes }} />
          </AuthProvider>
        </LanguageProvider>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('EpisodeList — highlight logic (currentEpisode = 3)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders all 4 episode buttons', () => {
    renderList(3, 4)
    // Each ep block contains the episode number
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
  })

  it('shows ✓ checkmark for watched episodes (ep < currentEp)', () => {
    renderList(3, 4)
    const checks = screen.getAllByText('✓')
    // ep1 and ep2 are watched (< 3)
    expect(checks).toHaveLength(2)
  })

  it('shows ▶ indicator for current episode', () => {
    renderList(3, 4)
    const current = screen.getAllByText('▶')
    expect(current).toHaveLength(1)
  })

  it('shows no ✓ or ▶ when currentEpisode is 0', () => {
    renderList(0, 4)
    expect(screen.queryAllByText('✓')).toHaveLength(0)
    expect(screen.queryAllByText('▶')).toHaveLength(0)
  })

  it('shows no ✓ when currentEpisode is 1 (first ep, nothing watched yet)', () => {
    renderList(1, 4)
    expect(screen.queryAllByText('✓')).toHaveLength(0)
    expect(screen.getAllByText('▶')).toHaveLength(1)
  })

  it('renders nothing when anime has no episode count', () => {
    useSubscription.mockReturnValue({ data: null })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <LanguageProvider>
            <AuthProvider>
              <EpisodeList anime={{ anilistId: 1, episodes: null }} />
            </AuthProvider>
          </LanguageProvider>
        </QueryClientProvider>
      </MemoryRouter>
    )
    expect(screen.queryByText('1')).not.toBeInTheDocument()
  })
})
