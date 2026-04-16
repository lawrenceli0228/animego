import api from './axiosClient'

export const getAdminStats = () =>
  api.get('/admin/stats')

export const getEnrichmentList = (page = 1, filter = '', q = '', sort = '', order = '') =>
  api.get('/admin/enrichment', { params: { page, filter: filter || undefined, q: q || undefined, sort: sort || undefined, order: order || undefined } })

export const updateEnrichment = (anilistId, data) =>
  api.patch(`/admin/enrichment/${anilistId}`, data)

export const resetEnrichment = (anilistId) =>
  api.post(`/admin/enrichment/${anilistId}/reset`)

export const flagEnrichment = (anilistId, flag) =>
  api.post(`/admin/enrichment/${anilistId}/flag`, { flag })

export const reEnrich = (version) =>
  api.post('/admin/enrichment/re-enrich', null, { params: { version } })

export const healCnTitles = () =>
  api.post('/admin/enrichment/heal-cn')

export const pauseHeal = () =>
  api.post('/admin/enrichment/heal-cn/pause')

export const resumeHeal = () =>
  api.post('/admin/enrichment/heal-cn/resume')

export const getUserList = (page = 1, q = '') =>
  api.get('/admin/users', { params: { page, q: q || undefined } })

export const createUser = (data) =>
  api.post('/admin/users', data)

export const updateUser = (userId, data) =>
  api.patch(`/admin/users/${userId}`, data)

export const deleteUser = (userId) =>
  api.delete(`/admin/users/${userId}`)
