import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useLang } from '../../context/LanguageContext'
import { useComments, useAddComment, useDeleteComment } from '../../hooks/useComment'

export default function EpisodeComments({ anilistId, episode }) {
  const { user } = useAuth()
  const { t } = useLang()
  const [text, setText] = useState('')

  const { data: comments = [], isLoading } = useComments(anilistId, episode)
  const { mutate: addComment, isPending: isPosting } = useAddComment(anilistId, episode)
  const { mutate: deleteComment } = useDeleteComment(anilistId, episode)

  function handlePost() {
    const trimmed = text.trim()
    if (!trimmed) return
    addComment(trimmed, { onSuccess: () => setText('') })
  }

  return (
    <div style={{ padding: '20px 24px 24px' }}>
      <p style={{ color: '#7c3aed', fontSize: 12, fontWeight: 700, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 16 }}>
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
            style={{ width: '100%', padding: '10px 14px', borderRadius: 10, border: '1px solid rgba(148,163,184,0.15)', background: 'rgba(255,255,255,0.05)', color: '#f1f5f9', fontSize: 13, resize: 'vertical', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', lineHeight: 1.6 }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
            <span style={{ fontSize: 11, color: text.length > 480 ? '#ef4444' : '#475569' }}>{text.length}/500</span>
            <button
              onClick={handlePost}
              disabled={isPosting || !text.trim()}
              style={{ padding: '8px 20px', borderRadius: 8, border: 'none', cursor: isPosting || !text.trim() ? 'default' : 'pointer', background: 'linear-gradient(135deg,#7c3aed,#06b6d4)', color: '#fff', fontWeight: 700, fontSize: 13, opacity: isPosting || !text.trim() ? 0.5 : 1, transition: 'opacity 0.2s' }}
            >
              {isPosting ? t('comment.posting') : t('comment.post')}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: 20, padding: '12px 16px', borderRadius: 10, background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.15)', color: '#94a3b8', fontSize: 13 }}>
          {t('comment.loginPrompt')}
          <Link to="/login" style={{ color: '#a78bfa', fontWeight: 600, textDecoration: 'none' }}>{t('comment.loginLink')}</Link>
          {t('comment.loginSuffix')}
        </div>
      )}

      {isLoading ? (
        <p style={{ color: '#475569', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>...</p>
      ) : comments.length === 0 ? (
        <p style={{ color: '#475569', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>{t('comment.noComments')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {comments.map(c => (
            <div key={c._id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'linear-gradient(135deg,#7c3aed,#06b6d4)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 13, fontWeight: 700, color: '#fff', textTransform: 'uppercase' }}>
                {c.username[0]}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#a78bfa' }}>{c.username}</span>
                  <span style={{ fontSize: 11, color: '#475569' }}>{new Date(c.createdAt).toLocaleDateString()}</span>
                  {user && String(user._id) === String(c.userId) && (
                    <button
                      onClick={() => { if (window.confirm(t('comment.deleteConfirm'))) deleteComment(c._id) }}
                      style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 12, padding: '0 4px', transition: 'color 0.15s' }}
                      onMouseEnter={e => e.currentTarget.style.color = '#ef4444'}
                      onMouseLeave={e => e.currentTarget.style.color = '#475569'}
                    >
                      {t('comment.delete')}
                    </button>
                  )}
                </div>
                <p style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.65, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{c.content}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
