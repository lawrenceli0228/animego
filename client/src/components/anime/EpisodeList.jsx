import { useState } from 'react'
import { useLang } from '../../context/LanguageContext'
import { useSubscription } from '../../hooks/useSubscription'
import EpisodeComments from './EpisodeComments'
import DanmakuSection from './DanmakuSection'

export default function EpisodeList({ anime }) {
  const { t } = useLang()
  const { data: sub } = useSubscription(anime.anilistId)
  const [openEp, setOpenEp] = useState(null)

  const currentEp = sub?.currentEpisode ?? 0
  const total = anime.episodes

  if (!total) return (
    <section style={{ marginTop: 40 }}>
      <p style={{ color: '#475569', fontSize: 14, padding: '24px 0' }}>{t('detail.noEpisodes')}</p>
    </section>
  )

  return (
    <section style={{ marginTop: 40, marginBottom: 60 }}>
      <div style={{ marginBottom: 16 }}>
        <p style={{ color: '#0a84ff', fontSize: 13, fontWeight: 600, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 8 }}>
          {t('detail.episodes')}
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 10 }}>
        {Array.from({ length: total }, (_, i) => i + 1).map(ep => {
          const watched = currentEp > 0 && ep < currentEp
          const isCurrent = currentEp > 0 && ep === currentEp
          const isOpen = openEp === ep

          let bg = 'rgba(255,255,255,0.04)'
          let border = 'rgba(148,163,184,0.1)'
          let numColor = 'rgba(235,235,245,0.60)'

          if (isCurrent) { bg = 'rgba(10,132,255,0.2)'; border = 'rgba(10,132,255,0.5)'; numColor = '#60aaff' }
          else if (watched) { bg = 'rgba(48,209,88,0.12)'; border = 'rgba(48,209,88,0.3)'; numColor = '#30d158' }
          if (isOpen) { bg = 'rgba(10,132,255,0.12)'; border = 'rgba(10,132,255,0.55)'; numColor = '#60aaff' }

          return (
            <div
              key={ep}
              onClick={() => setOpenEp(prev => prev === ep ? null : ep)}
              style={{ borderRadius: 10, background: bg, border: `1px solid ${border}`, padding: '10px 8px 8px', cursor: 'pointer', textAlign: 'center', transition: 'all 0.2s' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(10,132,255,0.45)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = isOpen ? 'rgba(10,132,255,0.55)' : border }}
            >
              <div style={{ fontSize: 10, color: 'rgba(235,235,245,0.30)', marginBottom: 3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {t('detail.ep')}
              </div>
              <div style={{ fontSize: 20, fontWeight: 800, color: numColor, lineHeight: 1, marginBottom: 5, fontFamily: "'Sora', sans-serif" }}>
                {ep}
              </div>
              {watched && <div style={{ fontSize: 12, color: '#30d158', marginBottom: 3 }}>✓</div>}
              {isCurrent && <div style={{ fontSize: 10, color: '#60aaff', fontWeight: 700, textTransform: 'uppercase', marginBottom: 3 }}>▶</div>}
            </div>
          )
        })}
      </div>

      {openEp !== null && (
        <div style={{ marginTop: 16, borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(148,163,184,0.1)', background: 'rgba(255,255,255,0.02)' }}>
          <div style={{ padding: '12px 16px' }}>
            <DanmakuSection anilistId={anime.anilistId} episode={openEp} />
          </div>
          <EpisodeComments anilistId={anime.anilistId} episode={openEp} />
        </div>
      )}

    </section>
  )
}
