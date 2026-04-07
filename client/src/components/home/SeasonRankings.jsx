import { Link } from 'react-router-dom'
import { useLang } from '../../context/LanguageContext'
import { useYearlyTop } from '../../hooks/useAnime'
import { formatScore, pickTitle } from '../../utils/formatters'

const s = {
  section: { marginTop: 48 },
  label: { color: '#0a84ff', fontSize: 13, fontWeight: 600, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 8 },
  title: { fontSize: 'clamp(22px,3vw,32px)', color: '#ffffff', marginBottom: 20 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 },
  gridMobile: { display: 'grid', gridTemplateColumns: '1fr', gap: 10 },
  row: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '10px 14px', borderRadius: 12,
    background: '#1c1c1e', border: '1px solid #38383a',
    textDecoration: 'none', color: 'inherit',
    transition: 'background 0.2s, transform 0.25s cubic-bezier(0.4,0,0.2,1)',
  },
  rank: (i) => ({
    fontFamily: "'Sora',sans-serif", fontWeight: 800,
    fontSize: i < 3 ? 28 : 22,
    minWidth: 36, textAlign: 'center', flexShrink: 0,
    color: i < 3 ? '#ff9f0a' : 'rgba(235,235,245,0.30)',
    lineHeight: 1,
  }),
  cover: { width: 42, height: 56, borderRadius: 6, objectFit: 'cover', flexShrink: 0, background: '#2c2c2e' },
  info: { flex: 1, minWidth: 0 },
  name: {
    fontFamily: "'Sora',sans-serif", fontSize: 13, fontWeight: 600, color: '#ffffff',
    overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', lineHeight: 1.4,
  },
  meta: { fontSize: 12, color: 'rgba(235,235,245,0.60)', marginTop: 2 },
  score: {
    fontFamily: "'JetBrains Mono',monospace", fontSize: 14, fontWeight: 600,
    color: '#ff9f0a', flexShrink: 0,
  },
  skeleton: {
    height: 76, borderRadius: 12,
    background: 'linear-gradient(90deg, rgba(255,255,255,0.03) 25%, rgba(255,255,255,0.07) 50%, rgba(255,255,255,0.03) 75%)',
    backgroundSize: '200% 100%', border: '1px solid #38383a',
    animation: 'shimmer 1.4s ease-in-out infinite',
  },
}

export default function SeasonRankings() {
  const { t, lang } = useLang()
  const year = new Date().getFullYear()
  const { data, isLoading } = useYearlyTop(year, 10)

  const ranked = data ?? []

  if (!isLoading && ranked.length === 0) return null

  return (
    <section style={s.section}>
      <div style={{ marginBottom: 16 }}>
        <p style={s.label}>{t('home.rankingsLabel')}</p>
        <h2 style={s.title}>{t('home.rankingsTitle')}</h2>
      </div>

      {isLoading ? (
        <div style={s.grid} className="season-rankings-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} style={s.skeleton} />
          ))}
        </div>
      ) : (
        <div style={s.grid} className="season-rankings-grid">
          {ranked.map((anime, i) => (
            <Link
              key={anime.anilistId}
              to={`/anime/${anime.anilistId}`}
              style={s.row}
              onMouseEnter={e => { e.currentTarget.style.background = '#2c2c2e'; e.currentTarget.style.transform = 'translateX(4px)' }}
              onMouseLeave={e => { e.currentTarget.style.background = '#1c1c1e'; e.currentTarget.style.transform = 'translateX(0)' }}
            >
              <span style={s.rank(i)}>{i + 1}</span>
              <img
                src={anime.coverImageUrl}
                alt={anime.titleRomaji}
                style={s.cover}
                loading="lazy"
              />
              <div style={s.info}>
                <div style={s.name}>{pickTitle(anime, lang)}</div>
                <div style={s.meta}>
                  {(anime.genres || []).slice(0, 2).join(' · ')}
                  {anime.episodes > 0 && ` · ${anime.episodes} ${t('detail.epUnit')}`}
                </div>
              </div>
              {anime.averageScore > 0 && (
                <span style={s.score}>
                  <span style={{ color: '#ff9f0a', marginRight: 2, fontSize: 12 }}>★</span>
                  {formatScore(anime.averageScore)}
                </span>
              )}
            </Link>
          ))}
        </div>
      )}

      <style>{`
        @media (max-width: 600px) {
          .season-rankings-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </section>
  )
}
