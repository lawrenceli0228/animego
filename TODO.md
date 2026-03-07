# AnimeGo 待办问题

---

## ✅ 问题一：季度番剧翻页数据为空（已修复 2026-03-08）

### 现象
用户浏览季度番剧翻到第 2 页及以后，返回空列表。

### 根本原因

当前 `getSeasonalAnime` 逻辑：首次请求只从 AniList 拉取当前页的 20 条并写入 MongoDB。
翻页时触发缓存判断：

```
totalCached = 20（只缓存了第 1 页）
perPageNum  = 20
条件：20 >= 20 → 走缓存路径
skip = (2-1) * 20 = 20
MongoDB: skip(20).limit(20) → 只有 20 条数据，跳过 20 条后返回空数组 ❌
```

整个季度只有第 1 页的 20 条被缓存，第 2 页以后的几百条完全没有缓存。

### 影响文件
- `server/services/anilist.service.js` — `getSeasonalAnime` 函数

### 解决方案
新增 `warmSeasonCache(season, year)` 函数，一次性拉取整个季度所有页的数据并全量写入 MongoDB。
之后所有翻页请求完全走 MongoDB，不再逐页打 AniList。

---

## ✅ 问题二：限流未根本解决（已修复 2026-03-08）

### 现象
每次翻页、搜索仍会触发 AniList 请求，多用户并发访问时依然有 429 风险。

### 根本原因

当前方案只是加了 700ms 出站间隔（减速），并没有消除对 AniList 的依赖：

```
用户看第 1 页 → 打 AniList（等 700ms）
用户翻第 2 页 → 打 AniList（再等 700ms）
用户翻第 3 页 → 打 AniList（再等 700ms）
多用户并发   → 请求队列积压 → 超时 / 429 ❌
搜索内存缓存 → 服务器重启即丢失 ❌
```

### 影响文件
- `server/services/anilist.service.js` — `queryAniList`、`getSeasonalAnime`
- `server/index.js` — 缺少启动时预热逻辑

### 解决方案
服务器启动时自动预热当前季度缓存（后台运行，不阻塞启动）：

```
服务器启动
  → 检查当前季度 MongoDB 是否已完整缓存
  → 未缓存 → 后台逐页拉取所有数据（每页 50 条，间隔 700ms）
  → 已缓存且未过期 → 跳过

用户翻任意页 → 全走 MongoDB，0 次 AniList 请求 ✅
24 小时后    → 后台自动刷新，用户无感知 ✅
```

---

## 待办清单

- [x] `anilist.service.js` — 新增 `warmSeasonCache(season, year)` 全量预热函数
- [x] `anilist.service.js` — 修复 `getSeasonalAnime` 翻页逻辑，改为全走 MongoDB
- [x] `server/index.js` — 服务器启动后触发当前季度预热（后台异步，不阻塞）
- [x] 验证：翻到第 2、3、N 页均有数据（已验证 2026-03-08）
- [x] 验证：连续翻页不触发 AniList 请求（已验证 2026-03-08，server 日志无新 AniList 请求）

---

_记录时间：2026-03-07_
_修复时间：2026-03-08_
