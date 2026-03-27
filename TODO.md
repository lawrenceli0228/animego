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
- [x] 补写 trending 缓存/空数据/limit clamp 测试 — v0.1.1.0 完成
- [x] 补写 watchers 空数据/非法 ID 测试 — v0.1.1.0 完成
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

---

## ✅ 待办八：建立 DESIGN.md 设计系统文档（已完成 2026-03-27）

DESIGN.md 已在 feat/community-phase3 分支由 /design-consultation 生成，包含完整色系、字体规格、间距体系、动画参数。

---

_记录时间：2026-03-21（CEO Review 补充）_
_完成时间：2026-03-27_

---

## 待办九：全局 Toast 通知系统

**What：** 实现一个轻量 Toast 组件（右下角入场，2-3 秒自动消失）+ 全局 `ToastContext`，替代现有的静默失败和 `alert()` 调用。

**Why：** 目前关注操作失败静默，追番更新无反馈，分享链接用 `alert()`——每一个都在悄悄磨损用户信任。

**Pros：** 统一操作反馈；`alert()` 全部清除；为后续所有需要通知的功能提供基础设施。

**Cons：** 需要新建 Context + 组件，约 40 行代码。

**Context：** 已知需要接入的点：`FollowButton` 失败态、`UserProfilePage` 分享按钮（当前 `alert(t('detail.linkCopied'))`）、后续磁力搜索重设计中的复制反馈（当前用 `setCopied` 本地状态）。Toast 组件应支持 success / error / info 三种语义，对应 `--success #30d158` / `--error #ff453a` / `--info #5ac8fa`。

**Effort：** S（人工 4h / CC ~20min）｜**Priority：** P2｜**Depends on：** 无

---

## 待办十：弹幕输入框断线状态视觉处理

**What：** `DanmakuInput.jsx` 在 `connected === false` 时，输入框 opacity 降为 0.4，placeholder 改为 `t('danmaku.connecting')`，阻止用户在断线时打字。

**Why：** 用户现在会在断线状态下打字、点发送，什么都不发生，不知道是 bug 还是自己操作错了。

**Pros：** 消除无效操作；明确传达连接状态。

**Cons：** 极小改动（~5 行）。

**Context：** `DanmakuInput.jsx:41`。当前只有发送按钮会变暗（`value.trim() && connected`），输入框本身无视觉变化。`connected` prop 已传入组件，直接可用。

**Effort：** S（人工 1h / CC ~10min）｜**Priority：** P2｜**Depends on：** 无

---

## 待办十一：用户追番列表分页（"显示更多"）

**What：** `UserProfilePage.jsx` 每个状态分组默认只显示前 12 部，底部加「显示更多」按钮，点击展开全部。

**Why：** 追番数量多的用户（100+ 已完结）会一次性渲染大量 `AnimeCard`，导致页面卡顿。

**Pros：** 防止大用户页面卡顿；首屏加载更快；视觉上更整洁。

**Cons：** 纯前端逻辑，无需改后端接口。

**Context：** `UserProfilePage.jsx:122`，`byStatus[status]` 数组直接 `.map()` 渲染，无截断。改为 `byStatus[status].slice(0, expanded ? Infinity : 12)` + 展开按钮。

**Effort：** S（人工 2h / CC ~15min）｜**Priority：** P3｜**Depends on：** 无

---

_记录时间：2026-03-27（Design Review 补充）_
