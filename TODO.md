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
- [x] 补写评论权限测试（403 场景）— v0.1.4.0 完成
- [x] 补写评论内容验证测试（前后端一致性）— v0.1.4.0 完成
- [x] 补写 LanguageContext 回退行为测试 — v0.1.4.0 完成
- [x] 补写 EpisodeList 高亮边界条件测试 — v0.1.4.0 完成
- [x] 补写 trending 缓存/空数据/limit clamp 测试 — v0.1.1.0 完成
- [x] 补写 watchers 空数据/非法 ID 测试 — v0.1.1.0 完成
- [x] 补写 TrendingSection/WatchersAvatarList 前端测试 — v0.1.4.0 完成

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

---

## ✅ 待办八：建立 DESIGN.md 设计系统文档（已完成 2026-03-27）

DESIGN.md 已在 feat/community-phase3 分支由 /design-consultation 生成，包含完整色系、字体规格、间距体系、动画参数。

---

_记录时间：2026-03-21（CEO Review 补充）_
_完成时间：2026-03-27_

---

## ✅ 待办九：全局 Toast 通知系统（已完成 2026-03-28）

**What：** 实现一个轻量 Toast 组件（右下角入场，2-3 秒自动消失）+ 全局 `ToastContext`，替代现有的静默失败和 `alert()` 调用。

**Why：** 目前关注操作失败静默，追番更新无反馈，分享链接用 `alert()`——每一个都在悄悄磨损用户信任。

**Pros：** 统一操作反馈；`alert()` 全部清除；为后续所有需要通知的功能提供基础设施。

**Cons：** 需要新建 Context + 组件，约 40 行代码。

**Context：** 已知需要接入的点：`FollowButton` 失败态、`UserProfilePage` 分享按钮（当前 `alert(t('detail.linkCopied'))`）、后续磁力搜索重设计中的复制反馈（当前用 `setCopied` 本地状态）。Toast 组件应支持 success / error / info 三种语义，对应 `--success #30d158` / `--error #ff453a` / `--info #5ac8fa`。

**Effort：** S（人工 4h / CC ~20min）｜**Priority：** P2｜**Depends on：** 无

---

## ✅ 待办十：弹幕输入框断线状态视觉处理（已完成 2026-03-28）

**What：** `DanmakuInput.jsx` 在 `connected === false` 时，输入框 opacity 降为 0.4，placeholder 改为 `t('danmaku.connecting')`，阻止用户在断线时打字。

**Why：** 用户现在会在断线状态下打字、点发送，什么都不发生，不知道是 bug 还是自己操作错了。

**Pros：** 消除无效操作；明确传达连接状态。

**Cons：** 极小改动（~5 行）。

**Context：** `DanmakuInput.jsx:41`。当前只有发送按钮会变暗（`value.trim() && connected`），输入框本身无视觉变化。`connected` prop 已传入组件，直接可用。

**Effort：** S（人工 1h / CC ~10min）｜**Priority：** P2｜**Depends on：** 无

---

## ✅ 待办十一：用户追番列表分页（"显示更多"）（已完成 2026-03-28）

**What：** `UserProfilePage.jsx` 每个状态分组默认只显示前 12 部，底部加「显示更多」按钮，点击展开全部。

**Why：** 追番数量多的用户（100+ 已完结）会一次性渲染大量 `AnimeCard`，导致页面卡顿。

**Pros：** 防止大用户页面卡顿；首屏加载更快；视觉上更整洁。

**Cons：** 纯前端逻辑，无需改后端接口。

**Context：** `UserProfilePage.jsx:122`，`byStatus[status]` 数组直接 `.map()` 渲染，无截断。改为 `byStatus[status].slice(0, expanded ? Infinity : 12)` + 展开按钮。

**Effort：** S（人工 2h / CC ~15min）｜**Priority：** P3｜**Depends on：** 无

---

_记录时间：2026-03-27（Design Review 补充）_

---

## ✅ 待办十二：补写 follow / profile / danmaku 控制器测试（已完成 v0.2.0.0）

新增 `follow.controller.test.js`（10 tests）、`profile.controller.test.js`（9 tests）、`danmaku.controller.test.js`（4 tests），覆盖自关注 400、幂等 upsert、isFollowing 逻辑、分页、非整数参数校验等场景。

---

## 待办十三：`useFollow` 关注/取关失败静默无反馈

**What：** `client/src/hooks/useSocial.js` 中两个 mutation（follow/unfollow）加 `onError` 回调，调用 `toast.error(t('social.followFailed'))`。同时在 `zh.js`/`en.js` 添加对应翻译 key。

**Why：** 关注或取关失败时（网络错误、500），用户看到按钮回到原始状态，完全不知道操作是否成功。这是用户信任磨损的典型模式。`react-hot-toast` 已引入，修复成本极低。

**Pros：** 消除静默失败；与已有 Toast 系统保持一致；防止用户反复点击关注按钮。

**Cons：** 极小改动（~3 行代码 + 2 个 i18n key）。

**Context：** `useSocial.js` 的 `followMut` 和 `unfollowMut` 都缺少 `onError`。`FollowButton.jsx` 不需要改动，只需在 hook 层处理。

**Effort：** S（人工 1h / CC ~5min）｜**Priority：** P2｜**Depends on：** 待办九（已完成）

---

## 待办十四：`GET /api/feed` 分页支持

**What：** 为 `getFeed`（`profile.controller.js`）加 `?page=N` 参数支持，默认 limit 20，返回 `{ data, hasMore, nextPage }`。前端 `ActivityFeed.jsx` 加"加载更多"按钮。

**Why：** 当前硬编码 `.limit(40)`。对关注 50+ 活跃用户的账号，单次请求会错过大量新动态。这是一个不会随时间自愈的缺陷。

**Pros：** 正确处理高关注量用户；接口设计向前兼容。

**Cons：** 无分页时前端需要保持向后滚动的用户状态；相对简单。

**Context：** `profile.controller.js` 的 `getFeed` 函数，当前在第 47 行 `.limit(40)` 硬截断。ActivityFeed.jsx 需要接收 `hasMore` + `loadMore` prop。

**Effort：** S（人工 2h / CC ~10min）｜**Priority：** P2｜**Depends on：** 无

---

_记录时间：2026-03-28（CEO Review 补充）_

---

## ✅ 待办十五：启动时全量扫描未富化番剧（sweepUnenriched）（已完成）

---

_记录时间：2026-04-03_

---

## ✅ 待办十三：`useFollow` 关注/取关失败 Toast 反馈（已完成 ce3c845）

`useSocial.js` 中 followMut/unfollowMut 已添加 `onError: () => toast.error(t('social.followFailed'))` 和 unfollowFailed。i18n key 已添加。

---

## ✅ 待办十四：`GET /api/feed` 分页支持（已完成 ce3c845）

`profile.controller.js` 的 `getFeed` 已添加 `?page=N` 参数支持，默认 limit 20，返回 `{ data, hasMore, nextPage }`。前端 `ActivityFeed.jsx` 使用 `useInfiniteQuery` + 加载更多按钮。

---

## 待办十六：部署前添加基础错误监控

**What：** 集成 Sentry 或类似的错误监控服务，在生产环境中捕获未处理异常和 API 错误。

**Why：** 当前零监控。部署后如果出错，只能依赖 Railway 日志手动查看。CEO Review 外部声音指出这是重大遗漏——"部署即盲飞"。

**Pros：** 主动发现错误而非等用户反馈；结构化错误报告；免费套餐够用。

**Cons：** 需要第三方服务注册和配置。

**Context：** Express 端添加 `@sentry/node`，客户端添加 `@sentry/react`。ErrorBoundary 组件已可能存在（检查）。DSN 通过环境变量配置。

**Effort：** S（人工 4h / CC ~15min）｜**Priority：** P2｜**Depends on：** 部署平台确定

---

## 待办十七：Admin 重新富化批量操作速率保护

**What：** Admin 仪表盘的 `resetEnrichment` 操作必须走现有 Bangumi 富化队列（800ms/请求），而非绕过直接调用 API。批量操作需要排队机制。

**Why：** 如果 admin 一次标记 50 个番剧重新富化，绕过队列会触发 Bangumi API 429 限速封禁。

**Pros：** 保护 API 配额；与现有架构一致。

**Cons：** 批量操作需要等待时间（50 个番剧 ≈ 40 秒）。

**Context：** Admin MVP 使用现有 `enqueueEnrichment(items, priority=true)` 接口。后续如需批量操作，可添加批量入队接口并在 UI 显示进度。

**Effort：** S（作为 admin 仪表盘实现的一部分）｜**Priority：** P2｜**Depends on：** Admin 仪表盘

---

_记录时间：2026-04-07（CEO Review 补充）_

---

## ✅ 待办十八：部署后 Google Search Console 操作（已完成 2026-04-17）

**背景：** SEO 修复已提交（`6c170ef`），修复了 SPA 壳 canonical 硬编码首页、未缓存 anime 页穿透到错误 canonical、TVSeries 无评分富片段等问题。部署后需要在 GSC 中触发重新索引。

**已完成操作：**

- [x] URL 检查 → `https://animegoclub.com/` → 请求编入索引
- [x] URL 检查 → `https://animegoclub.com/anime` → 验证 301 重定向生效（服务端 301 → `/` 确认；Googlebot UA 也返回 301；GSC 从未索引过，无需清除）
- [x] 高分动画页请求编入索引：`/anime/154587`、`/anime/114129`
- [x] Sitemap 状态核查（GSC 于 2026-04-16 成功读取，5003 URL，无需删除重提）
- [~] 临时删除 `/anime` — 跳过（Google 从未索引此 URL，引荐来源为空）
- [ ] 1-2 周后回看：索引 → 网页 → 「重复网页」类型数量应下降（canonical 修复硬指标）
- [ ] 2-4 周后回看：增强功能 → 结构化数据应出现 TVSeries 富片段

**验证数据：**
- 服务端 `curl -I /anime` → `301 Moved Permanently, Location: /` ✓
- Googlebot UA 同样 301 ✓
- `/anime/114129` GSC 显示「引荐来源网页: sitemap.xml」= Google 已通过 sitemap 发现

---

_记录时间：2026-04-16_
_完成时间：2026-04-17_

---

## 待办：enqueueEnrichment 支持 bgmId 键入队

**What:** `server/services/bangumi.service.js:58` 的后台富化队列当前以 `anilistId` 为唯一键。对于仅能从 dandanplay + bangumi.tv 拿到 `bgmId`（没有 anilistId）的番剧，无法触发后台富化。

**Why:** `/plan-eng-review` 2026-04-18 修复"dandanplay 命中但 AnimeCache 未覆盖导致富化缺失"时发现。当前 fallback 链到"用 bgmId 查 AnimeCache"为止；若 AnimeCache 完全没这条，本次请求静默降级为 `siteAnime:null`，下次访问仍然缺失。若队列支持 bgmId 入队，首次命中后后台能拉 AniList 补齐，第二次访问就有富化。

**Pros:** 让"冷门番剧首次访问→第二次自动有富化"闭环。用户体验完整度上一个台阶。
**Cons:** 改 enqueueMap 键结构（或新增第二张 map by bgmId），需要协调 AniList 反查（bgmId → anilistId 通常要先搜 AniList）。~20 行代码，但涉及两个已稳定运行的 service。
**Context:** 修复路径在 `server/controllers/dandanplay.controller.js` 的 Phase 1 富化 fallback，bgmId 来自 `bangumi.service.fetchBangumiData`。入队后的拉取需要 AniList 的"按 bgmId 搜"或"按标题搜后匹配 bgmId"兜底。
**Depends on / blocked by:** 无硬阻塞，优先级低。可独立 PR。

_记录时间：2026-04-18（/plan-eng-review）_

---

## 待办：磁力 cache 持久化（缓解 cold-start 风暴）

**What:** `server/controllers/anime.controller.js:7` 的 `torrentCache` 是进程内 Map（1h TTL，500 entries 上限）。重启即清零。把它换成 Redis（或 SQLite/MongoDB 已有连接）后端,让缓存跨重启存活。

**Why:** 当前 cache 在生产重启窗口内全清。如果重启撞上流量高峰,500 个用户的下一次搜索全部穿透到 animes.garden + acg.rip + nyaa。三家 upstream 同一秒收到 500 倍并发,可能触发临时封 IP / 502。
更糟:每个搜索打 3 个上游、每个上游 8s timeout,冷启动期间用户感受 = 慢且不稳定。

**Pros:**
- 重启不再清缓存,upstream 请求量平滑。
- 1h TTL 可以保留(对"找资源"场景够新鲜)。
- 跨进程共享(以后多 worker / 多 pod 时直接受益)。

**Cons:**
- 引入 Redis 依赖(或挪到现有 MongoDB)。
- 需要序列化/反序列化(目前 Map 直接存 object,要改成 JSON.stringify/parse)。
- TTL 用 Redis EXPIRE 比手写 timestamp 比较干净,但要测一下 KEY 命名空间不撞别的 service。

**Context:** `/plan-eng-review` 2026-05-10 评 animes.garden 接入 PR (commit `06b4e47`) 时识别出来。当时决定不在那个 PR 解决(scope creep),记成 TODO。当前的 dmhy 时代已经存在这个问题,只是没人 flag 过 — 接 garden 之后 upstream 风险更集中(garden 一家挂了等于 dmhy + moe 一起断)所以更值得做。

**Depends on / blocked by:** 无硬阻塞。建议跟其他 cache 统一(`trendingCache`、`yearlyTopCache` 都是同一个进程内 Map 模式,可以一次性升级)。

_记录时间：2026-05-10（/plan-eng-review）_
