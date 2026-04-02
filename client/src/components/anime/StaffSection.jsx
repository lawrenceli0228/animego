import { useLang } from '../../context/LanguageContext'

const LABEL = { zh: '制作人员', en: 'Staff' }

export default function StaffSection({ staff }) {
  const { lang } = useLang()
  if (!staff?.length) return null

  return (
    <section style={{ marginTop: 40 }}>
      <p style={{ color: '#0a84ff', fontSize: 13, fontWeight: 600, letterSpacing: '2px',
        textTransform: 'uppercase', marginBottom: 16 }}>
        {LABEL[lang] ?? LABEL.en}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px 16px' }}>
        {staff.map((s, i) => {
          const name = (lang === 'zh' && s.nameJa) ? s.nameJa : (s.nameEn || s.nameJa || '—')
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                overflow: 'hidden', background: '#2c2c2e',
                border: '1px solid rgba(148,163,184,0.10)',
              }}>
                {s.imageUrl
                  ? <img src={s.imageUrl} alt={name}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      onError={e => { e.target.style.display = 'none' }} />
                  : null
                }
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#ffffff',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                {s.role && (
                  <div style={{ fontSize: 11, color: 'rgba(235,235,245,0.40)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.role}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
