import { useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../api/axiosClient'
import { useLang } from '../context/LanguageContext'

export default function ResetPasswordPage() {
  const { t } = useLang()
  const { token } = useParams()
  const navigate = useNavigate()
  const [form, setForm] = useState({ password: '', confirm: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const inputStyle = {
    width:'100%', padding:'11px 14px', borderRadius:10,
    background:'#000000', border:'1px solid rgba(148,163,184,0.15)',
    color:'#ffffff', fontSize:14, outline:'none', marginBottom:16,
    boxSizing:'border-box',
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (form.password !== form.confirm) {
      setError(t('resetPassword.mismatch'))
      return
    }
    setLoading(true)
    try {
      await api.post(`/auth/reset-password/${token}`, { password: form.password })
      toast.success(t('resetPassword.success'))
      navigate('/login')
    } catch (err) {
      const msg = err.response?.data?.error?.message || t('resetPassword.invalidToken')
      setError(msg)
    } finally { setLoading(false) }
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
            {t('resetPassword.title')}
          </h1>
          <p style={{ color:'rgba(235,235,245,0.60)', fontSize:14 }}>{t('resetPassword.subtitle')}</p>
        </div>

        <form onSubmit={handleSubmit}>
          {[
            ['password', t('resetPassword.password'), 'password'],
            ['confirm',  t('resetPassword.confirm'),  'password'],
          ].map(([k, l, tp]) => (
            <div key={k}>
              <label style={{ display:'block', fontSize:13, fontWeight:600, color:'rgba(235,235,245,0.60)', marginBottom:6 }}>{l}</label>
              <input
                type={tp} value={form[k]} required
                onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}
                style={inputStyle}
                onFocus={e => e.target.style.borderColor='rgba(10,132,255,0.5)'}
                onBlur={e => e.target.style.borderColor='rgba(148,163,184,0.15)'}
              />
            </div>
          ))}

          {error && <p style={{ color:'#f87171', fontSize:13, marginBottom:12, textAlign:'center' }}>{error}</p>}

          <button type="submit" disabled={loading}
            style={{ width:'100%', padding:'12px', background:'#0a84ff',
              border:'none', borderRadius:10, color:'#fff', fontSize:15, fontWeight:700,
              cursor: loading ? 'not-allowed' : 'pointer', fontFamily:"'Sora',sans-serif",
              opacity: loading ? 0.7 : 1, marginBottom:20 }}>
            {loading ? t('resetPassword.submitting') : t('resetPassword.submit')}
          </button>

          <p style={{ textAlign:'center', fontSize:14, color:'rgba(235,235,245,0.30)' }}>
            <Link to="/login" style={{ color:'#0a84ff', fontWeight:600 }}>
              {t('resetPassword.backToLogin')}
            </Link>
          </p>
        </form>
      </div>
    </div>
  )
}
