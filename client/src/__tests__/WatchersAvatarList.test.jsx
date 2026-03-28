import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import WatchersAvatarList from '../components/anime/WatchersAvatarList'
import { LanguageProvider } from '../context/LanguageContext'

vi.mock('../hooks/useAnime', () => ({
  useWatchers: vi.fn(),
}))

import { useWatchers } from '../hooks/useAnime'

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

describe('WatchersAvatarList', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders nothing while loading', () => {
    useWatchers.mockReturnValue({ data: null, isLoading: true })
    const { container } = render(wrapper(<WatchersAvatarList anilistId={1} />))
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when total is 0', () => {
    useWatchers.mockReturnValue({
      data: { data: [], total: 0 },
      isLoading: false,
    })
    const { container } = render(wrapper(<WatchersAvatarList anilistId={1} />))
    expect(container.firstChild).toBeNull()
  })

  it('shows watcher count when there are watchers', () => {
    useWatchers.mockReturnValue({
      data: { data: [{ username: 'alice' }, { username: 'bob' }], total: 2 },
      isLoading: false,
    })
    render(wrapper(<WatchersAvatarList anilistId={1} />))
    expect(screen.getByText(/2/)).toBeInTheDocument()
  })

  it('shows "+N more" truncation text when total exceeds shown count', () => {
    const watchers = [
      { username: 'a' }, { username: 'b' }, { username: 'c' },
      { username: 'd' }, { username: 'e' },
    ]
    useWatchers.mockReturnValue({
      data: { data: watchers, total: 20 },
      isLoading: false,
    })
    render(wrapper(<WatchersAvatarList anilistId={1} />))
    // total=20, shown=5, more=15
    expect(screen.getByText(/15/)).toBeInTheDocument()
  })

  it('does not show "+N more" when total equals shown count', () => {
    const watchers = [{ username: 'a' }, { username: 'b' }]
    useWatchers.mockReturnValue({
      data: { data: watchers, total: 2 },
      isLoading: false,
    })
    render(wrapper(<WatchersAvatarList anilistId={1} />))
    // more = 2 - 2 = 0, no "+N more" text
    expect(screen.queryByText(/还有/)).not.toBeInTheDocument()
  })

  it('renders avatar initials for each watcher', () => {
    useWatchers.mockReturnValue({
      data: { data: [{ username: 'alice' }, { username: 'bob' }], total: 2 },
      isLoading: false,
    })
    render(wrapper(<WatchersAvatarList anilistId={1} />))
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText('b')).toBeInTheDocument()
  })
})
