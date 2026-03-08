import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useLang } from '../context/LanguageContext'
import { useSubscriptions } from '../hooks/useSubscription'
import { STATUS_OPTIONS } from '../utils/constants'
import AnimeGrid from '../components/anime/AnimeGrid'

export default function ProfilePage() {
  const { user } = useAuth()
  const { t } = useLang()
  const [activeStatus, setActiveStatus] = useState('watching')
  const { data: subs, isLoading } = useSubscriptions(activeStatus)

  const statusLabels = {
    watching: t('sub.watching'), completed: t('sub.completed'),
    plan_to_watch: t('sub.planToWatch'), dropped: t('sub.dropped')
  }

  const animeList = subs?.map(s => ({
    anilistId:     s.anilistId,
    titleRomaji:   s.titleRomaji,
    titleEnglish:  s.titleEnglish,
    coverImageUrl: s.coverImageUrl,
    averageScore:  s.averageScore,
    genres:        s.genres,
    format:        s.format,
    status:        s.status,
    _subStatus:    s.status
  }))

  return (
    <div className="container" style={{ paddingTop:40, paddingBottom:60 }}>
      <div style={{ marginBottom:36, animation:'fadeUp 0.4s ease' }}>
        <p style={{ color:'#7c3aed', fontSize:13, fontWeight:600, letterSpacing:'2px',
          textTransform:'uppercase', marginBottom:8 }}>{t('profile.label')}</p>
        <h1 style={{ fontSize:'clamp(24px,3.5vw,38px)',
          background:'linear-gradient(135deg,#f1f5f9,#94a3b8)',
          WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent' }}>
          {user?.username}{t('profile.titleSuffix')}
        </h1>
      </div>

      <div style={{ display:'flex', gap:4, marginBottom:28, background:'rgba(26,34,53,0.8)',
        borderRadius:12, padding:5, width:'fit-content',
        border:'1px solid rgba(148,163,184,0.08)' }}>
        {STATUS_OPTIONS.map(opt => (
          <button key={opt.value} onClick={() => setActiveStatus(opt.value)}
            style={{
              padding:'8px 20px', borderRadius:8, fontSize:14, fontWeight:600,
              cursor:'pointer', border:'none', transition:'all 0.2s',
              fontFamily:"'Sora',sans-serif",
              background: activeStatus === opt.value ? `linear-gradient(135deg,${opt.color}33,${opt.color}22)` : 'transparent',
              color: activeStatus === opt.value ? opt.color : '#64748b',
              boxShadow: activeStatus === opt.value ? `0 2px 12px ${opt.color}30` : 'none',
              borderBottom: activeStatus === opt.value ? `2px solid ${opt.color}` : '2px solid transparent'
            }}>
            {statusLabels[opt.value]}
          </button>
        ))}
      </div>

      {animeList?.length === 0 && !isLoading ? (
        <div style={{ textAlign:'center', padding:'60px 0', color:'#64748b',
          fontFamily:"'Sora',sans-serif", fontSize:15 }}>
          {t('profile.noAnime')} 「{statusLabels[activeStatus]}」 {t('profile.noAnimeSuffix')}
        </div>
      ) : (
        <AnimeGrid animeList={animeList} loading={isLoading} error={null} />
      )}
    </div>
  )
}
