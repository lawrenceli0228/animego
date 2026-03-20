# AnimeGo 缓存与翻页修复方案

---

## 一、问题概述

### 问题一：季度番剧翻页数据为空

用户浏览季度番剧翻到第 2 页及以后，返回空列表。

根本原因：首次请求只从 AniList 拉取了当前页的 20 条并写入 MongoDB。翻页时缓存判断条件 `totalCached(20) >= perPage(20)` 为 true，走缓存路径，但 `skip(20).limit(20)` 在只有 20 条数据的情况下返回空数组。整个季度只有第 1 页的 20 条被缓存，后续页面的数据完全缺失。

### 问题二：AniList 429 限流未根本解决

每次翻页、搜索仍会触发 AniList 请求，多用户并发时依然存在 429 风险。当前方案只加了 700ms 出站间隔（减速），没有消除对 AniList 的依赖。搜索使用内存缓存，服务器重启即丢失。

---

## 二、解决方案

核心思路：一次性预热整个季度的全部番剧到 MongoDB，之后所有翻页请求 100% 走本地数据库，不再逐页请求 AniList。

### 2.1 新增 warmSeasonCache 全量预热函数

在 `server/services/anilist.service.js` 中新增：

```javascript
// ─── 并发预热锁，防止同一季度被多次预热 ─────────────────────────────────
const warmingLocks = new Map();

async function warmSeasonCache(season, year) {
  const yearNum = parseInt(year);
  const lockKey = `${season}_${yearNum}`;

  // 如果已有相同季度的预热正在进行，复用同一个 Promise
  if (warmingLocks.has(lockKey)) {
    return warmingLocks.get(lockKey);
  }

  const warmPromise = (async () => {
    let page = 1;
    let hasNext = true;

    console.log(`[Cache] 预热 ${season} ${yearNum} ...`);

    while (hasNext) {
      const data = await queryAniList(SEASONAL_ANIME_QUERY, {
        season,
        seasonYear: yearNum,
        page,
        perPage: 50  // 每页拉满50条，减少请求次数
      });

      const animeList = data.Page.media.map(normalize);
      await upsertCache(animeList);

      hasNext = data.Page.pageInfo.hasNextPage;
      page++;
      console.log(
        `[Cache] ${season} ${yearNum} 第${page - 1}页, ${animeList.length}条`
      );
    }

    const total = await AnimeCache.countDocuments({
      season, seasonYear: yearNum
    });
    console.log(`[Cache] ${season} ${yearNum} 预热完成, 共 ${total} 条`);
  })();

  warmingLocks.set(lockKey, warmPromise);

  try {
    await warmPromise;
  } finally {
    warmingLocks.delete(lockKey);
  }
}
```

关键点说明：

- 每页拉 50 条（AniList 允许的最大值），减少 API 请求次数
- 配合 700ms 出站间隔，一个季度约 200-400 部番，4-8 页，3-6 秒完成
- 使用 while 循环遍历所有分页，直到 hasNextPage 为 false
- 全量 upsert 到 MongoDB，确保数据完整
- `warmingLocks` 并发锁：相同季度的预热只执行一次，多个并发请求共享同一个 Promise，避免重复拉取

### 2.2 改写 getSeasonalAnime 翻页逻辑

将原函数替换为以下实现：

```javascript
async function getSeasonalAnime(season, year, page = 1, perPage = 20) {
  const pageNum    = parseInt(page);
  const perPageNum = parseInt(perPage);
  const yearNum    = parseInt(year);
  const freshSince = new Date(Date.now() - CACHE_TTL_MS);

  // 检查这个季度是否已完整缓存
  const totalCached = await AnimeCache.countDocuments({
    season,
    seasonYear: yearNum,
    cachedAt: { $gt: freshSince }
  });

  // 缓存不存在或已过期：触发全量预热
  if (totalCached === 0) {
    await warmSeasonCache(season, yearNum);
  }

  // 全部走 MongoDB
  const total = await AnimeCache.countDocuments({
    season,
    seasonYear: yearNum,
    cachedAt: { $gt: freshSince }
  });

  const skip  = (pageNum - 1) * perPageNum;
  const anime = await AnimeCache.find({
    season,
    seasonYear: yearNum,
    cachedAt: { $gt: freshSince }
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
```

改动要点：

- 原判断条件 `totalCached >= perPageNum` 改为 `totalCached === 0`
- 缓存为空时触发完整预热（而非只拉当前页）
- 预热后所有翻页请求均走 MongoDB，零 AniList 请求

### 2.3 服务器启动时后台预热

修改 `server/index.js`，在 app.listen 回调中添加预热逻辑：

```javascript
const { warmSeasonCache } = require('./services/anilist.service');

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // 后台预热当前季度（不阻塞启动）
  const seasons = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
  const now     = new Date();
  const month   = now.getMonth();     // 0-11
  const year    = now.getFullYear();
  const current = seasons[Math.floor(month / 3)];

  warmSeasonCache(current, year).catch(err =>
    console.error('[Cache] 预热失败:', err.message)
  );
});
```

关键点说明：

- 启动后立即在后台异步预热，不阻塞 API 响应
- 自动计算当前季度（1-3月 WINTER，4-6月 SPRING，7-9月 SUMMER，10-12月 FALL）
- 用户第一次访问时大概率缓存已就绪
- 预热失败只打印错误日志，不影响服务运行

---

## 三、涉及文件

| 文件路径 | 改动内容 |
|---------|---------|
| server/services/anilist.service.js | 新增 warmSeasonCache 函数；改写 getSeasonalAnime 逻辑；导出新函数 |
| server/index.js | 引入 warmSeasonCache，启动后触发当前季度预热 |

---

## 四、数据流对比

### 修复前

```
用户看第1页 → 打 AniList 拉 20 条 → 写入 MongoDB
用户翻第2页 → 缓存判断 20 >= 20 → 走缓存 → skip(20) → 空数组
用户翻第3页 → 缓存判断 20 >= 20 → 走缓存 → skip(40) → 空数组
多用户并发  → 每人每页都打 AniList → 429 限流
```

### 修复后

```
服务器启动   → 后台预热当前季度全部数据（约 300 条，5秒完成）
用户看第1页  → 全走 MongoDB → 立即返回
用户翻第2页  → 全走 MongoDB → 立即返回
用户翻第N页  → 全走 MongoDB → 立即返回
切换其他季度 → 首次触发该季度预热 → 之后全走 MongoDB
24小时后     → 缓存过期 → 下次访问重新预热
```

---

## 五、验证步骤

1. 启动服务器，观察控制台是否输出预热日志
2. 翻到第 2、3、N 页，确认有数据返回
3. 查看服务器日志，确认翻页时不触发 AniList 请求
4. 切换到其他季度（如 FALL 2025），确认首次加载触发预热，之后翻页走缓存
5. 连续快速翻页，确认无 429 错误
6. 并发测试：多个浏览器标签同时切换到未缓存的季度，确认只触发一次预热（日志中只出现一组预热记录）

---

## 六、风险与注意事项

1. **并发预热保护**：已通过 `warmingLocks`（Map + Promise 复用）解决。相同季度的预热只执行一次，后续并发请求 await 同一个 Promise，预热完成后自动释放锁。

2. **预热期间的用户请求**：预热需要 3-6 秒，期间如有用户请求同一季度，会 await 正在进行的预热 Promise，预热完成后直接走 MongoDB 返回数据，不会重复预热。

3. **搜索缓存仍为内存缓存**：本方案只修复季度翻页问题，搜索功能的内存缓存（10 分钟 TTL，重启丢失）保持不变。如需优化搜索缓存可作为后续任务。

---

文档创建时间：2026-03-07
项目：AnimeGo 动漫网站
