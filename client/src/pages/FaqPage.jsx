import { useEffect } from 'react'
import { useLang } from '../context/LanguageContext'
import FaqSection from '../components/landing/FaqSection'

export default function FaqPage() {
  const { lang } = useLang()
  const heading = lang === 'zh' ? 'AnimeGoClub 常见问题' : 'Frequently Asked Questions'
  const sub = lang === 'zh'
    ? '关于 AnimeGoClub 是否免费、与 Bangumi/AniList/MAL 的区别、弹幕来源、OVA/ONA/剧场版的差异等。'
    : 'About AnimeGoClub: is it free, how it differs from Bangumi/AniList/MAL, danmaku sources, OVA/ONA/movie differences.'

  useEffect(() => {
    document.title = `${heading} — AnimeGoClub`
    return () => { document.title = 'AnimeGoClub' }
  }, [heading])

  return (
    <>
      <div className="container" style={{ paddingTop: 40, paddingBottom: 0 }}>
        <h1 style={{ fontSize: 'clamp(22px,3vw,34px)', color: '#ffffff', marginBottom: 12 }}>{heading}</h1>
        <p style={{ color: 'rgba(235,235,245,0.60)', fontSize: 15, lineHeight: 1.6, maxWidth: 640 }}>{sub}</p>
      </div>
      <FaqSection />
    </>
  )
}
