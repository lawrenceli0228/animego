import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getComments, addComment, deleteComment } from '../api/comment.api'

export function useComments(anilistId, episode) {
  return useQuery({
    queryKey: ['comments', anilistId, episode],
    queryFn: () => getComments(anilistId, episode).then(r => r.data.data),
    enabled: !!anilistId && episode != null,
    staleTime: 60 * 1000
  })
}

export function useAddComment(anilistId, episode) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data) => addComment(anilistId, episode, typeof data === 'string' ? { content: data } : data).then(r => r.data.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['comments', anilistId, episode] })
  })
}

export function useDeleteComment(anilistId, episode) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id) => deleteComment(id).then(r => r.data.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['comments', anilistId, episode] })
  })
}
