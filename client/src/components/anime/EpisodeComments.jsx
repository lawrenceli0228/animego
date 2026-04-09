import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useLang } from '../../context/LanguageContext'
import { useComments, useAddComment, useDeleteComment } from '../../hooks/useComment'

function CommentInput({ onSubmit, isPending, placeholder, autoFocus, onCancel }) {
  const [text, setText] = useState('')
  const { t } = useLang()

  const handlePost = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSubmit(trimmed, () => setText(''))
  }

  return (
    <div>
      <textarea
        value={text} onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handlePost() }}
        placeholder={placeholder} maxLength={500} rows={2}
        autoFocus={autoFocus}
        style={{
          width: '100%', padding: '10px 14px', borderRadius: 8,
          border: '1px solid #38383a', background: '#2c2c2e', color: '#ffffff',
          fontSize: 13, resize: 'vertical', outline: 'none', boxSizing: 'border-box',
          fontFamily: 'inherit', lineHeight: 1.6,
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
        <span style={{ fontSize: 11, color: text.length > 480 ? '#ff453a' : 'rgba(235,235,245,0.30)' }}>
          {text.length}/500
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          {onCancel && (
            <button onClick={onCancel} style={{
              padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
              background: 'transparent', color: 'rgba(235,235,245,0.40)', fontSize: 12,
            }}>{t('comment.cancel') || '取消'}</button>
          )}
          <button
            onClick={handlePost}
            disabled={isPending || !text.trim()}
            style={{
              padding: '6px 16px', borderRadius: 6, border: 'none',
              cursor: isPending || !text.trim() ? 'default' : 'pointer',
              background: '#0a84ff', color: '#fff', fontWeight: 500, fontSize: 12,
              opacity: isPending || !text.trim() ? 0.35 : 1, transition: 'opacity 0.2s',
            }}
          >{isPending ? t('comment.posting') : t('comment.post')}</button>
        </div>
      </div>
    </div>
  )
}

function CommentItem({ comment, replies, user, onReply, onDelete, confirmId, setConfirmId, lang, t, depth = 0 }) {
  const c = comment
  const isOwn = user && String(user._id) === String(c.userId)

  return (
    <div style={{ marginLeft: depth > 0 ? 24 : 0 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', paddingTop: depth > 0 ? 10 : 0 }}>
        <div style={{
          width: depth > 0 ? 26 : 32, height: depth > 0 ? 26 : 32,
          borderRadius: '50%', background: '#0a84ff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0, fontSize: depth > 0 ? 11 : 13, fontWeight: 700,
          color: '#fff', textTransform: 'uppercase',
        }}>
          {c.username[0]}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#0a84ff' }}>{c.username}</span>
            {c.replyToUsername && (
              <span style={{ fontSize: 11, color: 'rgba(235,235,245,0.30)' }}>
                → {c.replyToUsername}
              </span>
            )}
            <span style={{ fontSize: 11, color: 'rgba(235,235,245,0.25)' }}>
              {new Date(c.createdAt).toLocaleDateString()}
            </span>
          </div>
          <p style={{
            fontSize: 13, color: 'rgba(235,235,245,0.60)', lineHeight: 1.6,
            margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>{c.content}</p>
          <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
            {user && (
              <button onClick={() => onReply(c)} style={{
                background: 'none', border: 'none', color: 'rgba(235,235,245,0.30)',
                cursor: 'pointer', fontSize: 11, padding: 0, transition: 'color 0.15s',
              }}
                onMouseEnter={e => e.currentTarget.style.color = '#0a84ff'}
                onMouseLeave={e => e.currentTarget.style.color = 'rgba(235,235,245,0.30)'}
              >{lang === 'zh' ? '回复' : 'Reply'}</button>
            )}
            {isOwn && (
              confirmId === c._id ? (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => { onDelete(c._id); setConfirmId(null) }}
                    style={{ background: 'none', border: 'none', color: '#ff453a', cursor: 'pointer', fontSize: 11, padding: 0, fontWeight: 600 }}>
                    {t('comment.deleteConfirm')}
                  </button>
                  <button onClick={() => setConfirmId(null)}
                    style={{ background: 'none', border: 'none', color: 'rgba(235,235,245,0.30)', cursor: 'pointer', fontSize: 11, padding: 0 }}>
                    {lang === 'zh' ? '取消' : 'Cancel'}
                  </button>
                </div>
              ) : (
                <button onClick={() => setConfirmId(c._id)}
                  style={{ background: 'none', border: 'none', color: 'rgba(235,235,245,0.30)', cursor: 'pointer', fontSize: 11, padding: 0, transition: 'color 0.15s' }}
                  onMouseEnter={e => e.currentTarget.style.color = '#ff453a'}
                  onMouseLeave={e => e.currentTarget.style.color = 'rgba(235,235,245,0.30)'}
                >{t('comment.delete')}</button>
              )
            )}
          </div>
        </div>
      </div>
      {/* Nested replies */}
      {replies?.length > 0 && (
        <div style={{
          borderLeft: '2px solid #38383a', marginLeft: 15, marginTop: 4, paddingLeft: 0,
        }}>
          {replies.map(r => (
            <CommentItem key={r._id} comment={r} replies={r.children}
              user={user} onReply={onReply} onDelete={onDelete}
              confirmId={confirmId} setConfirmId={setConfirmId}
              lang={lang} t={t} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function EpisodeComments({ anilistId, episode }) {
  const { user } = useAuth()
  const { t, lang } = useLang()
  const [confirmId, setConfirmId] = useState(null)
  const [replyTarget, setReplyTarget] = useState(null) // { _id, username, parentId }

  const { data: comments = [], isLoading } = useComments(anilistId, episode)
  const { mutate: addComment, isPending: isPosting } = useAddComment(anilistId, episode)
  const { mutate: deleteComment } = useDeleteComment(anilistId, episode)

  // Build tree: top-level (parentId=null) with nested children
  const tree = useMemo(() => {
    const byParent = new Map()
    for (const c of comments) {
      const pid = c.parentId ? String(c.parentId) : 'root'
      if (!byParent.has(pid)) byParent.set(pid, [])
      byParent.get(pid).push(c)
    }
    function attach(list) {
      return list.map(c => ({
        ...c,
        children: attach(byParent.get(String(c._id)) || []),
      }))
    }
    const roots = byParent.get('root') || []
    // Top-level: newest first
    roots.reverse()
    return attach(roots)
  }, [comments])

  const handlePost = (text, onDone) => {
    addComment(text, { onSuccess: onDone })
  }

  const handleReply = (text, onDone) => {
    // All replies go under the top-level parent (flatten to 2 levels max)
    const topParentId = replyTarget.parentId || replyTarget._id
    addComment(
      { content: text, parentId: topParentId, replyToUsername: replyTarget.username },
      { onSuccess: () => { onDone(); setReplyTarget(null) } }
    )
  }

  const startReply = (comment) => {
    setReplyTarget({
      _id: comment._id,
      username: comment.username,
      parentId: comment.parentId || null, // if replying to a reply, use its parent
    })
  }

  return (
    <div style={{ padding: '20px 24px 24px' }}>
      <p style={{
        color: '#0a84ff', fontSize: 12, fontWeight: 700,
        letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 16,
      }}>
        {t('comment.title')} · Ep {episode}
        {comments.length > 0 && (
          <span style={{ color: 'rgba(235,235,245,0.30)', fontWeight: 400, marginLeft: 8 }}>
            {comments.length}
          </span>
        )}
      </p>

      {user ? (
        <div style={{ marginBottom: 20 }}>
          <CommentInput
            onSubmit={handlePost}
            isPending={isPosting && !replyTarget}
            placeholder={t('comment.placeholder')}
          />
        </div>
      ) : (
        <div style={{
          marginBottom: 20, padding: '12px 16px', borderRadius: 8,
          background: 'rgba(10,132,255,0.08)', border: '1px solid rgba(10,132,255,0.15)',
          color: 'rgba(235,235,245,0.60)', fontSize: 13,
        }}>
          {t('comment.loginPrompt')}
          <Link to="/login" style={{ color: '#0a84ff', fontWeight: 600, textDecoration: 'none' }}>
            {t('comment.loginLink')}
          </Link>
          {t('comment.loginSuffix')}
        </div>
      )}

      {/* Reply input (floating) */}
      {replyTarget && (
        <div style={{
          marginBottom: 16, padding: 12, borderRadius: 10,
          background: 'rgba(10,132,255,0.06)', border: '1px solid rgba(10,132,255,0.15)',
        }}>
          <p style={{ fontSize: 12, color: 'rgba(235,235,245,0.40)', margin: '0 0 8px' }}>
            {lang === 'zh' ? `回复 @${replyTarget.username}` : `Replying to @${replyTarget.username}`}
          </p>
          <CommentInput
            onSubmit={handleReply}
            isPending={isPosting && !!replyTarget}
            placeholder={lang === 'zh' ? `回复 ${replyTarget.username}...` : `Reply to ${replyTarget.username}...`}
            autoFocus
            onCancel={() => setReplyTarget(null)}
          />
        </div>
      )}

      {isLoading ? (
        <p style={{ color: 'rgba(235,235,245,0.30)', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>...</p>
      ) : tree.length === 0 ? (
        <p style={{ color: 'rgba(235,235,245,0.30)', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>
          {t('comment.noComments')}
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {tree.map(c => (
            <CommentItem key={c._id} comment={c} replies={c.children}
              user={user} onReply={startReply} onDelete={deleteComment}
              confirmId={confirmId} setConfirmId={setConfirmId}
              lang={lang} t={t} />
          ))}
        </div>
      )}
    </div>
  )
}
