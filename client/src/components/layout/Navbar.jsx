import { Link, NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useLang } from '../../context/LanguageContext'
import toast from 'react-hot-toast'

const s = {
  nav: {
    position: 'sticky', top: 0, zIndex: 100,
    background: 'rgba(10,14,26,0.85)',
    backdropFilter: 'blur(20px)',
    borderBottom: '1px solid rgba(148,163,184,0.08)',
    padding: '0 24px'
  },
  inner: {
    maxWidth: 1400, margin: '0 auto',
    display: 'flex', alignItems: 'center',
    height: 64, gap: 40
  },
  logo: {
    fontFamily: "'Sora',sans-serif", fontWeight: 800,
    fontSize: 22, letterSpacing: '-0.5px',
    background: 'linear-gradient(135deg, #7c3aed, #06b6d4)',
    WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent'
  },
  links: { display: 'flex', gap: 4, flex: 1 },
  link: (active) => ({
    padding: '6px 14px', borderRadius: 8,
    fontSize: 14, fontWeight: 500,
    color: active ? '#f1f5f9' : '#94a3b8',
    background: active ? 'rgba(124,58,237,0.2)' : 'transparent',
    transition: 'all 0.2s'
  }),
  right: { display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' },
  username: { color: '#94a3b8', fontSize: 14 },
  btnOutline: {
    padding: '6px 16px', borderRadius: 8,
    border: '1px solid rgba(124,58,237,0.4)',
    color: '#f1f5f9', fontSize: 14, fontWeight: 500,
    transition: 'all 0.2s', cursor: 'pointer', background: 'none'
  },
  btnFill: {
    padding: '6px 16px', borderRadius: 8,
    background: 'linear-gradient(135deg,#7c3aed,#6d28d9)',
    color: '#fff', fontSize: 14, fontWeight: 600,
    border: 'none', cursor: 'pointer'
  },
  langBtn: {
    padding: '4px 10px', borderRadius: 6,
    border: '1px solid rgba(148,163,184,0.2)',
    color: '#94a3b8', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', background: 'none', transition: 'all 0.2s'
  }
}

export default function Navbar() {
  const { user, logout } = useAuth()
  const { lang, toggle, t } = useLang()
  const navigate = useNavigate()

  const handleLogout = async () => {
    await logout()
    toast.success(t('nav.logout'))
    navigate('/')
  }

  return (
    <nav style={s.nav}>
      <div style={s.inner}>
        <Link to="/" style={s.logo}>AnimeGo</Link>
        <div style={s.links}>
          {[['/','nav.home'],['/season','nav.season'],['/search','nav.search']].map(([to, key]) => (
            <NavLink key={to} to={to} end={to==='/'} style={({ isActive }) => s.link(isActive)}>{t(key)}</NavLink>
          ))}
        </div>
        <div style={s.right}>
          <button style={s.langBtn} onClick={toggle}>{lang === 'zh' ? 'EN' : '中'}</button>
          {user ? (
            <>
              <span style={s.username}>{t('nav.hi')}, {user.username}</span>
              <Link to="/profile" style={s.btnOutline}>{t('nav.myList')}</Link>
              <button style={s.btnOutline} onClick={handleLogout}>{t('nav.logout')}</button>
            </>
          ) : (
            <>
              <Link to="/login" style={s.btnOutline}>{t('nav.login')}</Link>
              <Link to="/register" style={s.btnFill}>{t('nav.register')}</Link>
            </>
          )}
        </div>
      </div>
    </nav>
  )
}
