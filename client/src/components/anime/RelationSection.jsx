import { useNavigate } from 'react-router-dom'
import { useLang } from '../../context/LanguageContext'
import { pickTitle } from '../../utils/formatters'

const RELATION_LABELS = {
  zh: {
    PREQUEL: '前传', SEQUEL: '续集', SIDE_STORY: '番外', PARENT: '本篇',
    CHARACTER: '角色出演', SUMMARY: '总集篇', ALTERNATIVE: '替代版',
    SPIN_OFF: '衍生作品', ADAPTATION: '改编', OTHER: '其他',
  },
  en: {
    PREQUEL: 'Prequel', SEQUEL: 'Sequel', SIDE_STORY: 'Side Story', PARENT: 'Parent',
    CHARACTER: 'Character', SUMMARY: 'Summary', ALTERNATIVE: 'Alternative',
    SPIN_OFF: 'Spin-Off', ADAPTATION: 'Adaptation', OTHER: 'Other',
  },
}

const ORDER = ['PREQUEL','SEQUEL','PARENT','SIDE_STORY','SPIN_OFF','ADAPTATION','ALTERNATIVE','SUMMARY','CHARACTER','OTHER']

export default function RelationSection({ relations }) {
  const navigate = useNavigate()
  const { lang, t } = useLang()
  if (!relations?.length) return null

  const sorted = [...relations].sort((a, b) =>
    (ORDER.indexOf(a.relationType) ?? 99) - (ORDER.indexOf(b.relationType) ?? 99)
  )

  const labels = RELATION_LABELS[lang] || RELATION_LABELS.en

  return (
    <section style={{ margin: '32px 0' }}>
      <h3 style={{
        fontFamily: "'Sora',sans-serif", fontSize: 16, fontWeight: 700,
        color: '#ffffff', marginBottom: 16,
      }}>
        {lang === 'zh' ? '关联作品' : 'Relations'}
      </h3>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
        gap: 12,
      }}>
        {sorted.map((rel) => (
          <div
            key={`${rel.anilistId}-${rel.relationType}`}
            onClick={() => navigate(`/anime/${rel.anilistId}`, { state: { posterAccent: rel.posterAccent, posterAccentRgb: rel.posterAccentRgb } })}
            role="button" tabIndex={0}
            onKeyDown={e => e.key === 'Enter' && navigate(`/anime/${rel.anilistId}`, { state: { posterAccent: rel.posterAccent, posterAccentRgb: rel.posterAccentRgb } })}
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              background: '#1c1c1e', border: '1px solid #38383a', borderRadius: 10,
              padding: 10, cursor: 'pointer',
              transition: 'background 0.2s',
            }}
            onMouseEnter={e => e.currentTarget.style.background = '#2c2c2e'}
            onMouseLeave={e => e.currentTarget.style.background = '#1c1c1e'}
          >
            {rel.coverImageUrl ? (
              <img
                src={rel.coverImageUrl} alt={rel.title}
                style={{ width: 48, height: 64, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }}
              />
            ) : (
              <div style={{
                width: 48, height: 64, borderRadius: 6, flexShrink: 0,
                background: '#2c2c2e', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, color: 'rgba(235,235,245,0.30)',
              }}>N/A</div>
            )}
            <div style={{ minWidth: 0 }}>
              <span style={{
                display: 'inline-block', fontSize: 10, fontWeight: 700,
                color: '#0a84ff', textTransform: 'uppercase', marginBottom: 4,
              }}>
                {labels[rel.relationType] || rel.relationType}
              </span>
              <p style={{
                fontFamily: "'Sora',sans-serif", fontSize: 13, fontWeight: 600,
                color: '#ffffff', margin: 0, lineHeight: 1.35,
                overflow: 'hidden', display: '-webkit-box',
                WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
              }}>
                {rel.titleChinese && lang === 'zh' ? rel.titleChinese : rel.title}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
