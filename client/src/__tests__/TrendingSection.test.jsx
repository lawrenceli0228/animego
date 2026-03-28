import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TrendingSection from '../components/home/TrendingSection'
import { LanguageProvider } from '../context/LanguageContext'

vi.mock('../hooks/useAnime', () => ({
  useTrending: vi.fn(),
  useWatchers: vi.fn(),
}))

import { useTrending, useWatchers } from '../hooks/useAnime'

// AnimeCard needs navigate; wrap in MemoryRouter
function wrapper(children) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <LanguageProvider>
          {children}
        </LanguageProvider>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('TrendingSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // useWatchers is used by AnimeCard internally via WatchersAvatarList — stub it
    useWatchers.mockReturnValue({ data: null, isLoading: false })
  })

  it('renders skeleton cards while loading', () => {
    useTrending.mockReturnValue({ data: null, isLoading: true, isError: false })
    const { container } = render(wrapper(<TrendingSection />))
    // 4 skeleton divs are rendered
    const skeletons = container.querySelectorAll('[style*="shimmer"]')
    expect(skeletons.length).toBeGreaterThanOrEqual(4)
  })

  it('renders nothing when data is empty', () => {
    useTrending.mockReturnValue({ data: [], isLoading: false, isError: false })
    const { container } = render(wrapper(<TrendingSection />))
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing on error', () => {
    useTrending.mockReturnValue({ data: null, isLoading: false, isError: true })
    const { container } = render(wrapper(<TrendingSection />))
    expect(container.firstChild).toBeNull()
  })

  it('renders trending items on success', () => {
    useTrending.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [
        { anilistId: 1, rank: 1, watcherCount: 42, title: { romaji: 'Show A' }, coverImage: { large: '' }, status: 'RELEASING' },
        { anilistId: 2, rank: 2, watcherCount: 10, title: { romaji: 'Show B' }, coverImage: { large: '' }, status: 'RELEASING' },
      ],
    })
    render(wrapper(<TrendingSection />))
    expect(screen.getByText('#1')).toBeInTheDocument()
    expect(screen.getByText('#2')).toBeInTheDocument()
  })
})
