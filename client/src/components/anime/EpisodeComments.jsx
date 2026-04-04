import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useLang } from '../../context/LanguageContext'
import { useComments, useAddComment, useDeleteComment } from '../../hooks/useComment'

export default function EpisodeComments({ anilistId, episode }) {
  const { user } = useAuth()
  const { t } = useLang()
  const [text, setText] = useState('')
  const [confirmId, setConfirmId] = useState(null)

  const { data: comments = [], isLoading } = useComments(anilistId, episode)
  const { mutate: addComment, isPending: isPosting, isError: postError } = useAddComment(anilistId, episode)
  const { mutate: deleteComment } = useDeleteComment(anilistId, episode)

  function handlePost() {
    const trimmed = text.trim()
    if (!trimmed) return
    addComment(trimmed, { onSuccess: () => setText('') })
  }

  return (
    <div style={{ padding: '20px 24px 24px' }}>
      <p style={{ color: '#0a84ff', fontSize: 12, fontWeight: 700, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 16 }}>
        {t('comment.title')} · Ep {episode}
      </p>

      {user ? (
        <div style={{ marginBottom: 20 }}>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handlePost() }}
            placeholder={t('comment.placeholder')}
            maxLength={500}
            rows={3}
            style={{ width: '100%', padding: '12px 16px', borderRadius: 8, border: '1px solid #38383a', background: '#2c2c2e', color: '#ffffff', fontSize: 14, resize: 'vertical', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', lineHeight: 1.6 }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
            <span style={{ fontSize: 11, color: text.length > 480 ? '#ff453a' : 'rgba(235,235,245,0.30)' }}>{text.length}/500</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {postError && <span style={{ fontSize: 11, color: '#ff453a' }}>发布失败，请重试</span>}
              <button
                onClick={handlePost}
                disabled={isPosting || !text.trim()}
                style={{ padding: '10px 20px', borderRadius: 8, border: 'none', cursor: isPosting || !text.trim() ? 'default' : 'pointer', background: '#0a84ff', color: '#fff', fontWeight: 500, fontSize: 14, opacity: isPosting || !text.trim() ? 0.35 : 1, transition: 'opacity 0.2s' }}
              >
                {isPosting ? t('comment.posting') : t('comment.post')}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: 20, padding: '12px 16px', borderRadius: 8, background: 'rgba(10,132,255,0.08)', border: '1px solid rgba(10,132,255,0.15)', color: 'rgba(235,235,245,0.60)', fontSize: 13 }}>
          {t('comment.loginPrompt')}
          <Link to="/login" style={{ color: '#0a84ff', fontWeight: 600, textDecoration: 'none' }}>{t('comment.loginLink')}</Link>
          {t('comment.loginSuffix')}
        </div>
      )}

      {isLoading ? (
        <p style={{ color: 'rgba(235,235,245,0.30)', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>...</p>
      ) : comments.length === 0 ? (
        <p style={{ color: 'rgba(235,235,245,0.30)', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>{t('comment.noComments')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {comments.map(c => (
            <div key={c._id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#0a84ff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 13, fontWeight: 700, color: '#fff', textTransform: 'uppercase' }}>
                {c.username[0]}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#0a84ff' }}>{c.username}</span>
                  <span style={{ fontSize: 11, color: 'rgba(235,235,245,0.30)' }}>{new Date(c.createdAt).toLocaleDateString()}</span>
                  {user && String(user._id) === String(c.userId) && (
                    confirmId === c._id ? (
                      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                        <button
                          onClick={() => { deleteComment(c._id); setConfirmId(null) }}
                          style={{ background: 'none', border: 'none', color: '#ff453a', cursor: 'pointer', fontSize: 12, padding: '0 4px', fontWeight: 600 }}
                        >{t('comment.deleteConfirm')}</button>
                        <button
                          onClick={() => setConfirmId(null)}
                          style={{ background: 'none', border: 'none', color: 'rgba(235,235,245,0.30)', cursor: 'pointer', fontSize: 12, padding: '0 4px' }}
                        >取消</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmId(c._id)}
                        style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'rgba(235,235,245,0.30)', cursor: 'pointer', fontSize: 12, padding: '0 4px', transition: 'color 0.15s' }}
                        onMouseEnter={e => e.currentTarget.style.color = '#ff453a'}
                        onMouseLeave={e => e.currentTarget.style.color = 'rgba(235,235,245,0.30)'}
                      >{t('comment.delete')}</button>
                    )
                  )}
                </div>
                <p style={{ fontSize: 13, color: 'rgba(235,235,245,0.60)', lineHeight: 1.65, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{c.content}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
