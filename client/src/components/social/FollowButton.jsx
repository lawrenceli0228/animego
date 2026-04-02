import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '../../context/AuthContext'
import { useFollow } from '../../hooks/useSocial'
import { useLang } from '../../context/LanguageContext'

export default function FollowButton({ username, isFollowing, isSelf }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { t } = useLang()
  const { follow, unfollow, isPending } = useFollow(username)

  if (isSelf) return null

  const handleClick = () => {
    if (!user) return navigate('/login')
    if (isFollowing) unfollow(undefined, { onSuccess: () => toast(t('social.unfollowedToast')) })
    else follow(undefined, { onSuccess: () => toast(t('social.followedToast')) })
  }

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      style={{
        padding: '8px 20px',
        borderRadius: 8,
        border: isFollowing ? '1px solid rgba(148,163,184,0.3)' : 'none',
        background: isFollowing ? 'transparent' : '#0a84ff',
        color: isFollowing ? 'rgba(235,235,245,0.60)' : '#fff',
        fontSize: 13,
        fontWeight: 600,
        cursor: isPending ? 'wait' : 'pointer',
        transition: 'all 0.2s',
        flexShrink: 0,
        minWidth: 88,
      }}
    >
      {isPending ? '...' : isFollowing ? t('social.unfollow') : t('social.follow')}
    </button>
  )
}
