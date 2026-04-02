import { useLang } from '../../context/LanguageContext'

const LABEL = { zh: '角色 & 配音', en: 'Characters & Voice Actors' }

function CharCard({ c }) {
  const { lang } = useLang()
  const name = (lang === 'zh' && c.nameCn) ? c.nameCn : (c.nameEn || c.nameJa || '—')
  const va   = (lang === 'zh' && c.voiceActorCn) ? c.voiceActorCn
             : (c.voiceActorEn || c.voiceActorJa || null)

  return (
    <div style={{ flexShrink: 0, width: 96, textAlign: 'center' }}>
      <div style={{
        width: 72, height: 72, borderRadius: '50%', margin: '0 auto 8px',
        overflow: 'hidden', background: '#2c2c2e',
        border: '2px solid rgba(148,163,184,0.12)',
      }}>
        {c.imageUrl
          ? <img src={c.imageUrl} alt={name}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={e => { e.target.style.display = 'none' }} />
          : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontSize: 24, color: 'rgba(235,235,245,0.20)' }}>?</div>
        }
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#ffffff', lineHeight: 1.3,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={name}>{name}</div>
      {va && (
        <div style={{ fontSize: 11, color: 'rgba(235,235,245,0.40)', marginTop: 2,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={va}>{va}</div>
      )}
    </div>
  )
}

export default function CharacterSection({ characters }) {
  const { lang } = useLang()
  if (!characters?.length) return null

  return (
    <section style={{ marginTop: 40 }}>
      <p style={{ color: '#0a84ff', fontSize: 13, fontWeight: 600, letterSpacing: '2px',
        textTransform: 'uppercase', marginBottom: 16 }}>
        {LABEL[lang] ?? LABEL.en}
      </p>
      <div style={{ display: 'flex', gap: 16, overflowX: 'auto', paddingBottom: 8,
        scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
        {characters.map((c, i) => <CharCard key={i} c={c} />)}
      </div>
    </section>
  )
}
