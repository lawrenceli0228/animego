import api from './axiosClient';

export const getDanmaku = (anilistId, episode) =>
  api.get(`/danmaku/${anilistId}/${episode}`);
