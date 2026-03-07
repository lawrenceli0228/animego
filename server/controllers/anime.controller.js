const anilistService = require('../services/anilist.service');

// GET /api/anime/seasonal?season=WINTER&year=2025&page=1&perPage=20
exports.getSeasonal = async (req, res, next) => {
  try {
    const { season = 'WINTER', year = new Date().getFullYear(), page = 1, perPage = 20 } = req.query;
    const result = await anilistService.getSeasonalAnime(season, year, page, Math.min(perPage, 50));
    res.json({
      data: result.anime,
      pagination: {
        page: result.pageInfo.currentPage,
        perPage: result.pageInfo.perPage,
        total: result.pageInfo.total,
        totalPages: result.pageInfo.lastPage
      }
    });
  } catch (err) { next(err); }
};

// GET /api/anime/search?q=naruto&genre=Action&page=1&perPage=20
exports.search = async (req, res, next) => {
  try {
    const { q, genre, page = 1, perPage = 20 } = req.query;
    if (!q && !genre) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '请提供搜索关键词或类型' } });
    }
    const result = await anilistService.searchAnime(q, genre, page, Math.min(perPage, 50));
    res.json({
      data: result.anime,
      pagination: {
        page: result.pageInfo.currentPage,
        perPage: result.pageInfo.perPage,
        total: result.pageInfo.total,
        totalPages: result.pageInfo.lastPage
      }
    });
  } catch (err) { next(err); }
};

// GET /api/anime/schedule
exports.getSchedule = async (req, res, next) => {
  try {
    const schedule = await anilistService.getWeeklySchedule();
    res.json({ data: schedule });
  } catch (err) { next(err); }
};

// GET /api/anime/:anilistId
exports.getDetail = async (req, res, next) => {
  try {
    const { anilistId } = req.params;
    if (isNaN(anilistId)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '无效的番剧 ID' } });
    }
    const anime = await anilistService.getAnimeDetail(anilistId);
    res.json({ data: anime });
  } catch (err) { next(err); }
};
