import { useEffect } from 'react'
import { useLang } from '../context/LanguageContext'
import WeeklySchedule from '../components/anime/WeeklySchedule'

export default function CalendarPage() {
  const { lang } = useLang()
  const heading = lang === 'zh' ? '今日新番放送日历' : 'Today’s Airing Calendar'
  const sub = lang === 'zh'
    ? '本周新番放送时间表，按周一至周日分组，覆盖连载中的 TV 动画与 ONA。每日更新。'
    : 'Weekly anime airing schedule grouped by day. Updated daily.'

  useEffect(() => {
    document.title = `${heading} — AnimeGoClub`
    return () => { document.title = 'AnimeGoClub' }
  }, [heading])

  return (
    <div className="container" style={{ paddingTop: 40, paddingBottom: 60 }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{
          fontSize: 'clamp(22px,3vw,34px)', color: '#ffffff', marginBottom: 12,
        }}>{heading}</h1>
        <p style={{ color: 'rgba(235,235,245,0.60)', fontSize: 15, lineHeight: 1.6, maxWidth: 640 }}>
          {sub}
        </p>
      </header>

      <WeeklySchedule />
    </div>
  )
}
