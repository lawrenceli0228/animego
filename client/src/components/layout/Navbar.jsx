import { useState, useEffect, useRef } from 'react'
import { Link, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useLang } from '../../context/LanguageContext'
import toast from 'react-hot-toast'

const s = {
  nav: (hidden) => ({
    position: 'sticky', top: 0, zIndex: 100,
    background: 'rgba(0,0,0,0.80)',
    backdropFilter: 'saturate(180%) blur(20px)',
    WebkitBackdropFilter: 'saturate(180%) blur(20px)',
    borderBottom: '1px solid rgba(84,84,88,0.65)',
    padding: '0 24px',
    transform: hidden ? 'translateY(-100%)' : 'translateY(0)',
    transition: 'transform 300ms cubic-bezier(0.4,0,0.2,1)',
  }),
  inner: {
    maxWidth: 1400, margin: '0 auto',
    display: 'flex', alignItems: 'center',
    height: 56, gap: 32
  },
  logo: {
    fontFamily: "'Sora',sans-serif", fontWeight: 700,
    fontSize: 20, letterSpacing: '-0.03em',
    color: '#ffffff', textDecoration: 'none'
  },
  links: { display: 'flex', gap: 4, flex: 1 },
  link: (active) => ({
    padding: '6px 14px', borderRadius: 8,
    fontSize: 14, fontWeight: active ? 600 : 500,
    color: active ? '#ffffff' : 'rgba(235,235,245,0.60)',
    background: active ? 'rgba(255,255,255,0.10)' : 'transparent',
    transition: 'all 0.2s'
  }),
  right: { display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' },
  username: { color: 'rgba(235,235,245,0.60)', fontSize: 14 },
  btnOutline: {
    padding: '6px 16px', borderRadius: 8,
    border: '1px solid rgba(84,84,88,0.65)',
    color: 'rgba(235,235,245,0.60)', fontSize: 14, fontWeight: 500,
    transition: 'all 0.2s', cursor: 'pointer', background: 'none'
  },
  btnFill: {
    padding: '6px 16px', borderRadius: 8,
    background: '#0a84ff',
    color: '#fff', fontSize: 14, fontWeight: 500,
    border: 'none', cursor: 'pointer'
  },
  langBtn: {
    minHeight: 44, minWidth: 44, padding: '0 10px', borderRadius: 8,
    border: '1px solid rgba(84,84,88,0.65)',
    color: 'rgba(235,235,245,0.60)', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', background: 'none', transition: 'all 0.2s'
  }
}

export default function Navbar() {
  const { user, logout } = useAuth()
  const { lang, toggle, t } = useLang()
  const navigate = useNavigate()
  const location = useLocation()
  const [hidden, setHidden] = useState(false)
  const lastY = useRef(0)

  const isPlayer = location.pathname === '/player'

  useEffect(() => {
    if (!isPlayer) { setHidden(false); return; }
    const onScroll = () => {
      const y = window.scrollY;
      setHidden(y > 56 && y > lastY.current);
      lastY.current = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [isPlayer]);

  const handleLogout = async () => {
    await logout()
    toast.success(t('nav.logout'))
    navigate('/')
  }

  return (
    <nav style={s.nav(hidden)}>
      <div style={s.inner}>
        <Link to="/" style={s.logo}>AnimeGo</Link>
        <div style={s.links}>
          {[['/','nav.home'],['/season','nav.season'],['/search','nav.search'],['/player','nav.player']].map(([to, key]) => (
            <NavLink
              key={to}
              to={to}
              end={to==='/'}
              style={({ isActive }) => ({
                ...s.link(isActive),
                ...(to === '/player' ? { display: window.innerWidth <= 600 ? 'none' : undefined } : {}),
              })}
            >
              {t(key)}
            </NavLink>
          ))}
        </div>
        <div style={s.right}>
          <button style={s.langBtn} onClick={toggle}>{lang === 'zh' ? 'EN' : '中'}</button>
          {user ? (
            <>
              <span style={s.username}>{t('nav.hi')}, {user.username}</span>
              {user.role === 'admin' && <Link to="/admin" style={s.btnOutline}>{t('admin.navLabel')}</Link>}
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
