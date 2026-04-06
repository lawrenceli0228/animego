import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { getUserProfile, followUser, unfollowUser, getFeed, getFollowers, getFollowing } from '../api/social.api'
import { useAuth } from '../context/AuthContext'
import { useLang } from '../context/LanguageContext'

export function useUserProfile(username) {
  return useQuery({
    queryKey: ['profile', username],
    queryFn: () => getUserProfile(username).then(r => r.data.data),
    enabled: !!username,
    staleTime: 2 * 60 * 1000,
    retry: false,
  })
}

export function useFollow(username) {
  const queryClient = useQueryClient()
  const { t } = useLang()
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['profile', username] })

  const followMut = useMutation({
    mutationFn: () => followUser(username),
    onSuccess: invalidate,
    onError: () => toast.error(t('social.followFailed')),
  })

  const unfollowMut = useMutation({
    mutationFn: () => unfollowUser(username),
    onSuccess: invalidate,
    onError: () => toast.error(t('social.unfollowFailed')),
  })

  return { follow: followMut.mutate, unfollow: unfollowMut.mutate, isPending: followMut.isPending || unfollowMut.isPending }
}

export function useFollowList(username, type) {
  return useQuery({
    queryKey: ['followList', username, type],
    queryFn: () => (type === 'followers' ? getFollowers(username) : getFollowing(username))
      .then(r => r.data),
    enabled: !!username && !!type,
    staleTime: 2 * 60 * 1000,
    retry: false,
  })
}

export function useFeed() {
  const { user } = useAuth()
  return useInfiniteQuery({
    queryKey: ['feed'],
    queryFn: ({ pageParam = 1 }) => getFeed(pageParam).then(r => r.data),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.nextPage,
    enabled: !!user,
    staleTime: 2 * 60 * 1000,
    retry: false,
  })
}
