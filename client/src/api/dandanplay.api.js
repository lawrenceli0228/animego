import api from './axiosClient';

const PROXY_BASE = import.meta.env.VITE_DANDANPLAY_PROXY_URL;

function base(path) {
  return PROXY_BASE ? `${PROXY_BASE}${path}` : `/dandanplay${path}`;
}

export function matchAnime(body) {
  return api.post(base('/match'), body).then(r => r.data);
}

export function searchAnime(keyword) {
  return api.get(base('/search'), { params: { keyword } }).then(r => r.data);
}

export function getComments(episodeId) {
  return api.get(base(`/comments/${episodeId}`)).then(r => r.data);
}

export function getEpisodes(animeId, bgmId) {
  const params = bgmId ? { bgmId } : {};
  return api.get(base(`/episodes/${animeId || 0}`), { params }).then(r => r.data);
}
