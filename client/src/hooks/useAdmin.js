import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { getAdminStats, getEnrichmentList, resetEnrichment, flagEnrichment, getUserList, createUser, updateUser, deleteUser } from '../api/admin.api'
import { useLang } from '../context/LanguageContext'

export function useAdminStats() {
  return useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: () => getAdminStats().then(r => r.data.data),
    staleTime: 60 * 1000,
    retry: false,
  })
}

export function useEnrichmentList(page, filter, q) {
  return useQuery({
    queryKey: ['admin', 'enrichment', page, filter, q],
    queryFn: () => getEnrichmentList(page, filter, q).then(r => r.data),
    staleTime: 30 * 1000,
    retry: false,
  })
}

export function useResetEnrichment() {
  const queryClient = useQueryClient()
  const { t } = useLang()
  return useMutation({
    mutationFn: (anilistId) => resetEnrichment(anilistId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin'] })
      toast.success(t('admin.resetSuccess'))
    },
    onError: () => toast.error(t('admin.resetFailed')),
  })
}

export function useFlagEnrichment() {
  const queryClient = useQueryClient()
  const { t } = useLang()
  return useMutation({
    mutationFn: ({ anilistId, flag }) => flagEnrichment(anilistId, flag),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin'] })
      toast.success(t('admin.flagSuccess'))
    },
    onError: () => toast.error(t('admin.flagFailed')),
  })
}

export function useUserList(page, q) {
  return useQuery({
    queryKey: ['admin', 'users', page, q],
    queryFn: () => getUserList(page, q).then(r => r.data),
    staleTime: 30 * 1000,
    retry: false,
  })
}

export function useCreateUser() {
  const queryClient = useQueryClient()
  const { t } = useLang()
  return useMutation({
    mutationFn: (data) => createUser(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin'] })
      toast.success(t('admin.createSuccess'))
    },
    onError: (err) => {
      const msg = err.response?.data?.error?.message || t('admin.createFailed')
      toast.error(msg)
    },
  })
}

export function useUpdateUser() {
  const queryClient = useQueryClient()
  const { t } = useLang()
  return useMutation({
    mutationFn: ({ userId, data }) => updateUser(userId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin'] })
      toast.success(t('admin.updateSuccess'))
    },
    onError: (err) => {
      const msg = err.response?.data?.error?.message || t('admin.updateFailed')
      toast.error(msg)
    },
  })
}

export function useDeleteUser() {
  const queryClient = useQueryClient()
  const { t } = useLang()
  return useMutation({
    mutationFn: (userId) => deleteUser(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin'] })
      toast.success(t('admin.deleteSuccess'))
    },
    onError: (err) => {
      const msg = err.response?.data?.error?.message || t('admin.deleteFailed')
      toast.error(msg)
    },
  })
}
