import { getCurrentSeason } from '../utils/constants'
import { useSeasonalAnime } from '../hooks/useAnime'
import HeroCarousel from '../components/anime/HeroCarousel'
import TrendingSection from '../components/home/TrendingSection'
import SeasonRankings from '../components/home/SeasonRankings'

import ContinueWatching from '../components/anime/ContinueWatching'
import CompletedGems from '../components/home/CompletedGems'
import ActivityFeed from '../components/social/ActivityFeed'

import WeeklySchedule from '../components/anime/WeeklySchedule'

const skeletonPulse = {
  background: 'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 75%)',
  backgroundSize: '400% 100%',
  animation: 'shimmer 1.6s ease infinite',
  borderRadius: 4,
}

function HeroSkeleton() {
  return (
    <div style={{ position: 'relative', height: 'clamp(420px,55vh,600px)', overflow: 'hidden', background: '#0a0a0a' }}>
      <style>{`@keyframes shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }`}</style>
      <div className="container" style={{ position: 'relative', height: '100%', display: 'flex', alignItems: 'center' }}>
        <div style={{ maxWidth: 560 }}>
          {/* Season label */}
          <div style={{ ...skeletonPulse, width: 120, height: 14, marginBottom: 16 }} />
          {/* Title line 1 */}
          <div style={{ ...skeletonPulse, width: '90%', height: 38, marginBottom: 10 }} />
          {/* Title line 2 */}
          <div style={{ ...skeletonPulse, width: '60%', height: 38, marginBottom: 18 }} />
          {/* Genre pills */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
            {[56, 64, 48, 72].map((w, i) => (
              <div key={i} style={{ ...skeletonPulse, width: w, height: 22, borderRadius: 9999 }} />
            ))}
          </div>
          {/* Description lines */}
          <div style={{ ...skeletonPulse, width: '100%', height: 14, marginBottom: 8 }} />
          <div style={{ ...skeletonPulse, width: '85%', height: 14, marginBottom: 22 }} />
          {/* Score + button */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ ...skeletonPulse, width: 64, height: 28 }} />
            <div style={{ ...skeletonPulse, width: 120, height: 40, borderRadius: 8 }} />
          </div>
        </div>
      </div>
      {/* Dot indicators skeleton */}
      <div style={{ position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 8 }}>
        {[28, 6, 6, 6, 6].map((w, i) => (
          <div key={i} style={{ ...skeletonPulse, width: w, height: 6, borderRadius: 3 }} />
        ))}
      </div>
    </div>
  )
}

export default function HomePage() {
  const currentSeason = getCurrentSeason()
  const currentYear   = new Date().getFullYear()

  const { data, isLoading } = useSeasonalAnime(currentSeason, currentYear, 1)

  // Top 5 by score (already sorted desc in cache)
  const top5 = data?.data?.slice(0, 5) ?? []

  return (
    <div>
      {/* Full-width hero carousel */}
      {isLoading
        ? <HeroSkeleton />
        : <HeroCarousel animeList={top5} />
      }

      {/* Trending + Continue watching + Weekly schedule */}
      <div className="container" style={{ paddingTop: 8, paddingBottom: 60 }}>
        <TrendingSection />
        <ContinueWatching />
        <WeeklySchedule />

        <CompletedGems />
        <ActivityFeed />

        <SeasonRankings />
      </div>
    </div>
  )
}
