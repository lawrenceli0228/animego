const anilistService = require('../services/anilist.service');
const { XMLParser } = require('fast-xml-parser');
const Subscription = require('../models/Subscription');
const AnimeCache   = require('../models/AnimeCache');

// In-memory torrent cache (5-min TTL)
const torrentCache = new Map();

// In-memory trending cache (1h TTL)
const trendingCache = { data: null, ts: 0 };

// GET /api/anime/trending?limit=10&refresh=true
exports.getTrending = async (req, res, next) => {
  try {
    const { limit = 10, refresh } = req.query;
    const limitNum = Math.min(Number(limit) || 10, 20);

    if (!refresh && trendingCache.data && Date.now() - trendingCache.ts < 60 * 60 * 1000) {
      return res.json({ data: trendingCache.data.slice(0, limitNum) });
    }

    const agg = await Subscription.aggregate([
      { $group: { _id: '$anilistId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 }
    ]);

    const anilistIds = agg.map(r => r._id);
    const animes = await AnimeCache.find({ anilistId: { $in: anilistIds } });
    const animeMap = Object.fromEntries(animes.map(a => [a.anilistId, a]));

    const data = agg
      .filter(r => animeMap[r._id])
      .map((r, i) => ({
        rank: i + 1,
        watcherCount: r.count,
        ...animeMap[r._id].toObject()
      }));

    trendingCache.data = data;
    trendingCache.ts = Date.now();

    res.json({ data: data.slice(0, limitNum) });
  } catch (err) { next(err); }
};

// GET /api/anime/:anilistId/watchers?limit=5
exports.getWatchers = async (req, res, next) => {
  try {
    const { anilistId } = req.params;
    if (isNaN(anilistId)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '无效的番剧 ID' } });
    }
    const limitNum = Math.min(Number(req.query.limit) || 5, 20);
    const id = Number(anilistId);

    const [subs, total] = await Promise.all([
      Subscription.find({ anilistId: id, status: 'watching' })
        .populate('userId', 'username')
        .limit(limitNum),
      Subscription.countDocuments({ anilistId: id, status: 'watching' })
    ]);

    const data = subs
      .filter(s => s.userId != null)
      .map(s => ({ username: s.userId.username }));

    res.json({ data, total });
  } catch (err) { next(err); }
};

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
// Data source: ACG.RIP RSS feed
exports.getTorrents = async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Missing query' } });

    const key = q.trim().toLowerCase();
    const cached = torrentCache.get(key);
    if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
      return res.json({ data: cached.data });
    }

    const url = new URL('https://acg.rip/.xml');
    url.searchParams.set('term', q.trim());

    let resp;
    try {
      resp = await fetch(url.toString(), {
        headers: { 'User-Agent': 'AnimeGo/1.0' },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      return res.json({ data: [] });
    }
    if (!resp.ok) return res.json({ data: [] });

    const xml = await resp.text();
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const parsed = parser.parse(xml);
    const items = parsed?.rss?.channel?.item ?? [];
    const list = Array.isArray(items) ? items : [items];

    // Extract fansub name from title brackets e.g. "[SubsPlease]" or "[喵萌奶茶屋]"
    const parseFansub = (title) => {
      const match = title.match(/^\[([^\]]+)\]/);
      return match ? match[1] : null;
    };

    const data = list.map(item => ({
      title:  item.title ?? '',
      magnet: item.enclosure?.['@_url'] ?? item.link ?? '',
      size:   '',
      fansub: parseFansub(item.title ?? ''),
      date:   item.pubDate ?? null,
    }));

    torrentCache.set(key, { data, ts: Date.now() });
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
