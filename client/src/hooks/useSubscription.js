import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getSubscriptions, getSubscription,
  addSubscription, updateSubscription, removeSubscription
} from '../api/subscription.api'
import { useAuth } from '../context/AuthContext'

export function useSubscriptions(status) {
  const { user } = useAuth()
  return useQuery({
    queryKey: ['subscriptions', status],
    queryFn: () => getSubscriptions(status).then(r => r.data.data),
    enabled: !!user,
    staleTime: 1 * 60 * 1000
  })
}

export function useSubscription(anilistId) {
  const { user } = useAuth()
  return useQuery({
    queryKey: ['subscription', anilistId],
    queryFn: () => getSubscription(anilistId).then(r => r.data.data),
    enabled: !!user && !!anilistId,
    retry: false
  })
}

export function useAddSubscription() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data) => addSubscription(data).then(r => r.data.data),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['subscriptions'] })
      qc.invalidateQueries({ queryKey: ['subscription', vars.anilistId] })
    }
  })
}

export function useUpdateSubscription() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ anilistId, ...data }) => updateSubscription(anilistId, data).then(r => r.data.data),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['subscriptions'] })
      qc.invalidateQueries({ queryKey: ['subscription', vars.anilistId] })
    }
  })
}

export function useRemoveSubscription() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (anilistId) => removeSubscription(anilistId).then(r => r.data.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['subscriptions'] })
    }
  })
}
