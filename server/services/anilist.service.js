const AnimeCache = require('../models/AnimeCache');
const { SEASONAL_ANIME_QUERY }  = require('../queries/seasonalAnime.graphql');
const { SEARCH_ANIME_QUERY }    = require('../queries/searchAnime.graphql');
const { ANIME_DETAIL_QUERY }    = require('../queries/animeDetail.graphql');
const { WEEKLY_SCHEDULE_QUERY } = require('../queries/weeklySchedule.graphql');
const { enqueueEnrichment, enqueuePhase4Enrichment, enqueueV3Enrichment } = require('./bangumi.service');

const ANILIST_URL   = 'https://graphql.anilist.co';
const CACHE_TTL_MS  = (parseInt(process.env.CACHE_TTL_HOURS) || 24) * 60 * 60 * 1000;
const SEARCH_TTL_MS = 10 * 60 * 1000;
const MIN_INTERVAL  = 700; // ms between AniList requests ≈ 85 req/min

// ─── Rate-limit outgoing AniList requests ────────────────────────────────────
let lastRequestTime = 0;

async function queryAniList(query, variables, _retries = 0) {
  const wait = MIN_INTERVAL - (Date.now() - lastRequestTime);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestTime = Date.now();

  const res = await fetch(ANILIST_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body:    JSON.stringify({ query, variables })
  });

  if (res.status === 429) {
    if (_retries >= 3) {
      throw Object.assign(new Error('AniList 请求过于频繁，请稍后再试'), { status: 429 });
    }
    const retryAfter = parseInt(res.headers.get('retry-after')) || 60;
    console.log(`⏳ AniList 429 — waiting ${retryAfter}s before retry ${_retries + 1}/3`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return queryAniList(query, variables, _retries + 1);
  }

  if (!res.ok) {
    throw Object.assign(new Error(`AniList API error: ${res.status}`), { status: 502 });
  }

  const { data, errors } = await res.json();
  if (errors) throw Object.assign(new Error(errors[0].message), { status: 502 });
  return data;
}

// ─── Normalize AniList media → our schema ────────────────────────────────────
function normalize(m) {
  const base = {
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
  // Detail-only fields — only included when present in the AniList response
  if (m.studios)   base.studios   = m.studios.nodes.map(n => n.name);
  if (m.startDate?.year) base.startDate = m.startDate;
  if (m.duration != null) base.duration = m.duration;
  if (m.source)    base.source    = m.source;
  if (m.relations) base.relations = m.relations.edges.map(e => ({
    anilistId:     e.node.id,
    relationType:  e.relationType,
    title:         e.node.title?.romaji || e.node.title?.native,
    coverImageUrl: e.node.coverImage?.large ?? null,
    format:        e.node.format ?? null,
  }));
  if (m.characters) base.characters = m.characters.edges.map(e => ({
    nameEn:             e.node.name?.full              ?? null,
    nameJa:             e.node.name?.native            ?? null,
    imageUrl:           e.node.image?.medium           ?? null,
    role:               e.role                         ?? null,
    voiceActorEn:       e.voiceActors?.[0]?.name?.full   ?? null,
    voiceActorJa:       e.voiceActors?.[0]?.name?.native ?? null,
    voiceActorImageUrl: e.voiceActors?.[0]?.image?.medium ?? null,
  }));
  if (m.staff) base.staff = m.staff.edges.map(e => ({
    nameEn:  e.node.name?.full   ?? null,
    nameJa:  e.node.name?.native ?? null,
    imageUrl: e.node.image?.medium ?? null,
    role:    e.role ?? null,
  }));
  if (m.recommendations) base.recommendations = m.recommendations.nodes
    .filter(n => n.mediaRecommendation)
    .map(n => ({
      anilistId:    n.mediaRecommendation.id,
      title:        n.mediaRecommendation.title?.romaji || n.mediaRecommendation.title?.native,
      coverImageUrl: n.mediaRecommendation.coverImage?.large ?? null,
      averageScore: n.mediaRecommendation.averageScore ?? null,
    }));
  return base;
}

// ─── Upsert a list of anime into MongoDB ─────────────────────────────────────
async function upsertCache(animeList) {
  await Promise.all(animeList.map(a =>
    AnimeCache.findOneAndUpdate(
      { anilistId: a.anilistId },
      { $set: a },
      { upsert: true, new: true }
    )
  ));
}

// ─── Season warm tracking ─────────────────────────────────────────────────────
// warmedSeasons: 'WINTER-2026' → { total, cachedAt }
// warmingProgress: Set of keys currently being fetched
const warmedSeasons   = new Map();
const warmingProgress = new Set();

// Fetch every page of a season (50/page) and store all into MongoDB
async function warmSeasonCache(season, year) {
  const key = `${season}-${year}`;
  if (warmingProgress.has(key)) return; // already running
  warmingProgress.add(key);
  console.log(`🔄 Warming season cache: ${season} ${year}`);

  try {
    let page = 1, lastPage = 1, total = 0;
    do {
      const data = await queryAniList(SEASONAL_ANIME_QUERY, {
        season, seasonYear: year, page, perPage: 50
      });
      const { pageInfo, media } = data.Page;
      lastPage = pageInfo.lastPage;
      total   += media.length;
      const normalized = media.map(normalize);
      await upsertCache(normalized);
      enqueueEnrichment(normalized); // Bangumi 中文标题后台富化
      console.log(`  ✓ ${season} ${year} — page ${page}/${lastPage} (${media.length} anime)`);
      page++;
    } while (page <= lastPage);

    warmedSeasons.set(key, { total, cachedAt: Date.now() });
    console.log(`✅ Season cache ready: ${total} anime for ${season} ${year}`);
  } catch (err) {
    console.error(`❌ Season warm failed [${key}]:`, err.message);
  } finally {
    warmingProgress.delete(key);
  }
}

// Check if a season is fully cached in memory (fast path)
function getWarmStatus(season, year) {
  const mem = warmedSeasons.get(`${season}-${year}`);
  if (mem && Date.now() - mem.cachedAt < CACHE_TTL_MS) return { warmed: true, total: mem.total };
  return { warmed: false, total: 0 };
}

// Called on server startup — warm current season
function getCurrentSeasonInfo() {
  const month = new Date().getMonth() + 1;
  const year  = new Date().getFullYear();
  if (month <= 3)  return { season: 'WINTER', year };
  if (month <= 6)  return { season: 'SPRING', year };
  if (month <= 9)  return { season: 'SUMMER', year };
  return { season: 'FALL', year };
}

const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

async function warmCurrentSeason() {
  const { season, year } = getCurrentSeasonInfo();
  await warmSeasonCache(season, year);

  // Re-enqueue orphaned v0 entries (enrichment interrupted by previous restart)
  const orphans = await AnimeCache.find(
    { $or: [{ bangumiVersion: 0 }, { bangumiVersion: { $exists: false } }] },
    { anilistId: 1, titleNative: 1, titleRomaji: 1, bangumiVersion: 1 }
  ).lean();
  if (orphans.length > 0) {
    enqueueEnrichment(orphans);
    console.log(`🔧 Re-enqueued ${orphans.length} orphaned v0 entries for enrichment`);
  }

  // Every 24h: re-warm current year + next season (covers upcoming new anime)
  setInterval(() => {
    const cur = getCurrentSeasonInfo();
    const curIdx = SEASONS.indexOf(cur.season);
    const nextIdx = (curIdx + 1) % SEASONS.length;
    const nextYear = nextIdx === 0 ? cur.year + 1 : cur.year;
    console.log(`🔄 Scheduled re-warm: ${cur.year} → ${SEASONS[nextIdx]} ${nextYear}`);
    warmAllSeasons(cur.year, { endSeason: SEASONS[nextIdx], endYear: nextYear }).catch(err =>
      console.error('❌ Scheduled warm failed:', err.message)
    );
  }, 24 * 60 * 60 * 1000);
}

// Warm seasons from startYear up to endSeason/endYear (inclusive)
let warmAllRunning = false;
async function warmAllSeasons(startYear = 2014, { endSeason, endYear } = {}) {
  if (warmAllRunning) { console.log('⚠️ warmAllSeasons already running, skipping'); return; }
  warmAllRunning = true;
  try {
    const cur = getCurrentSeasonInfo();
    const limitYear   = endYear   ?? cur.year;
    const limitIdx    = endSeason ? SEASONS.indexOf(endSeason) : SEASONS.indexOf(cur.season);
    let warmed = 0, skipped = 0;
    for (let y = startYear; y <= limitYear; y++) {
      for (let s = 0; s < SEASONS.length; s++) {
        if (y === limitYear && s > limitIdx) break;
        const key = `${SEASONS[s]}-${y}`;
        if (warmedSeasons.has(key)) { skipped++; continue; }

        await warmSeasonCache(SEASONS[s], y);
        if (warmedSeasons.has(key)) warmed++;

        // 10s cooldown between seasons to stay within AniList rate limits
        await new Promise(r => setTimeout(r, 10_000));
      }
    }
    console.log(`✅ warmAllSeasons complete (${warmed} warmed, ${skipped} already cached)`);
  } finally { warmAllRunning = false; }
}

// ─── Seasonal anime ───────────────────────────────────────────────────────────
async function getSeasonalAnime(season, year, page = 1, perPage = 20) {
  const pageNum    = parseInt(page);
  const perPageNum = parseInt(perPage);
  const yearNum    = parseInt(year);
  const key        = `${season}-${yearNum}`;

  const { warmed, total } = getWarmStatus(season, yearNum);

  // ① Fully warmed → pure MongoDB, zero AniList requests
  if (warmed) {
    const skip  = (pageNum - 1) * perPageNum;
    const anime = await AnimeCache.find({
      season, seasonYear: yearNum,
      genres: { $nin: ['Hentai'] }
    })
      .sort({ averageScore: -1 })
      .skip(skip)
      .limit(perPageNum)
      .lean();


    return {
      pageInfo: {
        total,
        currentPage: pageNum,
        lastPage:    Math.ceil(total / perPageNum),
        hasNextPage: skip + perPageNum < total,
        perPage:     perPageNum
      },
      anime
    };
  }

  // ② Warming in progress or not started → trigger background warm
  if (!warmingProgress.has(key)) {
    warmSeasonCache(season, yearNum).catch(() => {});
  }

  // ③ Serve cached MongoDB data while warming (avoids waiting)
  //    No cachedAt filter — stale data is better than missing data;
  //    the background warm (②) will refresh it.
  const totalCached = await AnimeCache.countDocuments({
    season, seasonYear: yearNum,
    genres: { $nin: ['Hentai'] }
  });

  if (totalCached > 0) {
    const skip  = (pageNum - 1) * perPageNum;
    const anime = await AnimeCache.find({
      season, seasonYear: yearNum,
      genres: { $nin: ['Hentai'] }
    })
      .sort({ averageScore: -1 })
      .skip(skip)
      .limit(perPageNum)
      .lean();

    if (anime.length > 0) {
      const unenriched = anime.filter(a => !a.bangumiVersion);
      if (unenriched.length) enqueueEnrichment(unenriched);

      return {
        pageInfo: {
          total:       totalCached,
          currentPage: pageNum,
          lastPage:    Math.ceil(totalCached / perPageNum),
          hasNextPage: skip + perPageNum < totalCached,
          perPage:     perPageNum
        },
        anime
      };
    }
  }

  // ④ Cold start (nothing cached yet) → fetch page directly, background warm continues

  const anilistPerPage = Math.min(perPageNum, 50); // AniList API caps at 50
  const data      = await queryAniList(SEASONAL_ANIME_QUERY, {
    season, seasonYear: yearNum, page: pageNum, perPage: anilistPerPage
  });
  const animeList = data.Page.media.map(normalize);
  await upsertCache(animeList);
  enqueueEnrichment(animeList);

  // Re-read from MongoDB so existing enriched fields (titleChinese, bangumiVersion, etc.)
  // are included in the response — normalize() only has AniList data.
  const ids   = animeList.map(a => a.anilistId);
  const anime = await AnimeCache.find({ anilistId: { $in: ids } })
    .sort({ averageScore: -1 })
    .lean();

  return { pageInfo: data.Page.pageInfo, anime };
}

// ─── Search anime — in-memory cache ──────────────────────────────────────────
const searchCache = new Map();

async function searchAnime(search, genre, page = 1, perPage = 20) {
  const key    = `${search || ''}|${genre || ''}|${page}|${perPage}`;
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.time < SEARCH_TTL_MS) return cached.data;

  const data      = await queryAniList(SEARCH_ANIME_QUERY, {
    search: search || undefined,
    genre:  genre  || undefined,
    page:   parseInt(page),
    perPage: parseInt(perPage)
  });
  const animeList = data.Page.media.map(normalize);
  await upsertCache(animeList);
  enqueueEnrichment(animeList); // Bangumi 中文标题后台富化

  // Re-read from MongoDB to include enriched fields (titleChinese, etc.)
  const ids   = animeList.map(a => a.anilistId);
  const anime = await AnimeCache.find({ anilistId: { $in: ids } })
    .sort({ averageScore: -1 })
    .lean();
  const result = { pageInfo: data.Page.pageInfo, anime };
  searchCache.set(key, { data: result, time: Date.now() });
  return result;
}

// ─── Single anime detail — cache-first ───────────────────────────────────────
async function getAnimeDetail(anilistId) {
  const cached = await AnimeCache.findOne({ anilistId: parseInt(anilistId) }).lean();
  // Use lean() so unset fields are truly undefined (not Mongoose array defaults).
  // cached.studios === undefined means document was written before P4-3 — force re-fetch.
  const stale = !cached ||
    Date.now() - cached.cachedAt.getTime() >= CACHE_TTL_MS ||
    cached.studios === undefined ||
    !cached.characters?.length ||
    (cached.characters?.length > 0 && cached.characters[0].role === undefined) ||
    (cached.relations?.length > 0 && !cached.relations[0].coverImageUrl);
  if (!stale) {
    if (!cached.bangumiVersion) enqueueEnrichment([cached], true);           // Phase 1-3 (priority)
    else if (cached.bangumiVersion === 1 && cached.bgmId) enqueuePhase4Enrichment([cached], true); // Phase 4 (priority)
    else if (cached.bangumiVersion === 1 && !cached.bgmId) {
      // Stuck: Phase 1-3 done but no bgmId — Phase 4 impossible, advance to done
      AnimeCache.updateOne({ anilistId: cached.anilistId }, { $set: { bangumiVersion: 2, episodeTitles: [] } }).catch(() => {});
    }
    else if (cached.bangumiVersion >= 2 && cached.episodes > 0 && cached.episodeTitles == null) {
      enqueuePhase4Enrichment([cached], true); // Re-run to fill missing episodeTitles (priority)
    }
    else if (cached.bangumiVersion >= 2 && cached.bgmId && cached.characters?.length > 0 && !cached.characters[0]?.nameCn) {
      enqueuePhase4Enrichment([cached], true); // Re-run to fill character Chinese names (priority)
    }
    else if (cached.bangumiVersion === 2 && cached.bgmId && !cached.titleChinese) {
      enqueueV3Enrichment([cached], true); // V3: 中文标题自愈 (priority)
    }
    return cached;
  }

  const data  = await queryAniList(ANIME_DETAIL_QUERY, { id: parseInt(anilistId) });
  const anime = normalize(data.Media);
  await upsertCache([anime]);
  enqueueEnrichment([anime], true); // Phase 1-3 first (priority); Phase 4 queued after bgmId is resolved

  // Re-read from MongoDB to include enriched fields (titleChinese, bangumiScore, characters.nameCn, etc.)
  const enriched = await AnimeCache.findOne({ anilistId: parseInt(anilistId) }).lean();
  return enriched || anime;
}

// ─── Weekly schedule ──────────────────────────────────────────────────────────
const scheduleCache = new Map(); // 'YYYY-MM-DD' → { data, cachedAt }
const SCHEDULE_TTL  = 30 * 60 * 1000; // 30 min

async function getWeeklySchedule() {
  const todayKey = new Date().toISOString().split('T')[0];
  const hit      = scheduleCache.get(todayKey);
  if (hit && Date.now() - hit.cachedAt < SCHEDULE_TTL) return hit.data;

  // today midnight local → 7 days later (as Unix seconds)
  const now   = new Date();
  const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
  const end   = start + 7 * 24 * 60 * 60;

  // Fetch all pages (usually 1-2)
  const allSchedules = [];
  let page = 1, hasNext = true;
  while (hasNext) {
    const data = await queryAniList(WEEKLY_SCHEDULE_QUERY, { weekStart: start, weekEnd: end, page });
    allSchedules.push(...data.Page.airingSchedules);
    hasNext = data.Page.pageInfo.hasNextPage;
    page++;
  }

  // Group by local date string 'YYYY-MM-DD'
  const groups = {};
  allSchedules.forEach(item => {
    if (item.media.isAdult) return; // skip adult content
    const d   = new Date(item.airingAt * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push({
      scheduleId:    item.id,
      airingAt:      item.airingAt,
      episode:       item.episode,
      anilistId:     item.media.id,
      titleRomaji:   item.media.title.romaji,
      titleEnglish:  item.media.title.english,
      titleNative:   item.media.title.native,
      titleChinese:  null, // 下方从 AnimeCache 拼入
      coverImageUrl: item.media.coverImage?.extraLarge || item.media.coverImage?.large,
      format:        item.media.format,
      averageScore:  item.media.averageScore,
      genres:        item.media.genres || []
    });
  });

  // 从 AnimeCache 拼入 titleChinese，并触发尚未富化条目的后台富化
  const allIds = [...new Set(Object.values(groups).flat().map(i => i.anilistId))];
  if (allIds.length > 0) {
    const cached = await AnimeCache.find(
      { anilistId: { $in: allIds } },
      { anilistId: 1, titleChinese: 1, titleNative: 1, bangumiVersion: 1 }
    ).lean();
    const cacheMap = new Map(cached.map(a => [a.anilistId, a]));
    const toEnrich = [];
    Object.values(groups).forEach(items =>
      items.forEach(item => {
        const doc = cacheMap.get(item.anilistId);
        item.titleChinese = doc?.titleChinese ?? null;
        if (doc && !doc.bangumiVersion) {
          toEnrich.push({
            anilistId:   item.anilistId,
            titleNative: doc.titleNative || item.titleNative,
            titleRomaji: item.titleRomaji,
          });
        }
      })
    );
    if (toEnrich.length > 0) enqueueEnrichment(toEnrich);
  }

  const result = { today: todayKey, groups };
  scheduleCache.set(todayKey, { data: result, cachedAt: Date.now() });
  return result;
}

function clearScheduleCache() { scheduleCache.clear(); }

module.exports = {
  getSeasonalAnime, searchAnime, getAnimeDetail, getWeeklySchedule,
  warmSeasonCache, warmCurrentSeason, warmAllSeasons,
  upsertCache, normalize, clearScheduleCache
};
