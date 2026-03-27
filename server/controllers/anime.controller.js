const anilistService = require('../services/anilist.service');
const { XMLParser } = require('fast-xml-parser');
const Subscription = require('../models/Subscription');
const AnimeCache   = require('../models/AnimeCache');

// In-memory torrent cache (1-hour TTL)
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

// Helper: format bytes from RSS enclosure length
function formatBytes(bytes) {
  const n = parseInt(bytes);
  if (!n || n <= 0) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

// Extract fansub name from title brackets e.g. "[SubsPlease]", "[喵萌奶茶屋]", "【云光字幕组】"
function parseFansub(title) {
  const match = title.match(/^[\[【]([^\]】]+)[\]】]/);
  return match ? match[1] : null;
}

async function fetchAcgRip(term) {
  const url = new URL('https://acg.rip/.xml');
  url.searchParams.set('term', term);
  const resp = await fetch(url.toString(), {
    headers: { 'User-Agent': 'AnimeGo/1.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) return [];
  const xml = await resp.text();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const raw = parser.parse(xml)?.rss?.channel?.item ?? [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items
    .map(item => ({
      title:  item.title ?? '',
      magnet: item.enclosure?.['@_url'] ?? item.link ?? '',
      size:   formatBytes(item.enclosure?.['@_length']),
      fansub: parseFansub(item.title ?? ''),
      date:   item.pubDate ?? null,
      source: 'acg',
    }))
    .filter(i => i.title && i.magnet);
}

async function fetchDmhy(term) {
  // dmhy doesn't recognise "Title - 01" pattern; strip separator so "Title 01" matches
  const dmhyTerm = term.replace(/\s*-\s*(\d+)$/, ' $1').trim();
  const url = new URL('https://share.dmhy.org/topics/rss/rss.xml');
  url.searchParams.set('keyword', dmhyTerm);
  url.searchParams.set('sort_id', '2'); // anime category
  url.searchParams.set('order', 'date-desc');
  const resp = await fetch(url.toString(), {
    headers: { 'User-Agent': 'AnimeGo/1.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) return [];
  const xml = await resp.text();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const raw = parser.parse(xml)?.rss?.channel?.item ?? [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items
    .map(item => {
      const title  = item.title ?? '';
      // dmhy enclosure url has HTML entities — decode &amp; → &
      const rawUrl = item.enclosure?.['@_url'] ?? '';
      const magnet = rawUrl.replace(/&amp;/g, '&');
      return {
        title,
        magnet,
        size:   '',  // dmhy enclosure length is always "1"
        fansub: parseFansub(title),
        date:   item.pubDate ?? null,
        source: 'dmhy',
      };
    })
    .filter(i => i.title && i.magnet && i.magnet.startsWith('magnet:'));
}

async function fetchNyaa(term) {
  const url = new URL('https://nyaa.si/');
  url.searchParams.set('page', 'rss');
  url.searchParams.set('q', term);
  url.searchParams.set('c', '1_0'); // all anime
  url.searchParams.set('f', '0');   // no filter
  const resp = await fetch(url.toString(), {
    headers: { 'User-Agent': 'AnimeGo/1.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) return [];
  const xml = await resp.text();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const raw = parser.parse(xml)?.rss?.channel?.item ?? [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items
    .map(item => {
      const hash  = String(item['nyaa:infoHash'] ?? '').trim();
      const title = item.title ?? '';
      const magnet = hash
        ? `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=http%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`
        : (item.link ?? '');
      return {
        title,
        magnet,
        size:   String(item['nyaa:size'] ?? ''),
        fansub: parseFansub(title),
        date:   item.pubDate ?? null,
        source: 'nyaa',
      };
    })
    .filter(i => i.title && i.magnet);
}

// GET /api/anime/torrents?q=<search query>
// Data sources: 动漫花园 + ACG.RIP + Nyaa.si (parallel, graceful on failure)
exports.getTorrents = async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Missing query' } });

    const key = q.trim().toLowerCase();
    const cached = torrentCache.get(key);
    if (cached && Date.now() - cached.ts < 60 * 60 * 1000) {
      return res.json({ data: cached.data });
    }

    const [dmhyResult, acgResult, nyaaResult] = await Promise.allSettled([
      fetchDmhy(q.trim()),
      fetchAcgRip(q.trim()),
      fetchNyaa(q.trim()),
    ]);

    const data = [
      ...(dmhyResult.status  === 'fulfilled' ? dmhyResult.value  : []),
      ...(acgResult.status   === 'fulfilled' ? acgResult.value   : []),
      ...(nyaaResult.status  === 'fulfilled' ? nyaaResult.value  : []),
    ];

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
