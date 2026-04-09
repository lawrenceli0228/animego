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
  const list = data?.list;
  if (!list?.length) return null;

  // 日文精确匹配才取中文翻译，否则只取 bgmId
  const hit = list.find(r => r.name === titleNative) || list[0];
  const exactMatch = hit.name === titleNative;

  const cn = hit.name_cn;
  const titleChinese = exactMatch && cn && cn !== hit.name ? cn : null;
  const bgmId = hit.id ?? null;

  return { titleChinese, bgmId };
}

// ─── 富化队列 ───────────────────────────────────────────────────────────────
// 用 Map<anilistId, item> 存储，保证每个 anilistId 只入队一次
const enrichMap = new Map();
const enrichPriority = []; // 优先队列（用户主动点击详情页时插队）
let queueRunning = false;

/**
 * 将一批 anime 对象加入富化队列（幂等：已在队列中或已完成的会被跳过）
 * @param {Array<{anilistId, titleNative, titleRomaji, bangumiVersion}>} items
 * @param {boolean} priority — true = 插队到队首（详情页请求触发）
 */
function enqueueEnrichment(items, priority = false) {
  let added = 0;
  for (const item of items) {
    if (!item.anilistId) continue;
    if ((item.bangumiVersion ?? 0) >= 1) continue; // 已完成，跳过
    const entry = {
      anilistId:   item.anilistId,
      titleNative: item.titleNative,
      titleRomaji: item.titleRomaji,
    };
    if (priority) {
      enrichMap.delete(item.anilistId); // 从普通队列移除
      if (!enrichPriority.some(e => e.anilistId === item.anilistId)) {
        enrichPriority.push(entry);
        added++;
      }
    } else {
      if (enrichMap.has(item.anilistId)) continue;
      if (enrichPriority.some(e => e.anilistId === item.anilistId)) continue;
      enrichMap.set(item.anilistId, entry);
      added++;
    }
  }

  if (added > 0 && !queueRunning) {
    processQueue();
  }
}

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;

  while (enrichPriority.length > 0 || enrichMap.size > 0) {
    let anilistId, item, isPriority;
    if (enrichPriority.length > 0) {
      item = enrichPriority.shift();
      anilistId = item.anilistId;
      enrichMap.delete(anilistId);
      isPriority = true;
    } else {
      [anilistId, item] = enrichMap.entries().next().value;
      enrichMap.delete(anilistId);
      isPriority = false;
    }

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

      if (bgmId) {
        // Phase 4 possible — stay at version 1, let Phase 4 advance to 2
        await AnimeCache.updateOne(
          { anilistId },
          { $set: { titleChinese, bgmId, bangumiVersion: 1 } }
        );
        enqueuePhase4Enrichment([{ anilistId, bgmId, bangumiVersion: 1 }], isPriority);
        if (titleChinese) {
          console.log(`[Bangumi] ${item.titleRomaji} → ${titleChinese} (bgmId=${bgmId})`);
        } else {
          console.log(`[Bangumi] ${item.titleRomaji} → (no cn title, bgmId=${bgmId})`);
        }
      } else {
        // No bgmId — Phase 4 impossible, mark fully done to stop client polling
        await AnimeCache.updateOne(
          { anilistId },
          { $set: { titleChinese: null, bgmId: null, bangumiVersion: 2, episodeTitles: [] } }
        );
        console.log(`[Bangumi] ${item.titleRomaji} → not found on Bangumi, marked done`);
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
// Uses old subject API (more reliable than v0/episodes) — normalises sort offset for sequels
async function fetchBangumiEpisodes(bgmId) {
  const res = await rateLimitedFetch(`https://api.bgm.tv/subject/${bgmId}/ep`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const rawEps = data?.eps ?? data?.data;
  if (!Array.isArray(rawEps)) return null;

  const eps = rawEps
    .filter(e => e.type === 0 && e.sort > 0)
    .sort((a, b) => a.sort - b.sort);
  if (!eps.length) return null;

  // Normalise: sort may start at 29 for a sequel (S1 had 28 eps). Map to 1-based.
  const offset = Math.floor(eps[0].sort) - 1;
  return eps.map(e => ({
    episode: Math.round(e.sort) - offset,
    nameCn:  e.name_cn || null,
    name:    e.name    || null,
  }));
}

const enrichPhase4Map = new Map();
const enrichPhase4Priority = []; // 优先队列
let phase4Running = false;

/**
 * Enqueue items for Phase 4 enrichment (bangumiScore + bangumiVotes).
 * Only items with bangumiVersion === 1 (have bgmId, not yet phase4) are processed.
 * @param {boolean} priority — true = 插队到队首
 */
function enqueuePhase4Enrichment(items, priority = false) {
  let added = 0;
  for (const item of items) {
    if (!item.anilistId || !item.bgmId) continue;
    const entry = { anilistId: item.anilistId, bgmId: item.bgmId };
    if (priority) {
      enrichPhase4Map.delete(item.anilistId);
      if (!enrichPhase4Priority.some(e => e.anilistId === item.anilistId)) {
        enrichPhase4Priority.push(entry);
        added++;
      }
    } else {
      if (enrichPhase4Map.has(item.anilistId)) continue;
      if (enrichPhase4Priority.some(e => e.anilistId === item.anilistId)) continue;
      enrichPhase4Map.set(item.anilistId, entry);
      added++;
    }
  }
  if (added > 0 && !phase4Running) processPhase4Queue();
}

async function processPhase4Queue() {
  if (phase4Running) return;
  phase4Running = true;

  while (enrichPhase4Priority.length > 0 || enrichPhase4Map.size > 0) {
    let anilistId, item, fromPriority;
    if (enrichPhase4Priority.length > 0) {
      item = enrichPhase4Priority.shift();
      anilistId = item.anilistId;
      enrichPhase4Map.delete(anilistId);
      fromPriority = true;
    } else {
      [anilistId, item] = enrichPhase4Map.entries().next().value;
      enrichPhase4Map.delete(anilistId);
      fromPriority = false;
    }

    try {
      const doc = await AnimeCache.findOne(
        { anilistId },
        { bangumiVersion: 1, characters: 1, episodeTitles: 1, episodes: 1, titleChinese: 1 }
      ).lean();
      // Skip if already fully enriched AND no missing data
      const needsEpisodes = doc?.episodes > 0 && doc?.episodeTitles == null;
      const needsCharCn   = doc?.characters?.length > 0 && !doc.characters[0]?.nameCn;
      if (!doc || (doc.bangumiVersion >= 2 && !needsEpisodes && !needsCharCn)) continue;

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

      // Always set episodeTitles so we know it was attempted ([] = tried but none found)
      update.episodeTitles = (epsResult.status === 'fulfilled' && epsResult.value?.length > 0)
        ? epsResult.value
        : [];

      await AnimeCache.updateOne({ anilistId }, { $set: update });

      console.log(`[Bangumi P4] anilistId=${anilistId} score=${update.bangumiScore ?? '-'} chars=${update.characters?.length ?? 0} eps=${update.episodeTitles?.length ?? 0}`);

      // Auto-enqueue V3 title heal if titleChinese is still null
      if (!doc.titleChinese && item.bgmId) {
        enqueueV3Enrichment([{ anilistId, bgmId: item.bgmId }], fromPriority);
      }
    } catch (err) {
      console.warn(`[Bangumi P4] 富化失败 anilistId=${anilistId}:`, err.message);
    }
  }

  phase4Running = false;
}

// ─── Phase V3: 中文标题自愈 — 用 bgmId 直接查 name_cn ─────────────────────
async function fetchBangumiTitleCn(bgmId) {
  const res = await rateLimitedFetch(`https://api.bgm.tv/v0/subjects/${bgmId}`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.name_cn || null;
}

const enrichV3Map = new Map();
const enrichV3Priority = [];
let v3Running   = false;
let v3Paused    = false;
let v3BatchTotal    = 0;   // 本轮批量自愈总数
let v3BatchProcessed = 0;  // 本轮已处理数
let v3BatchHealed    = 0;  // 本轮成功补上中文标题数

/**
 * 将缺少 titleChinese 但有 bgmId 的条目加入 V3 自愈队列
 * @param {Array<{anilistId, bgmId}>} items
 * @param {boolean} priority — true = 插队到队首
 */
function enqueueV3Enrichment(items, priority = false) {
  let added = 0;
  for (const item of items) {
    if (!item.anilistId || !item.bgmId) continue;
    if (item.titleChinese) continue;           // 已有中文标题，无需自愈
    if ((item.bangumiVersion ?? 0) >= 3) continue;
    const entry = { anilistId: item.anilistId, bgmId: item.bgmId };
    if (priority) {
      enrichV3Map.delete(item.anilistId);
      if (!enrichV3Priority.some(e => e.anilistId === item.anilistId)) {
        enrichV3Priority.push(entry);
        added++;
      }
    } else {
      if (enrichV3Map.has(item.anilistId)) continue;
      if (enrichV3Priority.some(e => e.anilistId === item.anilistId)) continue;
      enrichV3Map.set(item.anilistId, entry);
      added++;
    }
  }
  if (added > 0 && !v3Running && !v3Paused) processV3Queue();
}

/** 批量自愈入队后调用，重置进度计数器 */
function startV3Batch(total) {
  v3BatchTotal     = total;
  v3BatchProcessed = 0;
  v3BatchHealed    = 0;
  v3Paused         = false;
}

function pauseV3()  { v3Paused = true; }

function resumeV3() {
  v3Paused = false;
  if (!v3Running && (enrichV3Priority.length > 0 || enrichV3Map.size > 0)) {
    processV3Queue();
  }
}

async function processV3Queue() {
  if (v3Running) return;
  v3Running = true;

  while ((enrichV3Priority.length > 0 || enrichV3Map.size > 0) && !v3Paused) {
    let anilistId, item;
    if (enrichV3Priority.length > 0) {
      item = enrichV3Priority.shift();
      anilistId = item.anilistId;
      enrichV3Map.delete(anilistId);
    } else {
      [anilistId, item] = enrichV3Map.entries().next().value;
      enrichV3Map.delete(anilistId);
    }

    try {
      const doc = await AnimeCache.findOne(
        { anilistId },
        { bangumiVersion: 1, titleChinese: 1 }
      ).lean();
      if (!doc || doc.bangumiVersion >= 3) { v3BatchProcessed++; continue; }
      // Phase 1-3 已获取到中文标题，直接升版本
      if (doc.titleChinese) {
        await AnimeCache.updateOne({ anilistId }, { $set: { bangumiVersion: 3 } });
        v3BatchProcessed++;
        v3BatchHealed++;
        continue;
      }

      const nameCn = await fetchBangumiTitleCn(item.bgmId);
      const update = { bangumiVersion: 3 };
      if (nameCn) { update.titleChinese = nameCn; v3BatchHealed++; }
      await AnimeCache.updateOne({ anilistId }, { $set: update });
      v3BatchProcessed++;

      if (nameCn) {
        console.log(`[Bangumi V3] anilistId=${anilistId} healed → ${nameCn}`);
      } else {
        console.log(`[Bangumi V3] anilistId=${anilistId} no name_cn on Bangumi`);
      }
    } catch (err) {
      v3BatchProcessed++;
      console.warn(`[Bangumi V3] 自愈失败 anilistId=${anilistId}:`, err.message);
    }
  }

  v3Running = false;
}

/** 返回三个队列的实时深度 + V3 批量进度（管理员面板用） */
function getQueueStatus() {
  const v3Remaining = enrichV3Priority.length + enrichV3Map.size;
  return {
    phase1: enrichPriority.length + enrichMap.size,
    phase4: enrichPhase4Priority.length + enrichPhase4Map.size,
    v3:     v3Remaining,
    v3Progress: v3BatchTotal > 0 ? {
      total:     v3BatchTotal,
      processed: v3BatchProcessed,
      healed:    v3BatchHealed,
      paused:    v3Paused,
    } : null,
  };
}

module.exports = {
  enqueueEnrichment, enqueuePhase4Enrichment, enqueueV3Enrichment,
  getQueueStatus, startV3Batch, pauseV3, resumeV3,
};
