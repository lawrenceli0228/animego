import { useEffect } from 'react'
import HeroSection from '../components/landing/HeroSection'
import StatsRow from '../components/landing/StatsRow'
import DataSourcesTribute from '../components/landing/DataSourcesTribute'
import FeaturesBento from '../components/landing/FeaturesBento'
import PosterIdentityShowcase from '../components/landing/PosterIdentityShowcase'
import DifferentiatorSection from '../components/landing/DifferentiatorSection'
import DanmakuInsert from '../components/landing/DanmakuInsert'
import FaqSection from '../components/landing/FaqSection'
import FinalCta from '../components/landing/FinalCta'
import { useTrending, useAnimeDetail } from '../hooks/useAnime'
import { useLang } from '../context/LanguageContext'

const TITLE_FIELDS = ['titleChinese', 'titleRomaji', 'titleEnglish', 'titleNative']

function matchByTitle(list, patterns) {
  const lowered = patterns.map((p) => p.toLowerCase())
  return list.find((a) => {
    const hay = TITLE_FIELDS.map((k) => a?.[k] || '').join(' ').toLowerCase()
    return lowered.some((p) => hay.includes(p))
  })
}

function pickShowcase(trending) {
  const pick1 = matchByTitle(trending, ['我推的孩子', 'Oshi no Ko', '推しの子'])
  const pick2 = matchByTitle(trending, ['辉夜', 'Kaguya', 'かぐや'])
  const pick3 = matchByTitle(trending, ['芙莉莲', 'Frieren', 'フリーレン'])
  const used = new Set([pick1, pick2, pick3].filter(Boolean).map((a) => a.anilistId))
  const rest = trending.filter((a) => !used.has(a.anilistId))
  return [
    pick1 || rest.shift(),
    pick2 || rest.shift(),
    pick3 || rest.shift(),
  ].filter(Boolean)
}

const FEATURE_POSTER_IDS = {
  frieren: 154587,
  apoth:   161645,
  losing:  171457,
}

function pickFeaturePosters(trending) {
  const frieren = matchByTitle(trending, ['芙莉莲', 'Frieren', 'フリーレン'])
  const apoth = matchByTitle(trending, ['药屋', '藥屋', 'Apothecary', 'Kusuriya', '薬屋'])
  const losing = matchByTitle(trending, ['败犬', '敗犬', 'Losing Heroines', 'Makeine', '负け犬', '負けヒロイン'])
  return { frieren, apoth, losing }
}

export default function LandingPage() {
  const { t } = useLang()
  useEffect(() => {
    const prev = document.title
    document.title = t('landing.docTitle')
    return () => { document.title = prev }
  }, [t])

  const { data: trending = [] } = useTrending(30)
  const { data: frierenDetail } = useAnimeDetail(FEATURE_POSTER_IDS.frieren)
  const { data: apothDetail }   = useAnimeDetail(FEATURE_POSTER_IDS.apoth)
  const { data: losingDetail }  = useAnimeDetail(FEATURE_POSTER_IDS.losing)
  const showcase = pickShowcase(trending)
  const showcaseIds = new Set(showcase.map((a) => a.anilistId))
  const trendingPosters = pickFeaturePosters(trending)
  const featurePosters = {
    frieren: frierenDetail || trendingPosters.frieren,
    apoth:   apothDetail   || trendingPosters.apoth,
    losing:  losingDetail  || trendingPosters.losing,
  }
  const hero = featurePosters.frieren || trending[0] || null
  const danmakuBg =
    matchByTitle(trending, ['鬼灭之刃', 'Demon Slayer', '鬼滅の刃']) ||
    trending.find((a) => !showcaseIds.has(a.anilistId) && a.anilistId !== hero?.anilistId) ||
    trending[3] || trending[0] || null

  return (
    <main>
      <HeroSection poster={hero} />
      <StatsRow />
      <DataSourcesTribute />
      <FeaturesBento posters={featurePosters} />
      <PosterIdentityShowcase posters={showcase} />
      <DifferentiatorSection />
      <DanmakuInsert poster={danmakuBg} />
      <FaqSection />
      <FinalCta />
    </main>
  )
}
