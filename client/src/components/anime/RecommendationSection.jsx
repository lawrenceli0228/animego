import { useNavigate } from 'react-router-dom'
import { useLang } from '../../context/LanguageContext'

const LABEL = { zh: '看了这部还在看', en: 'You Might Also Like' }

export default function RecommendationSection({ recommendations }) {
  const { lang } = useLang()
  const navigate = useNavigate()
  if (!recommendations?.length) return null

  return (
    <section style={{ marginTop: 40, marginBottom: 60 }}>
      <p style={{ color: '#0a84ff', fontSize: 13, fontWeight: 600, letterSpacing: '2px',
        textTransform: 'uppercase', marginBottom: 16 }}>
        {LABEL[lang] ?? LABEL.en}
      </p>
      <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8,
        scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
        {recommendations.map(r => (
          <div
            key={r.anilistId}
            onClick={() => navigate(`/anime/${r.anilistId}`, { state: { posterAccent: r.posterAccent, posterAccentRgb: r.posterAccentRgb } })}
            style={{ flexShrink: 0, width: 110, cursor: 'pointer' }}
          >
            <div style={{
              width: 110, height: 155, borderRadius: 8, overflow: 'hidden',
              background: '#2c2c2e', marginBottom: 6,
              border: '1px solid #38383a',
            }}>
              {r.coverImageUrl
                ? <img src={r.coverImageUrl} alt={r.title}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    onError={e => { e.target.style.display = 'none' }} />
                : null
              }
            </div>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'rgba(235,235,245,0.75)',
              lineHeight: 1.3, overflow: 'hidden', display: '-webkit-box',
              WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
              title={r.title}>{r.title}</div>
            {r.averageScore > 0 && (
              <div style={{ fontSize: 11, color: '#30d158', marginTop: 3 }}>★ {(r.averageScore / 10).toFixed(1)}</div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
