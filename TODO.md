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

---

## 待办三：补写核心测试（社区功能开发前完成）

### 背景

i18n + 集数列表 + 磁链搜索 + 评论系统已全部上线，但项目目前零测试覆盖。
在开始社区化功能（公开追番页、追番广场、MAL 同步）之前，应先为现有高风险逻辑补充测试，
否则社区功能的开发将在没有回归保护的情况下进行。

### 高优先级覆盖范围

**后端（Jest + Supertest）**
- `DELETE /api/comments/:id` — 删除他人评论应返回 403
- `POST /api/comments/:anilistId/:episode` — content 超 500 字应返回 400
- `GET /api/anime/torrents` — 缺少 `q` 参数返回 400；acg.rip 超时返回空数组
- `GET /api/anime/trending` — 缓存命中路径、Subscription 为空返回 `[]`、limit 超上限 clamp 到 20
- `GET /api/anime/:anilistId/watchers` — 无订阅返回 `{ data:[], total:0 }`、anilistId 非数字 400

**前端（Vitest + Testing Library）**
- `LanguageContext.t('missing.key')` — 应回退返回 key 字符串，不崩溃
- `EpisodeList` — `currentEpisode=3` 时，第 1、2 集绿色高亮，第 3 集紫色，第 4 集灰色
- `EpisodeComments` — 未登录时渲染登录提示，不渲染输入框
- `TrendingSection` — 空数据态隐藏模块、loading 态渲染骨架屏
- `WatchersAvatarList` — `total > limit` 时显示 "+N 人" 截断文字

### 待办清单

- [x] 安装 Jest + Supertest（后端）— v0.1.0.0 完成
- [x] 安装 Vitest + @testing-library/react（前端）— v0.1.0.0 完成
- [ ] 补写评论权限测试（403 场景）
- [ ] 补写评论内容验证测试（前后端一致性）
- [ ] 补写 LanguageContext 回退行为测试
- [ ] 补写 EpisodeList 高亮边界条件测试
- [ ] 补写 trending 缓存/空数据/limit clamp 测试
- [ ] 补写 watchers 空数据/非法 ID 测试
- [ ] 补写 TrendingSection/WatchersAvatarList 前端测试

---

_记录时间：2026-03-21_

---

## 待办四：用户追番隐私开关（User.isPublic 字段）

**背景：** 公开追番页 `/u/:username` 默认对所有人可见（强制公开）。未来若用户要求隐私控制，需补充此字段。

**What：** User model 增加 `isPublic: Boolean`（默认 `true`），追番接口对非本人访问时按此字段过滤。

**Why：** 部分用户不希望公开追番记录，强制公开在社区冷启动阶段可行，规模化后需要开关。

**Pros：** 提升用户信任，降低因隐私顾虑导致的流失。

**Cons：** 影响公开广场内容丰富度；私有用户不会贡献到趋势排名。

**Context：** 现阶段采用强制公开策略（Phase 1–2）。待 DAU 规模化或有用户反馈隐私需求后再实现。isPublic 字段加在 User model，追番列表接口 `GET /api/subscriptions/:userId` 增加鉴权判断。

**Effort：** S（人工 4h / CC ~10min）｜**Priority：** P3｜**Depends on：** Phase 2 公开追番页上线

---

## 待办五：WebSocket 水平扩展（Redis Pub/Sub）

**背景：** Phase 3 弹幕使用 socket.io 单实例。Railway 横向扩容后多 pod 间弹幕消息无法互通。

**What：** 引入 `socket.io-redis` adapter + Redis Pub/Sub，所有 pod 共享同一消息总线。

**Why：** 单实例 WebSocket 在多实例部署时弹幕只广播给同 pod 用户，其他用户看不到。

**Pros：** 解除扩容瓶颈，弹幕体验在任意实例数下一致。

**Cons：** 增加 Redis 依赖（Railway Redis addon 有费用）；本地开发需额外启动 Redis。

**Context：** 现阶段 Railway 免费套餐单实例足够。待 Phase 3 上线后观察并发量，达到需要多实例时再引入。Redis adapter 接入点：`server/socket/index.js`。

**Effort：** M（人工 2 天 / CC ~30min）｜**Priority：** P3｜**Depends on：** Phase 3 弹幕上线 + 实际扩容需求

---

## 待办六：MAL / AniList OAuth 一键导入追番记录

**背景：** 新用户需手动重建追番列表，迁移成本高，是社区冷启动最大阻力之一。

**What：** 用户授权后通过 MAL/AniList OAuth 拉取现有追番列表，批量写入 Subscription collection。

**Why：** 降低新用户冷启动门槛，直接带来有数据的社交图谱，是社区化投放前最强增长手段。

**Pros：** 显著提升新用户留存；导入后立刻有内容，社交功能可用。

**Cons：** OAuth 流程复杂（申请 API key、回调、token 刷新）；MAL API 限流严格。

**Context：** 优先 AniList（GraphQL，文档好，无需 key）。MAL 需申请 client_id。实现思路：新增 `GET /api/auth/anilist/import`，前端授权页跳转 → callback → 后台拉取 → 批量 upsert Subscription。

**Effort：** L（人工 3 天 / CC ~1h）｜**Priority：** P2｜**Depends on：** Phase 2 公开追番页上线

---

## 待办七：分享卡片 OG 图生成

**背景：** Phase 2 分享按钮生成的链接在 Twitter/Discord 展示时只有文字，缺乏视觉吸引力。

**What：** 为 `/u/:username` 和番剧详情页生成带封面图、标题、评分的 OpenGraph 图片（使用 Satori 或 Vercel OG）。

**Why：** 带图分享点击率显著高于纯文字链接，是低成本提升用户获取的手段。

**Pros：** 提升分享转化率；实现后对所有分享场景永久生效。

**Cons：** Satori 字体加载有冷启动延迟；需要 Vercel Edge Function 或单独 worker。

**Context：** 封面图来源 AniList 的 `coverImage.large`，已在 AnimeCache model 中缓存。OG endpoint：`GET /api/og?anilistId=xxx` 返回 PNG。

**Effort：** M（人工 1 天 / CC ~20min）｜**Priority：** P2｜**Depends on：** Phase 2 分享按钮上线

---

---

## 待办八：建立 DESIGN.md 设计系统文档

**背景：** 项目无 DESIGN.md。设计语言（调色 `#0a0e1a/#7c3aed/#06b6d4`、字体 Sora、间距规则、动画时长）全部分散在组件代码里，每次评审需靠反推。

**What：** 运行 `/design-consultation`，生成 DESIGN.md，记录完整设计系统（调色板、字体规格、间距调、动画参数、组件词汇表）。

**Why：** 没有 DESIGN.md，每次设计评审都是在读代码而非对照文档，且新特性容易引入设计不一致。

**Pros：** 设计决策有单一真相源；Phase 2/3 新组件有明确参考，保持视觉一致性。

**Cons：** 当前单人开发，协作收益短期有限；需要半天时间整理。

**Context：** Phase 1 设计评审中已手动推断出设计语言并写入 community-platform-v2.md，这是临时措施。DESIGN.md 应在 Phase 2 前建立，届时会有公开追番页、关注按钮等新组件。命令：`/design-consultation`。

**Effort：** S（人工半天 / CC ~20min）｜**Priority：** P3｜**Depends on：** 无

---

_记录时间：2026-03-21（CEO Review 补充）_
