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

export const getTrending = (limit = 10) =>
  api.get('/anime/trending', { params: { limit } });

export const getWatchers = (anilistId, limit = 5) =>
  api.get(`/anime/${anilistId}/watchers`, { params: { limit } });

export const getYearlyTop = (year, limit = 10) =>
  api.get('/anime/yearly-top', { params: { year, limit } });

export const getCompletedGems = (limit = 6) =>
  api.get('/anime/completed-gems', { params: { limit } });
