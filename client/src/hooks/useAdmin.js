import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { getAdminStats, getEnrichmentList, updateEnrichment, resetEnrichment, flagEnrichment, reEnrich, healCnTitles, pauseHeal, resumeHeal, getUserList, createUser, updateUser, deleteUser } from '../api/admin.api'
import { useLang } from '../context/LanguageContext'

export function useAdminStats() {
  return useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: () => getAdminStats().then(r => r.data.data),
    staleTime: 10 * 1000,
    refetchInterval: (query) => {
      const stats = query?.state?.data
      const q = stats?.queue
      if (!q) return false
      const prog = q.v3Progress
      if (prog && prog.total > 0 && prog.processed < prog.total && !prog.paused) return 2000
      if (q.phase1 + q.phase4 + q.v3 > 0) return 5000
      return false
    },
    retry: false,
  })
}

export function useEnrichmentList(page, filter, q, sort, order) {
  return useQuery({
    queryKey: ['admin', 'enrichment', page, filter, q, sort, order],
    queryFn: () => getEnrichmentList(page, filter, q, sort, order).then(r => r.data),
    staleTime: 30 * 1000,
    retry: false,
  })
}

export function useUpdateEnrichment() {
  const queryClient = useQueryClient()
  const { t } = useLang()
  return useMutation({
    mutationFn: ({ anilistId, data }) => updateEnrichment(anilistId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin'] })
      toast.success(t('admin.enrichUpdateSuccess'))
    },
    onError: (err) => {
      const msg = err.response?.data?.error?.message || t('admin.enrichUpdateFailed')
      toast.error(msg)
    },
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

export function useReEnrich() {
  const queryClient = useQueryClient()
  const { t } = useLang()
  return useMutation({
    mutationFn: (version) => reEnrich(version),
    onSuccess: (res) => {
      const { enqueued, version } = res.data?.data ?? {}
      queryClient.invalidateQueries({ queryKey: ['admin'] })
      toast.success(`v${version} re-enrich: ${enqueued} enqueued`)
    },
    onError: (err) => {
      toast.error(err.response?.data?.error?.message || t('admin.healFailed'))
    },
  })
}

export function useHealCnTitles() {
  const queryClient = useQueryClient()
  const { t } = useLang()
  return useMutation({
    mutationFn: () => healCnTitles(),
    onSuccess: (res) => {
      const count = res.data?.data?.enqueued ?? 0
      queryClient.invalidateQueries({ queryKey: ['admin'] })
      toast.success(`${t('admin.healSuccess')} (${count})`)
    },
    onError: () => toast.error(t('admin.healFailed')),
  })
}

export function usePauseHeal() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => pauseHeal(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] }),
  })
}

export function useResumeHeal() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => resumeHeal(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] }),
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
