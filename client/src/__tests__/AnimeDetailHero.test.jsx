import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../context/LanguageContext', () => ({
  useLang: vi.fn(),
}))

import { useLang } from '../context/LanguageContext'
import AnimeDetailHero from '../components/anime/AnimeDetailHero'

const t = (key) => key

function renderHero(animeProps = {}) {
  const anime = {
    anilistId: 1,
    titleRomaji: 'Test Anime',
    titleEnglish: 'Test Anime EN',
    titleNative: 'テスト',
    coverImageUrl: 'cover.jpg',
    bannerImageUrl: null,
    description: 'A test description.',
    episodes: 12,
    status: 'RELEASING',
    season: 'SPRING',
    seasonYear: 2026,
    averageScore: 80,
    genres: ['Action'],
    format: 'TV',
    studios: [],
    relations: [],
    bangumiVersion: 2,
    titleChinese: '测试动漫',
    bgmId: 100,
    bangumiScore: 7.5,
    bangumiVotes: 200,
    ...animeProps,
  }
  return render(
    <MemoryRouter>
      <AnimeDetailHero anime={anime} />
    </MemoryRouter>
  )
}

describe('AnimeDetailHero', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useLang.mockReturnValue({ t, lang: 'zh' })
  })

  it('shows title shimmer when enriching and no titleChinese (zh)', () => {
    const { container } = renderHero({
      bangumiVersion: 1,
      titleChinese: null,
    })
    const shimmers = container.querySelectorAll('[style*="shimmer"]')
    expect(shimmers.length).toBeGreaterThanOrEqual(1)
    // Should NOT show h1 title
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })

  it('shows title when enrichment is complete', () => {
    renderHero({ bangumiVersion: 2, titleChinese: '测试动漫' })
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
  })

  it('shows title when not enriching even without titleChinese', () => {
    renderHero({ bangumiVersion: 3, titleChinese: null })
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
  })

  it('shows shimmer when v2 with bgmId but no titleChinese (v3 healing)', () => {
    const { container } = renderHero({ bangumiVersion: 2, titleChinese: null, bgmId: 100 })
    const shimmers = container.querySelectorAll('[style*="shimmer"]')
    expect(shimmers.length).toBeGreaterThanOrEqual(1)
  })

  it('shows badge shimmers when enriching without bangumiScore/bgmId', () => {
    const { container } = renderHero({
      bangumiVersion: 0,
      bangumiScore: undefined,
      bgmId: null,
      titleChinese: '测试',
    })
    // Two badge shimmers: one for score, one for bgmId link
    const shimmers = container.querySelectorAll('span[style*="shimmer"]')
    expect(shimmers).toHaveLength(2)
  })

  it('hides badge shimmers when enrichment is complete', () => {
    const { container } = renderHero({
      bangumiVersion: 2,
      bangumiScore: 7.5,
      bgmId: 100,
    })
    const shimmers = container.querySelectorAll('span[style*="shimmer"]')
    expect(shimmers).toHaveLength(0)
  })

  it('does not show title shimmer in English mode', () => {
    useLang.mockReturnValue({ t, lang: 'en' })
    renderHero({ bangumiVersion: 1, titleChinese: null })
    // English mode never shows title shimmer (only zh waits for titleChinese)
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
  })
})
