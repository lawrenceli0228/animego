import api from './axiosClient'

export const getAdminStats = () =>
  api.get('/admin/stats')

export const getEnrichmentList = (page = 1, filter = '', q = '') =>
  api.get('/admin/enrichment', { params: { page, filter: filter || undefined, q: q || undefined } })

export const resetEnrichment = (anilistId) =>
  api.post(`/admin/enrichment/${anilistId}/reset`)

export const flagEnrichment = (anilistId, flag) =>
  api.post(`/admin/enrichment/${anilistId}/flag`, { flag })

export const getUserList = (page = 1, q = '') =>
  api.get('/admin/users', { params: { page, q: q || undefined } })

export const createUser = (data) =>
  api.post('/admin/users', data)

export const updateUser = (userId, data) =>
  api.patch(`/admin/users/${userId}`, data)

export const deleteUser = (userId) =>
  api.delete(`/admin/users/${userId}`)
