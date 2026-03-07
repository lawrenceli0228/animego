import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { stripHtml, truncate, formatScore } from '../../utils/formatters'
import { SEASON_LABELS } from '../../utils/constants'

const INTERVAL = 5000 // 5s auto-advance

export default function HeroCarousel({ animeList = [] }) {
  const [current, setCurrent] = useState(0)
  const [paused, setPaused]   = useState(false)

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
      {/* Slides */}
      {animeList.map((anime, i) => {
        const bg = anime.bannerImageUrl || anime.coverImageUrl
        return (
          <div
            key={anime.anilistId}
            style={{
              position: 'absolute', inset: 0,
              opacity: i === current ? 1 : 0,
              transition: 'opacity 0.9s ease',
              pointerEvents: i === current ? 'auto' : 'none'
            }}
          >
            {/* Background image */}
            <div style={{
              position: 'absolute', inset: 0,
              backgroundImage: `url(${bg})`,
              backgroundSize: 'cover', backgroundPosition: 'center top',
              transform: i === current ? 'scale(1.03)' : 'scale(1)',
              transition: 'transform 6s ease'
            }} />

            {/* Gradient overlays */}
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to right, rgba(10,14,26,0.97) 0%, rgba(10,14,26,0.75) 55%, rgba(10,14,26,0.15) 100%)' }} />
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '40%', background: 'linear-gradient(to top, rgba(10,14,26,1), transparent)' }} />

            {/* Content */}
            <div className="container" style={{ position: 'relative', height: '100%', display: 'flex', alignItems: 'center' }}>
              <div style={{ maxWidth: 560, animation: i === current ? 'fadeUp 0.6s ease' : 'none' }}>

                {/* Season tag */}
                <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '2px', textTransform: 'uppercase', color: '#7c3aed', marginBottom: 12 }}>
                  {SEASON_LABELS[anime.season]} {anime.seasonYear}
                </p>

                {/* Title */}
                <h1 style={{
                  fontSize: 'clamp(24px,3.5vw,46px)', fontFamily: "'Sora',sans-serif", fontWeight: 800,
                  lineHeight: 1.15, marginBottom: 16, color: '#f1f5f9',
                  textShadow: '0 2px 20px rgba(0,0,0,0.6)'
                }}>
                  {anime.titleEnglish || anime.titleRomaji}
                </h1>

                {/* Genres */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                  {(anime.genres || []).slice(0, 4).map(g => (
                    <span key={g} style={{
                      fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 20,
                      background: 'rgba(124,58,237,0.2)', border: '1px solid rgba(124,58,237,0.35)', color: '#c4b5fd'
                    }}>{g}</span>
                  ))}
                </div>

                {/* Description */}
                {anime.description && (
                  <p style={{ fontSize: 14, color: '#94a3b8', lineHeight: 1.7, marginBottom: 20 }}>
                    {truncate(stripHtml(anime.description), 130)}
                  </p>
                )}

                {/* Score + CTA */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  {anime.averageScore > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 20, color: '#fbbf24' }}>★</span>
                      <span style={{ fontSize: 22, fontWeight: 800, color: '#f1f5f9' }}>{formatScore(anime.averageScore)}</span>
                    </div>
                  )}
                  <Link
                    to={`/anime/${anime.anilistId}`}
                    style={{
                      padding: '10px 28px', borderRadius: 10,
                      background: 'linear-gradient(135deg,#7c3aed,#06b6d4)',
                      color: '#fff', fontWeight: 700, fontSize: 14,
                      fontFamily: "'Sora',sans-serif", textDecoration: 'none',
                      boxShadow: '0 4px 20px rgba(124,58,237,0.35)',
                      transition: 'opacity 0.2s'
                    }}
                    onMouseEnter={e => e.currentTarget.style.opacity = '0.85'}
                    onMouseLeave={e => e.currentTarget.style.opacity = '1'}
                  >
                    查看详情
                  </Link>
                </div>

              </div>
            </div>
          </div>
        )
      })}

      {/* Prev / Next arrows */}
      {[['‹', prev, 'left', 24], ['›', next, 'right', 24]].map(([icon, fn, side, offset]) => (
        <button key={side} onClick={fn} style={{
          position: 'absolute', [side]: offset, top: '50%', transform: 'translateY(-50%)',
          width: 44, height: 44, borderRadius: '50%', border: 'none', cursor: 'pointer',
          background: 'rgba(255,255,255,0.1)', backdropFilter: 'blur(8px)',
          color: '#f1f5f9', fontSize: 22, fontWeight: 700, display: 'flex',
          alignItems: 'center', justifyContent: 'center', transition: 'background 0.2s',
          zIndex: 10
        }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(124,58,237,0.5)'}
          onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
        >
          {icon}
        </button>
      ))}

      {/* Dot indicators */}
      <div style={{
        position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', gap: 8, zIndex: 10
      }}>
        {animeList.map((_, i) => (
          <button key={i} onClick={() => setCurrent(i)} style={{
            height: 6, borderRadius: 3, border: 'none', cursor: 'pointer',
            width: i === current ? 28 : 6,
            background: i === current ? '#7c3aed' : 'rgba(255,255,255,0.35)',
            transition: 'all 0.35s ease', padding: 0
          }} />
        ))}
      </div>
    </div>
  )
}
