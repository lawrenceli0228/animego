/**
 * bangumi.service.js
 * 用 Bangumi API 为 AnimeCache 补充中文标题 (name_cn)
 * 所有操作完全异步后台进行，不阻塞主请求
 */

const AnimeCache = require('../models/AnimeCache');

// ─── 速率限制 ───────────────────────────────────────────────────────────────
const MIN_INTERVAL = 800; // ms between Bangumi requests
let lastCallAt = 0;

async function rateLimitedFetch(url) {
  const wait = MIN_INTERVAL - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCallAt = Date.now();

  const res = await fetch(url, {
    headers: { 'User-Agent': 'AnimGo/1.0 (https://github.com/animego)' },
    signal: AbortSignal.timeout(8000),
  });
  return res;
}

// ─── 核心搜索函数 ───────────────────────────────────────────────────────────
/**
 * 在 Bangumi 搜索动画，返回 { titleChinese, bgmId } 或 null
 * 搜索优先级: titleNative(日文) → titleRomaji
 * bgmId 始终返回（只要命中结果）；titleChinese 为 null 表示无中文名
 */
async function fetchBangumiData(titleNative, titleRomaji) {
  const keyword = titleNative || titleRomaji;
  if (!keyword) return null;

  const url =
    `https://api.bgm.tv/search/subject/${encodeURIComponent(keyword)}` +
    `?type=2&responseGroup=small&max_results=5`;

  const res = await rateLimitedFetch(url);
  if (!res.ok) return null;

  const data = await res.json();
  const hit = data?.list?.[0];
  if (!hit) return null;

  // name_cn 为空或与日文原名相同时视为无中文翻译
  const cn = hit.name_cn;
  const titleChinese = (cn && cn !== hit.name) ? cn : null;
  const bgmId = hit.id ?? null;

  return { titleChinese, bgmId };
}

// ─── 富化队列 ───────────────────────────────────────────────────────────────
// 用 Map<anilistId, item> 存储，保证每个 anilistId 只入队一次
const enrichMap = new Map();
let queueRunning = false;

/**
 * 将一批 anime 对象加入富化队列（幂等：已在队列中或已完成的会被跳过）
 * @param {Array<{anilistId, titleNative, titleRomaji, bangumiVersion}>} items
 */
function enqueueEnrichment(items) {
  let added = 0;
  for (const item of items) {
    if (!item.anilistId) continue;
    if ((item.bangumiVersion ?? 0) >= 1) continue; // 已完成，跳过
    if (enrichMap.has(item.anilistId)) continue; // 已在队列，跳过
    enrichMap.set(item.anilistId, {
      anilistId:   item.anilistId,
      titleNative: item.titleNative,
      titleRomaji: item.titleRomaji,
    });
    added++;
  }

  if (added > 0 && !queueRunning) {
    processQueue();
  }
}

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;

  while (enrichMap.size > 0) {
    const [anilistId, item] = enrichMap.entries().next().value;
    enrichMap.delete(anilistId);

    try {
      // 再次确认 DB 中是否已富化（避免多进程/重启重复写入）
      const doc = await AnimeCache.findOne(
        { anilistId },
        { bangumiVersion: 1 }
      ).lean();
      if (!doc || doc.bangumiVersion >= 1) continue;

      const result = await fetchBangumiData(
        item.titleNative,
        item.titleRomaji
      ).catch(() => null);

      const titleChinese = result?.titleChinese ?? null;
      const bgmId        = result?.bgmId        ?? null;

      await AnimeCache.updateOne(
        { anilistId },
        { $set: { titleChinese, bgmId, bangumiVersion: 1 } }
      );

      // Immediately enqueue Phase 4 if bgmId was found
      if (bgmId) enqueuePhase4Enrichment([{ anilistId, bgmId, bangumiVersion: 1 }]);

      if (titleChinese) {
        console.log(`[Bangumi] ${item.titleRomaji} → ${titleChinese} (bgmId=${bgmId})`);
      } else if (bgmId) {
        console.log(`[Bangumi] ${item.titleRomaji} → (no cn title, bgmId=${bgmId})`);
      }
    } catch (err) {
      console.warn(`[Bangumi] 富化失败 anilistId=${anilistId}:`, err.message);
    }
  }

  queueRunning = false;
}

// ─── Phase 4: Bangumi subject detail (score + vote count) ────────────────────
async function fetchBangumiSubject(bgmId) {
  const res = await rateLimitedFetch(`https://api.bgm.tv/v0/subjects/${bgmId}`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data?.rating) return null;
  return { bangumiScore: data.rating.score ?? null, bangumiVotes: data.rating.total ?? null };
}

// Returns [{ nameCn, voiceActorCn }] sorted by main role first (for index-match with AniList)
async function fetchBangumiCharacters(bgmId) {
  const res = await rateLimitedFetch(`https://api.bgm.tv/v0/subjects/${bgmId}/characters`);
  if (!res.ok) return null;
  const list = await res.json().catch(() => null);
  if (!Array.isArray(list)) return null;
  // relation: 1=主角 2=配角 3=客串 — sort same order as AniList (main first)
  list.sort((a, b) => (a.relation ?? 9) - (b.relation ?? 9));
  return list.map(c => ({
    nameCn:       c.name           ?? null,
    voiceActorCn: c.actors?.[0]?.name ?? null,
  }));
}

// Returns [{ episode, nameCn, name }] for main episodes only
async function fetchBangumiEpisodes(bgmId) {
  const res = await rateLimitedFetch(
    `https://api.bgm.tv/v0/subjects/${bgmId}/episodes?type=0&limit=100`
  );
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!Array.isArray(data?.data)) return null;
  return data.data
    .filter(e => e.ep > 0)
    .map(e => ({
      episode: e.ep,
      nameCn:  e.name_cn || null,
      name:    e.name    || null,
    }));
}

const enrichPhase4Map = new Map();
let phase4Running = false;

/**
 * Enqueue items for Phase 4 enrichment (bangumiScore + bangumiVotes).
 * Only items with bangumiVersion === 1 (have bgmId, not yet phase4) are processed.
 */
function enqueuePhase4Enrichment(items) {
  let added = 0;
  for (const item of items) {
    if (!item.anilistId || !item.bgmId) continue;
    if ((item.bangumiVersion ?? 0) >= 2) continue;
    if (enrichPhase4Map.has(item.anilistId)) continue;
    enrichPhase4Map.set(item.anilistId, { anilistId: item.anilistId, bgmId: item.bgmId });
    added++;
  }
  if (added > 0 && !phase4Running) processPhase4Queue();
}

async function processPhase4Queue() {
  if (phase4Running) return;
  phase4Running = true;

  while (enrichPhase4Map.size > 0) {
    const [anilistId, item] = enrichPhase4Map.entries().next().value;
    enrichPhase4Map.delete(anilistId);

    try {
      const doc = await AnimeCache.findOne(
        { anilistId },
        { bangumiVersion: 1, characters: 1 }
      ).lean();
      if (!doc || doc.bangumiVersion >= 2) continue;

      const [scoreResult, charsResult, epsResult] = await Promise.allSettled([
        fetchBangumiSubject(item.bgmId),
        fetchBangumiCharacters(item.bgmId),
        fetchBangumiEpisodes(item.bgmId),
      ]);

      const update = { bangumiVersion: 2 };

      if (scoreResult.status === 'fulfilled' && scoreResult.value) {
        Object.assign(update, scoreResult.value);
      }

      // Merge Bangumi Chinese names into existing AniList character array (by index)
      if (charsResult.status === 'fulfilled' && charsResult.value?.length > 0) {
        const anilistChars = doc.characters || [];
        const bgmChars     = charsResult.value;
        if (anilistChars.length > 0) {
          update.characters = anilistChars.map((c, i) => ({
            ...c,
            nameCn:       bgmChars[i]?.nameCn       ?? c.nameCn       ?? null,
            voiceActorCn: bgmChars[i]?.voiceActorCn ?? c.voiceActorCn ?? null,
          }));
        }
      }

      if (epsResult.status === 'fulfilled' && epsResult.value?.length > 0) {
        update.episodeTitles = epsResult.value;
      }

      await AnimeCache.updateOne({ anilistId }, { $set: update });

      console.log(`[Bangumi P4] anilistId=${anilistId} score=${update.bangumiScore ?? '-'} chars=${update.characters?.length ?? 0} eps=${update.episodeTitles?.length ?? 0}`);
    } catch (err) {
      console.warn(`[Bangumi P4] 富化失败 anilistId=${anilistId}:`, err.message);
    }
  }

  phase4Running = false;
}

module.exports = { enqueueEnrichment, enqueuePhase4Enrichment };
