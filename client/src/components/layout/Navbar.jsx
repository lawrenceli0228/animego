import { Link, NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
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
  }
}

export default function Navbar() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = async () => {
    await logout()
    toast.success('已登出')
    navigate('/')
  }

  return (
    <nav style={s.nav}>
      <div style={s.inner}>
        <Link to="/" style={s.logo}>AnimeGo</Link>
        <div style={s.links}>
          {[['/', '首页'], ['/season', '季度'], ['/search', '搜索']].map(([to, label]) => (
            <NavLink key={to} to={to} end={to==='/'} style={({ isActive }) => s.link(isActive)}>{label}</NavLink>
          ))}
        </div>
        <div style={s.right}>
          {user ? (
            <>
              <span style={s.username}>Hi, {user.username}</span>
              <Link to="/profile" style={s.btnOutline}>我的追番</Link>
              <button style={s.btnOutline} onClick={handleLogout}>登出</button>
            </>
          ) : (
            <>
              <Link to="/login" style={s.btnOutline}>登录</Link>
              <Link to="/register" style={s.btnFill}>注册</Link>
            </>
          )}
        </div>
      </div>
    </nav>
  )
}
