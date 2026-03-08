import { useState } from 'react'
import { Link, useNavigate, Navigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../context/AuthContext'
import { useLang } from '../context/LanguageContext'

export default function RegisterPage() {
  const { register, user, initializing } = useAuth()
  const { t } = useLang()
  const navigate = useNavigate()

  if (!initializing && user) return <Navigate to="/" replace />
  const [form, setForm] = useState({ username:'', email:'', password:'' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (form.password.length < 6) { setError(t('register.pwdTooShort')); return }
    setLoading(true)
    try {
      await register(form.username, form.email, form.password)
      toast.success(t('register.success'))
      navigate('/')
    } catch (err) {
      setError(err.response?.data?.error?.message || t('register.fail'))
    } finally { setLoading(false) }
  }

  const inputStyle = {
    width:'100%', padding:'11px 14px', borderRadius:10,
    background:'#0a0e1a', border:'1px solid rgba(148,163,184,0.15)',
    color:'#f1f5f9', fontSize:14, outline:'none', marginBottom:16
  }

  return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', padding:'40px 24px' }}>
      <div style={{ width:'100%', maxWidth:420, background:'#111827',
        border:'1px solid rgba(124,58,237,0.2)', borderRadius:16, padding:40,
        boxShadow:'0 24px 60px rgba(0,0,0,0.5)' }}>
        <div style={{ textAlign:'center', marginBottom:32 }}>
          <h1 style={{ fontFamily:"'Sora',sans-serif", fontSize:28,
            background:'linear-gradient(135deg,#7c3aed,#06b6d4)',
            WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', marginBottom:8 }}>
            {t('register.title')}
          </h1>
          <p style={{ color:'#94a3b8', fontSize:14 }}>{t('register.subtitle')}</p>
        </div>

        <form onSubmit={handleSubmit}>
          {[['username', t('register.username'), 'text'], ['email', t('register.email'), 'email'], ['password', t('register.password'), 'password']].map(([k,l,tp]) => (
            <div key={k}>
              <label style={{ display:'block', fontSize:13, fontWeight:600, color:'#94a3b8', marginBottom:6 }}>{l}</label>
              <input type={tp} value={form[k]} onChange={set(k)} required style={inputStyle}
                onFocus={e => e.target.style.borderColor='rgba(124,58,237,0.5)'}
                onBlur={e => e.target.style.borderColor='rgba(148,163,184,0.15)'}
              />
            </div>
          ))}

          {error && <p style={{ color:'#f87171', fontSize:13, marginBottom:12, textAlign:'center' }}>{error}</p>}

          <button type="submit" disabled={loading}
            style={{ width:'100%', padding:'12px', background:'linear-gradient(135deg,#7c3aed,#06b6d4)',
              border:'none', borderRadius:10, color:'#fff', fontSize:15, fontWeight:700,
              cursor: loading ? 'not-allowed' : 'pointer', fontFamily:"'Sora',sans-serif",
              opacity: loading ? 0.7 : 1 }}>
            {loading ? t('register.submitting') : t('register.submit')}
          </button>
        </form>

        <p style={{ textAlign:'center', marginTop:20, fontSize:14, color:'#64748b' }}>
          {t('register.hasAccount')}{' '}
          <Link to="/login" style={{ color:'#7c3aed', fontWeight:600 }}>{t('register.loginLink')}</Link>
        </p>
      </div>
    </div>
  )
}
