const dandanplay = require('../services/dandanplay.service');
const bangumi = require('../services/bangumi.service');
const AnimeCache = require('../models/AnimeCache');

const BGM_FALLBACK_TIMEOUT_MS = 2000;

/**
 * Find the best-matching AnimeCache doc for Phase 1 enrichment.
 * Falls through 3 levels: dandanplay title → user keyword → bangumi.tv bgmId lookup.
 * Returns null if all miss; never throws.
 */
async function findSiteAnime(title, userKeyword) {
  if (title) {
    const byTitle = await dandanplay.searchAnimeCache(title);
    if (byTitle[0]) return byTitle[0];
  }
  if (userKeyword && userKeyword !== title) {
    const byKeyword = await dandanplay.searchAnimeCache(userKeyword);
    if (byKeyword[0]) return byKeyword[0];
  }
  // Last resort: resolve bgmId via bangumi.tv, then look up AnimeCache by bgmId.
  // Guarded by timeout so a slow bgm.tv never blocks /match.
  const bgm = await Promise.race([
    bangumi.fetchBangumiData(title, userKeyword).catch(() => null),
    new Promise(resolve => setTimeout(() => resolve(null), BGM_FALLBACK_TIMEOUT_MS)),
  ]);
  if (bgm?.bgmId) {
    return AnimeCache.findOne({ bgmId: bgm.bgmId }).lean();
  }
  return null;
}

/** Pick fields from an AnimeCache document for the siteAnime response */
function pickSiteAnime(doc) {
  if (!doc) return null;
  return {
    anilistId: doc.anilistId,
    titleChinese: doc.titleChinese,
    titleNative: doc.titleNative,
    titleRomaji: doc.titleRomaji,
    coverImageUrl: doc.coverImageUrl,
    episodes: doc.episodes,
    status: doc.status,
    season: doc.season,
    seasonYear: doc.seasonYear,
    averageScore: doc.averageScore,
    bangumiScore: doc.bangumiScore,
    bangumiVotes: doc.bangumiVotes,
    genres: doc.genres,
    format: doc.format,
    bgmId: doc.bgmId,
    studios: doc.studios,
    source: doc.source,
    duration: doc.duration,
  };
}

async function match(req, res, next) {
  try {
    const { keyword, episodes = [], fileName, fileHash, fileSize, files = [] } = req.body;

    // Phase 1: dandanplay combined match (hash + fileName, no matchMode — let API decide)
    if (fileName) {
      const combined = await dandanplay.matchCombined(fileName, fileHash, fileSize);
      if (combined?.isMatched) {
        const epData = await dandanplay.fetchDandanEpisodesByAnimeId(combined.animeId);
        if (epData) {
          const episodeMap = dandanplay.buildEpisodeMap(epData.episodes, episodes);
          await matchUnmappedFiles(episodeMap, episodes, files);
          if (Object.keys(episodeMap).length > 0) {
            const siteHit = await findSiteAnime(epData.title, keyword);
            return res.json({
              matched: true,
              anime: { titleNative: epData.title, coverImageUrl: epData.imageUrl },
              siteAnime: pickSiteAnime(siteHit),
              episodeMap,
              source: 'dandanplay',
            });
          }
        }
      }
    }

    // Phase 2: AnimeCache search by keyword
    if (keyword) {
      const cacheResults = await dandanplay.searchAnimeCache(keyword);
      for (const anime of cacheResults) {
        if (!anime.bgmId) continue;
        const epData = await dandanplay.fetchDandanEpisodes(anime.bgmId);
        if (epData) {
          const episodeMap = dandanplay.buildEpisodeMap(epData.episodes, episodes);
          await matchUnmappedFiles(episodeMap, episodes, files);
          if (Object.keys(episodeMap).length > 0) {
            return res.json({
              matched: true,
              anime: {
                anilistId: anime.anilistId,
                titleChinese: anime.titleChinese,
                titleNative: anime.titleNative,
                titleRomaji: anime.titleRomaji,
                coverImageUrl: anime.coverImageUrl,
                episodes: anime.episodes,
              },
              siteAnime: pickSiteAnime(anime),
              episodeMap,
              source: 'animeCache',
            });
          }
        }
      }
    }

    // Phase 3: no anime matched — try per-file hash matching directly
    if (files.length > 0) {
      const episodeMap = {};
      await matchUnmappedFiles(episodeMap, episodes, files);
      if (Object.keys(episodeMap).length > 0) {
        return res.json({
          matched: true,
          anime: {},
          episodeMap,
          source: 'dandanplay',
        });
      }
    }

    // All phases failed
    return res.json({ matched: false });
  } catch (err) {
    next(err);
  }
}

/** Per-file matching for episodes missing from the episode map (hash + fileName) */
async function matchUnmappedFiles(episodeMap, episodes, files) {
  const unmapped = episodes.filter(ep => !episodeMap[ep]);
  const usedIds = new Set(Object.values(episodeMap).map(e => e.dandanEpisodeId));
  for (const ep of unmapped) {
    const fileInfo = files.find(f => f.episode === ep);
    if (!fileInfo?.fileName) continue;
    const result = await dandanplay.matchCombined(fileInfo.fileName, fileInfo.fileHash, fileInfo.fileSize);
    if (result?.isMatched && !usedIds.has(result.episodeId)) {
      episodeMap[ep] = { dandanEpisodeId: result.episodeId, title: result.episodeTitle };
      usedIds.add(result.episodeId);
    }
  }
}

async function search(req, res, next) {
  try {
    const keyword = (req.query.keyword || '').slice(0, 100);
    if (!keyword) return res.json({ results: [] });

    const [cacheResults, dandanResults] = await Promise.all([
      dandanplay.searchAnimeCache(keyword),
      dandanplay.searchDandanAnime(keyword),
    ]);

    const results = [
      ...cacheResults.map(a => ({
        source: 'animeCache',
        anilistId: a.anilistId,
        title: a.titleNative || a.titleRomaji,
        titleChinese: a.titleChinese,
        titleNative: a.titleNative,
        titleRomaji: a.titleRomaji,
        coverImageUrl: a.coverImageUrl,
        episodes: a.episodes,
        bgmId: a.bgmId,
        season: a.season,
        seasonYear: a.seasonYear,
        format: a.format,
        averageScore: a.averageScore,
        bangumiScore: a.bangumiScore,
        bangumiVotes: a.bangumiVotes,
        genres: a.genres,
        studios: a.studios,
        animeSource: a.source,
        duration: a.duration,
        status: a.status,
      })),
      ...dandanResults.map(a => ({
        source: 'dandanplay',
        dandanAnimeId: a.dandanAnimeId,
        title: a.title,
        episodes: a.episodes,
        imageUrl: a.imageUrl,
        type: a.type,
      })),
    ];

    res.json({ results });
  } catch (err) {
    next(err);
  }
}

async function getComments(req, res, next) {
  try {
    const { episodeId } = req.params;
    if (!episodeId || isNaN(Number(episodeId))) {
      return res.status(400).json({ error: 'Invalid episodeId' });
    }
    const data = await dandanplay.fetchComments(Number(episodeId));
    res.json(data);
  } catch (err) {
    next(err);
  }
}

async function getEpisodes(req, res, next) {
  try {
    const { animeId } = req.params;
    const { bgmId } = req.query;

    let epData;
    if (bgmId) {
      epData = await dandanplay.fetchDandanEpisodes(Number(bgmId));
    } else if (animeId) {
      epData = await dandanplay.fetchDandanEpisodesByAnimeId(Number(animeId));
    }

    if (!epData) return res.status(404).json({ error: 'Anime not found on dandanplay' });
    res.json(epData);
  } catch (err) {
    next(err);
  }
}

module.exports = { match, search, getComments, getEpisodes };
