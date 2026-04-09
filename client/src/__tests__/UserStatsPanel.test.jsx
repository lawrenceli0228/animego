import { render, screen } from '@testing-library/react'

vi.mock('../context/LanguageContext', () => ({
  useLang: vi.fn(),
}))

import { useLang } from '../context/LanguageContext'
import UserStatsPanel from '../components/social/UserStatsPanel'

const t = (key) => key

describe('UserStatsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useLang.mockReturnValue({ t, lang: 'zh' })
  })

  it('returns null when watching list is empty', () => {
    const { container } = render(<UserStatsPanel watching={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders donut chart with total count', () => {
    const watching = [
      { subscriptionStatus: 'watching', currentEpisode: 5, genres: ['Action'], season: 'SPRING', seasonYear: 2026 },
      { subscriptionStatus: 'completed', currentEpisode: 12, genres: ['Action', 'Comedy'], season: 'SPRING', seasonYear: 2026 },
    ]
    render(<UserStatsPanel watching={watching} />)
    // Total count in SVG center
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('displays total episodes watched', () => {
    const watching = [
      { subscriptionStatus: 'watching', currentEpisode: 5, genres: [] },
      { subscriptionStatus: 'watching', currentEpisode: 10, genres: [] },
    ]
    render(<UserStatsPanel watching={watching} />)
    expect(screen.getByText('15')).toBeInTheDocument()
    expect(screen.getByText('social.statsEpisodes')).toBeInTheDocument()
  })

  it('displays top genres', () => {
    const watching = [
      { subscriptionStatus: 'watching', currentEpisode: 1, genres: ['Action', 'Comedy'] },
      { subscriptionStatus: 'watching', currentEpisode: 1, genres: ['Action', 'Drama'] },
      { subscriptionStatus: 'completed', currentEpisode: 1, genres: ['Comedy'] },
    ]
    render(<UserStatsPanel watching={watching} />)
    expect(screen.getByText('Action')).toBeInTheDocument()
    expect(screen.getByText('Comedy')).toBeInTheDocument()
  })

  it('displays status legend for non-zero statuses', () => {
    const watching = [
      { subscriptionStatus: 'watching', currentEpisode: 3, genres: [] },
      { subscriptionStatus: 'dropped', currentEpisode: 1, genres: [] },
    ]
    render(<UserStatsPanel watching={watching} />)
    expect(screen.getByText('sub.watching')).toBeInTheDocument()
    expect(screen.getByText('sub.dropped')).toBeInTheDocument()
  })

  it('displays most active season', () => {
    useLang.mockReturnValue({
      t: (key) => {
        if (key === 'season.SPRING') return '春季'
        return key
      },
      lang: 'zh',
    })
    const watching = [
      { subscriptionStatus: 'watching', currentEpisode: 1, genres: [], season: 'SPRING', seasonYear: 2026 },
      { subscriptionStatus: 'watching', currentEpisode: 1, genres: [], season: 'SPRING', seasonYear: 2026 },
    ]
    render(<UserStatsPanel watching={watching} />)
    expect(screen.getByText('2026 春季')).toBeInTheDocument()
  })
})
