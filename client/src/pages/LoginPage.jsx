import { useState } from 'react'
import { Link, useNavigate, Navigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../context/AuthContext'
import { useLang } from '../context/LanguageContext'

export default function LoginPage() {
  const { login, user, initializing } = useAuth()
  const { t } = useLang()
  const navigate = useNavigate()

  if (!initializing && user) return <Navigate to="/" replace />
  const [form, setForm] = useState({ email:'', password:'' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(form.email, form.password)
      toast.success(t('login.success'))
      navigate('/')
    } catch (err) {
      setError(err.response?.data?.error?.message || t('login.fail'))
    } finally { setLoading(false) }
  }

  const inputStyle = {
    width:'100%', padding:'11px 14px', borderRadius:10,
    background:'#000000', border:'1px solid rgba(148,163,184,0.15)',
    color:'#ffffff', fontSize:14, outline:'none', marginBottom:16
  }

  return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', padding:'40px 24px' }}>
      <div style={{ width:'100%', maxWidth:420, background:'#1c1c1e',
        border:'1px solid rgba(10,132,255,0.2)', borderRadius:16, padding:40,
        boxShadow:'0 24px 60px rgba(0,0,0,0.5)' }}>
        <div style={{ textAlign:'center', marginBottom:32 }}>
          <h1 style={{ fontFamily:"'Sora',sans-serif", fontSize:28,
            background:'linear-gradient(135deg,#0a84ff,#5ac8fa)',
            WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', marginBottom:8 }}>
            {t('login.title')}
          </h1>
          <p style={{ color:'rgba(235,235,245,0.60)', fontSize:14 }}>{t('login.subtitle')}</p>
        </div>

        <form onSubmit={handleSubmit}>
          {[['email', t('login.email'), 'email'], ['password', t('login.password'), 'password']].map(([k,l,tp]) => (
            <div key={k}>
              <label style={{ display:'block', fontSize:13, fontWeight:600, color:'rgba(235,235,245,0.60)', marginBottom:6 }}>{l}</label>
              <input type={tp} value={form[k]} onChange={set(k)} required style={inputStyle}
                onFocus={e => e.target.style.borderColor='rgba(10,132,255,0.5)'}
                onBlur={e => e.target.style.borderColor='rgba(148,163,184,0.15)'}
              />
            </div>
          ))}

          <div style={{ textAlign:'right', marginTop:-8, marginBottom:16 }}>
            <Link to="/forgot-password" style={{ color:'#0a84ff', fontSize:13, fontWeight:500 }}>
              {t('login.forgotPassword')}
            </Link>
          </div>

          {error && <p style={{ color:'#f87171', fontSize:13, marginBottom:12, textAlign:'center' }}>{error}</p>}

          <button type="submit" disabled={loading}
            style={{ width:'100%', padding:'12px', background:'#0a84ff',
              border:'none', borderRadius:10, color:'#fff', fontSize:15, fontWeight:700,
              cursor: loading ? 'not-allowed' : 'pointer', fontFamily:"'Sora',sans-serif",
              opacity: loading ? 0.7 : 1 }}>
            {loading ? t('login.submitting') : t('login.submit')}
          </button>
        </form>

        <p style={{ textAlign:'center', marginTop:20, fontSize:14, color:'rgba(235,235,245,0.30)' }}>
          {t('login.noAccount')}{' '}
          <Link to="/register" style={{ color:'#0a84ff', fontWeight:600 }}>{t('login.registerLink')}</Link>
        </p>
      </div>
    </div>
  )
}
