import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getUserProfile, followUser, unfollowUser, getFeed } from '../api/social.api'

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
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['profile', username] })

  const followMut = useMutation({
    mutationFn: () => followUser(username),
    onSuccess: invalidate,
  })

  const unfollowMut = useMutation({
    mutationFn: () => unfollowUser(username),
    onSuccess: invalidate,
  })

  return { follow: followMut.mutate, unfollow: unfollowMut.mutate, isPending: followMut.isPending || unfollowMut.isPending }
}

export function useFeed() {
  return useQuery({
    queryKey: ['feed'],
    queryFn: () => getFeed().then(r => r.data.data),
    staleTime: 2 * 60 * 1000,
    retry: false,
  })
}
