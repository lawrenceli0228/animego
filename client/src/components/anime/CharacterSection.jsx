import { useLang } from '../../context/LanguageContext'

const LABEL = { zh: '角色 & 配音', en: 'Characters' }

const ROLE_LABEL = {
  zh: { MAIN: '主角', SUPPORTING: '配角', BACKGROUND: '客串' },
  en: { MAIN: 'Main', SUPPORTING: 'Supporting', BACKGROUND: 'Background' },
}

function Portrait({ src, alt, w = 58, h = 76 }) {
  return (
    <div style={{
      width: w, height: h, flexShrink: 0,
      borderRadius: 4, overflow: 'hidden', background: '#2c2c2e',
      border: '1px solid rgba(148,163,184,0.10)',
    }}>
      {src && (
        <img src={src} alt={alt}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          onError={e => { e.target.style.display = 'none' }} />
      )}
    </div>
  )
}

function CharPair({ c, lang }) {
  const charName  = (lang === 'zh' && c.nameCn) ? c.nameCn : (c.nameEn || c.nameJa || '—')
  const vaName    = (lang === 'zh' && c.voiceActorCn) ? c.voiceActorCn
                  : (c.voiceActorEn || c.voiceActorJa || null)
  const roleKey   = c.role?.toUpperCase() || 'SUPPORTING'
  const roleLabel = ROLE_LABEL[lang]?.[roleKey] ?? ROLE_LABEL.en[roleKey] ?? roleKey

  return (
    <div style={{
      display: 'flex', alignItems: 'stretch', gap: 0,
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(148,163,184,0.08)',
      borderRadius: 6, overflow: 'hidden',
    }}>
      {/* Character side */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', flex: 1, minWidth: 0 }}>
        <Portrait src={c.imageUrl} alt={charName} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#ffffff',
            lineHeight: 1.35, wordBreak: 'break-word' }}>
            {charName}
          </div>
          <div style={{ fontSize: 11, color: 'rgba(235,235,245,0.40)', marginTop: 3 }}>
            {roleLabel}
          </div>
        </div>
      </div>

      {/* Divider */}
      {vaName && <div style={{ width: 1, background: 'rgba(148,163,184,0.08)', flexShrink: 0 }} />}

      {/* VA side */}
      {vaName && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', flex: 1, minWidth: 0 }}>
          <Portrait src={c.voiceActorImageUrl} alt={vaName} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#ffffff',
              lineHeight: 1.35, wordBreak: 'break-word' }}>
              {vaName}
            </div>
            <div style={{ fontSize: 11, color: 'rgba(235,235,245,0.40)', marginTop: 3 }}>
              {lang === 'zh' ? '日语' : 'Japanese'}
            </div>
          </div>
        </div>
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
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
        gap: 8,
      }}>
        {characters.map((c, i) => <CharPair key={i} c={c} lang={lang} />)}
      </div>
    </section>
  )
}
