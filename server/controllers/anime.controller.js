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

// Helper: format size — Anime Garden returns size in kilobytes
function formatBytes(kb) {
  if (!kb) return '';
  if (kb >= 1024 * 1024) return `${(kb / (1024 * 1024)).toFixed(1)} GB`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${kb.toFixed(0)} KB`;
}

// GET /api/anime/torrents?q=<search query>
// Data source: Anime Garden API (aggregates Nyaa.si + ACG.rip, pre-parses fansub field)
exports.getTorrents = async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Missing query' } });

    // Use 'search' param for full-text search across title
    const url = new URL('https://api.animes.garden/resources');
    url.searchParams.set('page', '1');
    url.searchParams.set('pageSize', '75');
    url.searchParams.set('search', q.trim());

    let resp;
    try {
      resp = await fetch(url.toString(), {
        headers: { 'User-Agent': 'AnimeGo/1.0 (https://github.com/animego)' },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      return res.json({ data: [] });
    }
    if (!resp.ok) return res.json({ data: [] });

    const json = await resp.json();
    const data = (json.resources ?? []).map(r => ({
      title:  r.title  ?? '',
      magnet: r.magnet ?? '',
      size:   formatBytes(r.size),
      fansub: r.fansub?.name ?? null,
      date:   r.createdAt ?? null,
    }));

    res.json({ data });
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
