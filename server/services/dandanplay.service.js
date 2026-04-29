/**
 * dandanplay.service.js
 * dandanplay API integration: anime matching, episode lookup, comment fetching.
 * Uses separate rate limiter from Bangumi to avoid queue contention.
 */

const AnimeCache = require('../models/AnimeCache');
const { createRateLimitedFetch } = require('../utils/rateLimitedFetch');
const { buildEpisodeMap } = require('../utils/episodeMap');

const BASE_URL = 'https://api.dandanplay.net';

const dandanFetch = createRateLimitedFetch(800, {
  'X-AppId': process.env.DANDANPLAY_APP_ID || '',
  'X-AppSecret': process.env.DANDANPLAY_APP_SECRET || '',
  'Content-Type': 'application/json',
});

// ─── Caches ──────────────────────────────────────────────────────────────────
const commentCache = new Map();  // episodeId -> { data, fetchedAt }
const episodeCache = new Map();  // key -> { episodes, fetchedAt }

const COMMENT_TTL = 30 * 60 * 1000;  // 30 min
const EPISODE_TTL = 24 * 60 * 60 * 1000; // 24h

function getCached(cache, key, ttl) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > ttl) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

// ─── Input sanitization ──────────────────────────────────────────────────────
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── AnimeCache search ───────────────────────────────────────────────────────
// Build a punctuation-tolerant regex: tokenize the keyword on letters/digits,
// require tokens in order separated by any non-word run. This way fansub
// filenames using `-` as the title/subtitle delimiter still match cache rows
// that store the same title with `:` or `~` (e.g.
// "Kaguya-sama wa Kokurasetai - Otona ..." vs "Kokurasetai: Otona ...").
function buildKeywordRegex(keyword) {
  const tokens = String(keyword).slice(0, 100).match(/[\p{L}\p{N}]+/gu);
  if (!tokens || !tokens.length) return null;
  const pattern = tokens.map(escapeRegex).join('[\\W_]*');
  return new RegExp(pattern, 'i');
}

async function searchAnimeCache(keyword) {
  if (!keyword) return [];
  const regex = buildKeywordRegex(keyword);
  if (!regex) return [];
  const results = await AnimeCache.find({
    $or: [
      { titleChinese: regex },
      { titleNative: regex },
      { titleRomaji: regex },
      { titleEnglish: regex },
    ],
  }).limit(10).lean();
  return results;
}

// ─── dandanplay API calls ────────────────────────────────────────────────────
async function fetchDandanEpisodes(bgmId) {
  const cacheKey = `bgm:${bgmId}`;
  const cached = getCached(episodeCache, cacheKey, EPISODE_TTL);
  if (cached) return cached;

  const res = await dandanFetch(`${BASE_URL}/api/v2/bangumi/bgmtv/${bgmId}`);
  if (!res.ok) return null;

  const data = await res.json();
  if (!data.bangumi) return null;

  const result = {
    dandanAnimeId: data.bangumi.animeId,
    title: data.bangumi.animeTitle,
    imageUrl: data.bangumi.imageUrl,
    episodes: (data.bangumi.episodes || []).map(ep => ({
      dandanEpisodeId: ep.episodeId,
      title: ep.episodeTitle,
      rawEpisodeNumber: ep.episodeNumber || '',
      number: parseEpField(ep.episodeNumber) ?? extractEpisodeNumber(ep.episodeTitle),
    })),
  };

  episodeCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
  return result;
}

async function fetchDandanEpisodesByAnimeId(animeId) {
  const cacheKey = `dan:${animeId}`;
  const cached = getCached(episodeCache, cacheKey, EPISODE_TTL);
  if (cached) return cached;

  const res = await dandanFetch(`${BASE_URL}/api/v2/bangumi/${animeId}`);
  if (!res.ok) return null;

  const data = await res.json();
  if (!data.bangumi) return null;

  const result = {
    dandanAnimeId: data.bangumi.animeId,
    title: data.bangumi.animeTitle,
    imageUrl: data.bangumi.imageUrl,
    episodes: (data.bangumi.episodes || []).map(ep => ({
      dandanEpisodeId: ep.episodeId,
      title: ep.episodeTitle,
      rawEpisodeNumber: ep.episodeNumber || '',
      number: parseEpField(ep.episodeNumber) ?? extractEpisodeNumber(ep.episodeTitle),
    })),
  };

  episodeCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
  return result;
}

function parseEpField(epNum) {
  if (!epNum) return null;
  // Only accept pure numeric episode numbers ("1", "02"), not "C1", "O2", "SP1"
  const n = /^\d+$/.test(epNum) ? parseInt(epNum, 10) : null;
  return n;
}

function extractEpisodeNumber(title) {
  if (!title) return null;
  const patterns = [
    /第(\d+)[話话集]/,          // 第1話, 第2话, 第3集
    /EP?\s*(\d+)/i,            // EP01, E01, Ep 01
    /S\d+E(\d+)/i,             // S01E03
    /\b(?:Episode|Ep\.?)\s*(\d+)/i, // Episode 1, Ep.1
    /^(\d+)$/,                 // just "1" or "01"
    /(\d+)$/,                  // trailing number
  ];
  for (const re of patterns) {
    const m = title.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

async function matchByFileName(fileName) {
  const res = await dandanFetch(`${BASE_URL}/api/v2/match`, {
    method: 'POST',
    body: JSON.stringify({
      fileName,
      fileHash: '',
      fileSize: 0,
      matchMode: 'fileNameOnly',
    }),
  });
  if (!res.ok) return null;

  const data = await res.json();
  if (!data.isMatched || !data.matches?.length) return null;

  const best = data.matches[0];
  return {
    animeId: best.animeId,
    animeTitle: best.animeTitle,
    episodeId: best.episodeId,
    episodeTitle: best.episodeTitle,
  };
}

async function matchByHash(fileName, fileHash, fileSize) {
  const res = await dandanFetch(`${BASE_URL}/api/v2/match`, {
    method: 'POST',
    body: JSON.stringify({
      fileName,
      fileHash,
      fileSize,
      matchMode: 'hashAndFileName',
    }),
  });
  if (!res.ok) return null;

  const data = await res.json();
  if (!data.isMatched || !data.matches?.length) return null;

  const best = data.matches[0];
  return {
    animeId: best.animeId,
    animeTitle: best.animeTitle,
    episodeId: best.episodeId,
    episodeTitle: best.episodeTitle,
  };
}

async function matchCombined(fileName, fileHash, fileSize) {
  const body = { fileName };
  if (fileHash) body.fileHash = fileHash;
  if (fileSize) body.fileSize = fileSize;

  const res = await dandanFetch(`${BASE_URL}/api/v2/match`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;

  const data = await res.json();
  if (!data.matches?.length) return null;

  const best = data.matches[0];
  return {
    isMatched: !!data.isMatched,
    animeId: best.animeId,
    animeTitle: best.animeTitle,
    episodeId: best.episodeId,
    episodeTitle: best.episodeTitle,
  };
}

async function searchDandanAnime(keyword) {
  if (!keyword) return [];
  const res = await dandanFetch(
    `${BASE_URL}/api/v2/search/anime?keyword=${encodeURIComponent(keyword.slice(0, 100))}`
  );
  if (!res.ok) return [];

  const data = await res.json();
  return (data.animes || []).map(a => ({
    dandanAnimeId: a.animeId,
    title: a.animeTitle,
    type: a.type,
    imageUrl: a.imageUrl,
    episodes: a.episodeCount,
  }));
}

async function fetchComments(episodeId) {
  const cached = getCached(commentCache, episodeId, COMMENT_TTL);
  if (cached) return cached;

  const res = await dandanFetch(
    `${BASE_URL}/api/v2/comment/${episodeId}?withRelated=true&chConvert=1`
  );
  if (!res.ok) return { count: 0, comments: [] };

  const data = await res.json();
  const result = { count: data.count || 0, comments: data.comments || [] };

  commentCache.set(episodeId, { data: result, fetchedAt: Date.now() });
  return result;
}

module.exports = {
  searchAnimeCache,
  fetchDandanEpisodes,
  fetchDandanEpisodesByAnimeId,
  matchByFileName,
  matchByHash,
  matchCombined,
  searchDandanAnime,
  fetchComments,
  buildEpisodeMap,
};
