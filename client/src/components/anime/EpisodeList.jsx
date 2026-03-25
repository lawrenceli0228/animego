import { useState } from 'react'
import { useLang } from '../../context/LanguageContext'
import { useSubscription } from '../../hooks/useSubscription'
import TorrentModal from './TorrentModal'
import EpisodeComments from './EpisodeComments'
import DanmakuSection from './DanmakuSection'

export default function EpisodeList({ anime }) {
  const { t } = useLang()
  const { data: sub } = useSubscription(anime.anilistId)
  const [openEp, setOpenEp] = useState(null)
  const [torrentEp, setTorrentEp] = useState(null)

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
        <p style={{ color: '#7c3aed', fontSize: 13, fontWeight: 600, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 8 }}>
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
          let numColor = '#94a3b8'

          if (isCurrent) { bg = 'rgba(124,58,237,0.2)'; border = 'rgba(124,58,237,0.5)'; numColor = '#a78bfa' }
          else if (watched) { bg = 'rgba(16,185,129,0.12)'; border = 'rgba(16,185,129,0.3)'; numColor = '#34d399' }
          if (isOpen) { bg = 'rgba(124,58,237,0.12)'; border = 'rgba(124,58,237,0.55)'; numColor = '#a78bfa' }

          return (
            <div
              key={ep}
              onClick={() => setOpenEp(prev => prev === ep ? null : ep)}
              style={{ borderRadius: 10, background: bg, border: `1px solid ${border}`, padding: '10px 8px 8px', cursor: 'pointer', textAlign: 'center', transition: 'all 0.2s' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(124,58,237,0.45)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = isOpen ? 'rgba(124,58,237,0.55)' : border }}
            >
              <div style={{ fontSize: 10, color: '#64748b', marginBottom: 3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {t('detail.ep')}
              </div>
              <div style={{ fontSize: 20, fontWeight: 800, color: numColor, lineHeight: 1, marginBottom: 5, fontFamily: "'Sora', sans-serif" }}>
                {ep}
              </div>
              {watched && <div style={{ fontSize: 12, color: '#34d399', marginBottom: 3 }}>✓</div>}
              {isCurrent && <div style={{ fontSize: 10, color: '#a78bfa', fontWeight: 700, textTransform: 'uppercase', marginBottom: 3 }}>▶</div>}
              <button
                onClick={e => { e.stopPropagation(); setTorrentEp(ep) }}
                style={{ marginTop: 2, width: '100%', padding: '3px 0', borderRadius: 6, border: 'none', cursor: 'pointer', background: 'rgba(124,58,237,0.15)', color: '#a78bfa', fontSize: 10, fontWeight: 700, letterSpacing: '0.5px', transition: 'background 0.15s' }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(124,58,237,0.35)'}
                onMouseLeave={e => e.currentTarget.style.background = 'rgba(124,58,237,0.15)'}
              >
                {t('torrent.btn')}
              </button>
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

      {torrentEp !== null && (
        <TorrentModal anime={anime} episode={torrentEp} onClose={() => setTorrentEp(null)} />
      )}
    </section>
  )
}
