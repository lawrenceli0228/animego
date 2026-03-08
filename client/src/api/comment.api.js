import api from './axiosClient';

export const getComments = (anilistId, episode) =>
  api.get(`/comments/${anilistId}/${episode}`);

export const addComment = (anilistId, episode, content) =>
  api.post(`/comments/${anilistId}/${episode}`, { content });

export const deleteComment = (id) =>
  api.delete(`/comments/${id}`);
