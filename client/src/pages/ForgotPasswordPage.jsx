import { useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../api/axiosClient'
import { useLang } from '../context/LanguageContext'

export default function ForgotPasswordPage() {
  const { t } = useLang()
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)

  const inputStyle = {
    width:'100%', padding:'11px 14px', borderRadius:10,
    background:'#000000', border:'1px solid rgba(148,163,184,0.15)',
    color:'#ffffff', fontSize:14, outline:'none', marginBottom:20,
    boxSizing:'border-box',
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    try {
      await api.post('/auth/forgot-password', { email })
      setSent(true)
      toast.success(t('forgotPassword.success'))
    } catch {
      toast.error('发送失败，请稍后重试')
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
            {t('forgotPassword.title')}
          </h1>
          <p style={{ color:'rgba(235,235,245,0.60)', fontSize:14 }}>{t('forgotPassword.subtitle')}</p>
        </div>

        {sent ? (
          <div style={{ textAlign:'center' }}>
            <div style={{ fontSize:48, marginBottom:16 }}>📧</div>
            <p style={{ color:'rgba(235,235,245,0.60)', fontSize:14, lineHeight:1.7, marginBottom:24 }}>
              {t('forgotPassword.success')}
            </p>
            <Link to="/login" style={{ color:'#0a84ff', fontWeight:600, fontSize:14 }}>
              {t('forgotPassword.backToLogin')}
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <label style={{ display:'block', fontSize:13, fontWeight:600, color:'rgba(235,235,245,0.60)', marginBottom:6 }}>
              {t('forgotPassword.email')}
            </label>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)}
              required style={inputStyle}
              onFocus={e => e.target.style.borderColor='rgba(10,132,255,0.5)'}
              onBlur={e => e.target.style.borderColor='rgba(148,163,184,0.15)'}
            />

            <button type="submit" disabled={loading}
              style={{ width:'100%', padding:'12px', background:'#0a84ff',
                border:'none', borderRadius:10, color:'#fff', fontSize:15, fontWeight:700,
                cursor: loading ? 'not-allowed' : 'pointer', fontFamily:"'Sora',sans-serif",
                opacity: loading ? 0.7 : 1, marginBottom:20 }}>
              {loading ? t('forgotPassword.submitting') : t('forgotPassword.submit')}
            </button>

            <p style={{ textAlign:'center', fontSize:14, color:'rgba(235,235,245,0.30)' }}>
              <Link to="/login" style={{ color:'#0a84ff', fontWeight:600 }}>
                {t('forgotPassword.backToLogin')}
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  )
}
