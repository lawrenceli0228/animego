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
    width:'100%', padding:'12px 16px', borderRadius:8,
    background:'#2c2c2e', border:'1px solid #38383a',
    color:'#ffffff', fontSize:14, outline:'none', marginBottom:16,
    transition:'border-color 0.2s, box-shadow 0.2s'
  }

  return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', padding:'40px 24px' }}>
      <div style={{ width:'100%', maxWidth:420, background:'#1c1c1e',
        border:'1px solid #38383a', borderRadius:16, padding:40,
        boxShadow:'0 16px 48px rgba(0,0,0,0.60)' }}>
        <div style={{ textAlign:'center', marginBottom:32 }}>
          <h1 style={{ fontFamily:"'Sora',sans-serif", fontSize:28,
            color:'#ffffff', marginBottom:8 }}>
            {t('register.title')}
          </h1>
          <p style={{ color:'rgba(235,235,245,0.60)', fontSize:14 }}>{t('register.subtitle')}</p>
        </div>

        <form onSubmit={handleSubmit}>
          {[['username', t('register.username'), 'text'], ['email', t('register.email'), 'email'], ['password', t('register.password'), 'password']].map(([k,l,tp]) => (
            <div key={k}>
              <label style={{ display:'block', fontSize:13, fontWeight:600, color:'rgba(235,235,245,0.60)', marginBottom:6 }}>{l}</label>
              <input type={tp} value={form[k]} onChange={set(k)} required style={inputStyle}
                onFocus={e => { e.target.style.borderColor='#0a84ff'; e.target.style.boxShadow='0 0 0 3px rgba(10,132,255,0.25)' }}
                onBlur={e => { e.target.style.borderColor='#38383a'; e.target.style.boxShadow='none' }}
              />
            </div>
          ))}

          {error && <p style={{ color:'#ff453a', fontSize:13, marginBottom:12, textAlign:'center' }}>{error}</p>}

          <button type="submit" disabled={loading}
            style={{ width:'100%', padding:'12px', background:'#0a84ff',
              border:'none', borderRadius:10, color:'#fff', fontSize:15, fontWeight:700,
              cursor: loading ? 'not-allowed' : 'pointer', fontFamily:"'Sora',sans-serif",
              opacity: loading ? 0.7 : 1 }}>
            {loading ? t('register.submitting') : t('register.submit')}
          </button>
        </form>

        <p style={{ textAlign:'center', marginTop:20, fontSize:14, color:'rgba(235,235,245,0.30)' }}>
          {t('register.hasAccount')}{' '}
          <Link to="/login" style={{ color:'#0a84ff', fontWeight:600 }}>{t('register.loginLink')}</Link>
        </p>
      </div>
    </div>
  )
}
