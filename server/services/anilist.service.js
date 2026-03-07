const AnimeCache = require('../models/AnimeCache');
const { SEASONAL_ANIME_QUERY } = require('../queries/seasonalAnime.graphql');
const { SEARCH_ANIME_QUERY }   = require('../queries/searchAnime.graphql');
const { ANIME_DETAIL_QUERY }   = require('../queries/animeDetail.graphql');

const ANILIST_URL = 'https://graphql.anilist.co';
const CACHE_TTL_MS = (parseInt(process.env.CACHE_TTL_HOURS) || 24) * 60 * 60 * 1000;

// Send a GraphQL request to AniList
async function queryAniList(query, variables) {
  const res = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw Object.assign(new Error(`AniList API error: ${res.status}`), { status: 502 });
  const { data, errors } = await res.json();
  if (errors) throw Object.assign(new Error(errors[0].message), { status: 502 });
  return data;
}

// Normalize AniList media object → our schema shape
function normalize(m) {
  return {
    anilistId:      m.id,
    titleRomaji:    m.title?.romaji,
    titleEnglish:   m.title?.english,
    titleNative:    m.title?.native,
    coverImageUrl:  m.coverImage?.extraLarge || m.coverImage?.large,
    bannerImageUrl: m.bannerImage,
    description:    m.description,
    episodes:       m.episodes,
    status:         m.status,
    season:         m.season,
    seasonYear:     m.seasonYear,
    averageScore:   m.averageScore,
    genres:         m.genres || [],
    format:         m.format,
    cachedAt:       new Date()
  };
}

// Upsert a list of anime into MongoDB cache
async function upsertCache(animeList) {
  await Promise.all(animeList.map(a =>
    AnimeCache.findOneAndUpdate(
      { anilistId: a.anilistId },
      a,
      { upsert: true, new: true }
    )
  ));
}

// Get seasonal anime (always fresh from AniList, then cache)
async function getSeasonalAnime(season, year, page = 1, perPage = 20) {
  const data = await queryAniList(SEASONAL_ANIME_QUERY, {
    season, seasonYear: parseInt(year), page: parseInt(page), perPage: parseInt(perPage)
  });
  const animeList = data.Page.media.map(normalize);
  await upsertCache(animeList);
  return { pageInfo: data.Page.pageInfo, anime: animeList };
}

// Search anime
async function searchAnime(search, genre, page = 1, perPage = 20) {
  const data = await queryAniList(SEARCH_ANIME_QUERY, {
    search: search || undefined,
    genre:  genre  || undefined,
    page: parseInt(page), perPage: parseInt(perPage)
  });
  const animeList = data.Page.media.map(normalize);
  await upsertCache(animeList);
  return { pageInfo: data.Page.pageInfo, anime: animeList };
}

// Get single anime detail — uses cache if fresh, else re-fetches
async function getAnimeDetail(anilistId) {
  const cached = await AnimeCache.findOne({ anilistId: parseInt(anilistId) });
  if (cached && Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
    return cached;
  }
  const data = await queryAniList(ANIME_DETAIL_QUERY, { id: parseInt(anilistId) });
  const anime = normalize(data.Media);
  await upsertCache([anime]);
  return anime;
}

module.exports = { getSeasonalAnime, searchAnime, getAnimeDetail, upsertCache, normalize };
