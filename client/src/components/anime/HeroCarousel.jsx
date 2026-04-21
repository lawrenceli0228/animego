import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { stripHtml, truncate, formatScore, pickTitle } from '../../utils/formatters'
import { useLang } from '../../context/LanguageContext'

const INTERVAL = 5000

export default function HeroCarousel({ animeList = [] }) {
  const [current, setCurrent] = useState(0)
  const [paused, setPaused]   = useState(false)
  const { t, lang } = useLang()

  const next = useCallback(() => setCurrent(c => (c + 1) % animeList.length), [animeList.length])
  const prev = useCallback(() => setCurrent(c => (c - 1 + animeList.length) % animeList.length), [animeList.length])

  useEffect(() => {
    if (paused || animeList.length < 2) return
    const id = setInterval(next, INTERVAL)
    return () => clearInterval(id)
  }, [paused, next, animeList.length])

  if (!animeList.length) return null

  return (
    <div
      style={{ position: 'relative', height: 'clamp(420px,55vh,600px)', overflow: 'hidden' }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {animeList.map((anime, i) => {
        const bg = anime.bannerImageUrl || anime.coverImageUrl
        return (
          <div key={anime.anilistId} style={{
            position: 'absolute', inset: 0,
            opacity: i === current ? 1 : 0,
            transition: 'opacity 0.9s ease',
            pointerEvents: i === current ? 'auto' : 'none'
          }}>
            <div style={{
              position: 'absolute', inset: 0,
              backgroundImage: `url(${bg})`,
              backgroundSize: 'cover', backgroundPosition: 'center top',
              transform: i === current ? 'scale(1.03)' : 'scale(1)',
              transition: 'transform 6s ease'
            }} />
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to right, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.70) 55%, rgba(0,0,0,0.10) 100%)' }} />
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '40%', background: 'linear-gradient(to top, #000000, transparent)' }} />

            <div className="container" style={{ position: 'relative', height: '100%', display: 'flex', alignItems: 'center' }}>
              <div style={{ maxWidth: 560, animation: i === current ? 'fadeUp 0.6s ease' : 'none' }}>
                <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '2px', textTransform: 'uppercase', color: '#0a84ff', marginBottom: 12 }}>
                  {t(`season.${anime.season}`)} {anime.seasonYear}
                </p>
                <h1 style={{ fontSize: 'clamp(24px,3.5vw,46px)', fontFamily: "'Sora',sans-serif", fontWeight: 800, lineHeight: 1.15, marginBottom: 16, color: '#ffffff', textShadow: '0 2px 20px rgba(0,0,0,0.6)' }}>
                  {pickTitle(anime, lang)}
                </h1>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                  {(anime.genres || []).slice(0, 4).map(g => (
                    <span key={g} style={{ fontSize: 11, fontWeight: 500, padding: '3px 10px', borderRadius: 9999, background: 'rgba(120,120,128,0.12)', color: 'rgba(235,235,245,0.60)' }}>{g}</span>
                  ))}
                </div>
                {anime.description && (
                  <p style={{ fontSize: 14, color: 'rgba(235,235,245,0.60)', lineHeight: 1.7, marginBottom: 20 }}>
                    {truncate(stripHtml(anime.description), 130)}
                  </p>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  {anime.averageScore > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 20, color: '#ff9f0a' }}>★</span>
                      <span style={{ fontSize: 22, fontWeight: 800, color: '#ffffff', fontFamily: "'JetBrains Mono',monospace" }}>{formatScore(anime.averageScore)}</span>
                    </div>
                  )}
                  <Link to={`/anime/${anime.anilistId}`} state={{ coverImageColor: anime.coverImageColor }}
                    style={{ padding: '10px 28px', borderRadius: 8, background: '#0a84ff', color: '#fff', fontWeight: 500, fontSize: 14, fontFamily: "'DM Sans',sans-serif", textDecoration: 'none', transition: 'background 0.15s' }}
                    onMouseEnter={e => e.currentTarget.style.background='#409cff'}
                    onMouseLeave={e => e.currentTarget.style.background='#0a84ff'}
                  >
                    {t('detail.viewDetails')}
                  </Link>
                </div>
              </div>
            </div>
          </div>
        )
      })}

      {[['‹', prev, 'left', 24], ['›', next, 'right', 24]].map(([icon, fn, side, offset]) => (
        <button key={side} onClick={fn} style={{
          position: 'absolute', [side]: offset, top: '50%', transform: 'translateY(-50%)',
          width: 44, height: 44, borderRadius: '50%', border: 'none', cursor: 'pointer',
          background: 'rgba(255,255,255,0.1)', backdropFilter: 'blur(8px)',
          color: '#ffffff', fontSize: 22, fontWeight: 700, display: 'flex',
          alignItems: 'center', justifyContent: 'center', transition: 'background 0.2s', zIndex: 10
        }}
          onMouseEnter={e => e.currentTarget.style.background='rgba(10,132,255,0.5)'}
          onMouseLeave={e => e.currentTarget.style.background='rgba(255,255,255,0.1)'}
        >
          {icon}
        </button>
      ))}

      <div style={{ position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 8, zIndex: 10 }}>
        {animeList.map((_, i) => (
          <button key={i} onClick={() => setCurrent(i)} aria-label={`Slide ${i + 1}`} style={{
            height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: 'none', cursor: 'pointer', background: 'transparent', padding: '0 4px',
          }}>
            <span style={{
              display: 'block', height: 6, borderRadius: 3,
              width: i === current ? 28 : 6,
              background: i === current ? '#0a84ff' : 'rgba(255,255,255,0.35)',
              transition: 'all 0.35s ease',
            }} />
          </button>
        ))}
      </div>
    </div>
  )
}
