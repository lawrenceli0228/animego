import { useEffect } from 'react'
import HeroSection from '../components/landing/HeroSection'
import StatsRow from '../components/landing/StatsRow'
import FeaturesBento from '../components/landing/FeaturesBento'
import PosterIdentityShowcase from '../components/landing/PosterIdentityShowcase'
import DifferentiatorSection from '../components/landing/DifferentiatorSection'
import DanmakuInsert from '../components/landing/DanmakuInsert'
import FaqSection from '../components/landing/FaqSection'
import FinalCta from '../components/landing/FinalCta'

export default function LandingPage() {
  useEffect(() => {
    const prev = document.title
    document.title = 'AnimeGo · 追你该追的那一话'
    return () => { document.title = prev }
  }, [])

  return (
    <main>
      <HeroSection />
      <StatsRow />
      <FeaturesBento />
      <PosterIdentityShowcase />
      <DifferentiatorSection />
      <DanmakuInsert />
      <FaqSection />
      <FinalCta />
    </main>
  )
}
