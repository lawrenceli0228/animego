const AnimeCache = require('../models/AnimeCache');
const { SEASONAL_ANIME_QUERY } = require('../queries/seasonalAnime.graphql');
const { SEARCH_ANIME_QUERY }   = require('../queries/searchAnime.graphql');
const { ANIME_DETAIL_QUERY }   = require('../queries/animeDetail.graphql');

const ANILIST_URL    = 'https://graphql.anilist.co';
const CACHE_TTL_MS   = (parseInt(process.env.CACHE_TTL_HOURS) || 24) * 60 * 60 * 1000;
const SEARCH_TTL_MS  = 10 * 60 * 1000; // 10 min in-memory cache for search
const MIN_INTERVAL   = 700;            // ms between AniList requests ≈ 85 req/min

// ─── Rate-limit outgoing AniList requests ────────────────────────────────────
let lastRequestTime = 0;

async function queryAniList(query, variables) {
  const wait = MIN_INTERVAL - (Date.now() - lastRequestTime);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestTime = Date.now();

  const res = await fetch(ANILIST_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body:    JSON.stringify({ query, variables })
  });

  if (!res.ok) {
    const status = res.status === 429 ? 429 : 502;
    throw Object.assign(
      new Error(res.status === 429 ? 'AniList 请求过于频繁，请稍后再试' : `AniList API error: ${res.status}`),
      { status }
    );
  }

  const { data, errors } = await res.json();
  if (errors) throw Object.assign(new Error(errors[0].message), { status: 502 });
  return data;
}

// ─── Normalize AniList media → our schema ────────────────────────────────────
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

// ─── Upsert a list of anime into MongoDB ─────────────────────────────────────
async function upsertCache(animeList) {
  await Promise.all(animeList.map(a =>
    AnimeCache.findOneAndUpdate(
      { anilistId: a.anilistId },
      a,
      { upsert: true, new: true }
    )
  ));
}

// ─── Seasonal anime — cache-first ────────────────────────────────────────────
async function getSeasonalAnime(season, year, page = 1, perPage = 20) {
  const pageNum    = parseInt(page);
  const perPageNum = parseInt(perPage);
  const yearNum    = parseInt(year);
  const freshSince = new Date(Date.now() - CACHE_TTL_MS);

  // Count fresh cached entries for this season/year
  const totalCached = await AnimeCache.countDocuments({
    season,
    seasonYear: yearNum,
    cachedAt: { $gt: freshSince }
  });

  if (totalCached >= perPageNum) {
    const skip   = (pageNum - 1) * perPageNum;
    const cached = await AnimeCache.find({
      season,
      seasonYear: yearNum,
      cachedAt: { $gt: freshSince }
    })
      .sort({ averageScore: -1 })
      .skip(skip)
      .limit(perPageNum)
      .lean();

    return {
      pageInfo: {
        total:       totalCached,
        currentPage: pageNum,
        lastPage:    Math.ceil(totalCached / perPageNum),
        hasNextPage: skip + perPageNum < totalCached,
        perPage:     perPageNum
      },
      anime: cached
    };
  }

  // Cache miss → fetch from AniList
  const data      = await queryAniList(SEASONAL_ANIME_QUERY, { season, seasonYear: yearNum, page: pageNum, perPage: perPageNum });
  const animeList = data.Page.media.map(normalize);
  await upsertCache(animeList);
  return { pageInfo: data.Page.pageInfo, anime: animeList };
}

// ─── Search anime — in-memory cache ──────────────────────────────────────────
const searchCache = new Map();

async function searchAnime(search, genre, page = 1, perPage = 20) {
  const key    = `${search || ''}|${genre || ''}|${page}|${perPage}`;
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.time < SEARCH_TTL_MS) {
    return cached.data;
  }

  const data      = await queryAniList(SEARCH_ANIME_QUERY, {
    search: search || undefined,
    genre:  genre  || undefined,
    page:   parseInt(page),
    perPage: parseInt(perPage)
  });
  const animeList = data.Page.media.map(normalize);
  await upsertCache(animeList);
  const result = { pageInfo: data.Page.pageInfo, anime: animeList };
  searchCache.set(key, { data: result, time: Date.now() });
  return result;
}

// ─── Single anime detail — cache-first ───────────────────────────────────────
async function getAnimeDetail(anilistId) {
  const cached = await AnimeCache.findOne({ anilistId: parseInt(anilistId) });
  if (cached && Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
    return cached;
  }
  const data  = await queryAniList(ANIME_DETAIL_QUERY, { id: parseInt(anilistId) });
  const anime = normalize(data.Media);
  await upsertCache([anime]);
  return anime;
}

module.exports = { getSeasonalAnime, searchAnime, getAnimeDetail, upsertCache, normalize };
