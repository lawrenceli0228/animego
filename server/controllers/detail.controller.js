const anilistService = require('../services/anilist.service');
const AnimeCache     = require('../models/AnimeCache');

// GET /api/anime/:anilistId
exports.getDetail = async (req, res, next) => {
  try {
    const { anilistId } = req.params;
    if (isNaN(anilistId)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '无效的番剧 ID' } });
    }
    const anime = await anilistService.getAnimeDetail(anilistId);

    // Enrich relations with titleChinese + coverImageUrl from cache
    if (anime.relations?.length) {
      const relIds = anime.relations.map(r => r.anilistId);
      const cached = await AnimeCache.find(
        { anilistId: { $in: relIds } },
        { anilistId: 1, titleChinese: 1, coverImageUrl: 1 }
      ).lean();
      const relMap = new Map(cached.map(c => [c.anilistId, c]));
      anime.relations = anime.relations.map(r => {
        const c = relMap.get(r.anilistId);
        return {
          ...r,
          titleChinese: c?.titleChinese ?? r.titleChinese ?? null,
          coverImageUrl: r.coverImageUrl || c?.coverImageUrl || null,
        };
      });
    }

    res.json({ data: anime });
  } catch (err) { next(err); }
};
