import api from './axiosClient';

export const getSeasonalAnime = (season, year, page = 1, perPage = 20) =>
  api.get('/anime/seasonal', { params: { season, year, page, perPage } });

export const searchAnime = (q, genre, page = 1, perPage = 20) =>
  api.get('/anime/search', { params: { q, genre, page, perPage } });

export const getAnimeDetail = (anilistId) =>
  api.get(`/anime/${anilistId}`);

export const getWeeklySchedule = () =>
  api.get('/anime/schedule');

export const getTorrents = (q) =>
  api.get('/anime/torrents', { params: { q } });
