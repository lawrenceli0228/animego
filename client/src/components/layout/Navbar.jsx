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
    background: 'linear-gradient(135deg, #0a84ff, #5ac8fa)',
    WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent'
  },
  links: { display: 'flex', gap: 4, flex: 1 },
  link: (active) => ({
    padding: '6px 14px', borderRadius: 8,
    fontSize: 14, fontWeight: 500,
    color: active ? '#ffffff' : 'rgba(235,235,245,0.60)',
    background: active ? 'rgba(10,132,255,0.2)' : 'transparent',
    transition: 'all 0.2s'
  }),
  right: { display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' },
  username: { color: 'rgba(235,235,245,0.60)', fontSize: 14 },
  btnOutline: {
    padding: '6px 16px', borderRadius: 8,
    border: '1px solid rgba(10,132,255,0.4)',
    color: '#ffffff', fontSize: 14, fontWeight: 500,
    transition: 'all 0.2s', cursor: 'pointer', background: 'none'
  },
  btnFill: {
    padding: '6px 16px', borderRadius: 8,
    background: 'linear-gradient(135deg,#0a84ff,#0a84ff)',
    color: '#fff', fontSize: 14, fontWeight: 600,
    border: 'none', cursor: 'pointer'
  },
  langBtn: {
    minHeight: 44, minWidth: 44, padding: '0 10px', borderRadius: 6,
    border: '1px solid rgba(148,163,184,0.2)',
    color: 'rgba(235,235,245,0.60)', fontSize: 12, fontWeight: 600,
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
