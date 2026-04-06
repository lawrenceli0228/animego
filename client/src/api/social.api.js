import api from './axiosClient'

export const getUserProfile = (username) =>
  api.get(`/users/${username}`)

export const followUser = (username) =>
  api.post(`/users/${username}/follow`)

export const unfollowUser = (username) =>
  api.delete(`/users/${username}/follow`)

export const getFollowers = (username, page = 1) =>
  api.get(`/users/${username}/followers`, { params: { page } })

export const getFollowing = (username, page = 1) =>
  api.get(`/users/${username}/following`, { params: { page } })

export const getFeed = (page = 1) =>
  api.get('/feed', { params: { page } })
