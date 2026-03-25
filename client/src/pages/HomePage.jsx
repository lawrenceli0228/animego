import { getCurrentSeason } from '../utils/constants'
import { useSeasonalAnime } from '../hooks/useAnime'
import HeroCarousel from '../components/anime/HeroCarousel'
import TrendingSection from '../components/home/TrendingSection'
import ContinueWatching from '../components/anime/ContinueWatching'
import ActivityFeed from '../components/social/ActivityFeed'
import WeeklySchedule from '../components/anime/WeeklySchedule'
import LoadingSpinner from '../components/common/LoadingSpinner'

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
        ? <div style={{ height: 'clamp(420px,55vh,600px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <LoadingSpinner />
          </div>
        : <HeroCarousel animeList={top5} />
      }

      {/* Trending + Continue watching + Weekly schedule */}
      <div className="container" style={{ paddingTop: 8, paddingBottom: 60 }}>
        <TrendingSection />
        <ContinueWatching />
        <ActivityFeed />
        <WeeklySchedule />
      </div>
    </div>
  )
}
