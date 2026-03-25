# AnimeGo 开发日志

---

## [0.1.2.0] - 2026-03-25

### Added
- **社区 Phase 2：关注系统** — `POST/DELETE /api/users/:username/follow`，单向关注模型，`Follow` 集合含 `(followerId, followeeId)` 唯一索引
- **公开个人主页** — `GET /api/users/:username`，含追番列表（按状态分组）、粉丝/关注数、`isFollowing` 字段（需 JWT，可选）
- **关注者/关注列表** — `GET /api/users/:username/followers` 与 `/following`
- **好友动态 Feed** — `GET /api/feed`，返回已关注用户近 40 条追番动态，按更新时间倒序
- `FollowButton` 组件：关注/取消关注切换，未登录重定向到 `/login`，自身主页隐藏
- `ActivityFeed` 组件：首页好友动态列表，含时间相对显示（timeAgo）
- `UserProfilePage` — `/u/:username` 公开主页，含渐变头像、粉丝/关注跳转、分享按钮、追番列表分 Tab 展示
- 分享按钮：`AnimeDetailPage` 和 `UserProfilePage` 均集成 `navigator.share()` + 剪贴板回退
- `optionalAuth` 中间件：有效 JWT 附加 `req.user`，无 token 静默跳过
- i18n：新增 `social.*` 键组（中英文），含 `follow`、`followers`、`feedLabel`、`action_*` 等
- `client/src/hooks/useSocial.js`：`useUserProfile`、`useFollow`（TanStack Query mutation + cache invalidation）、`useFeed`
- `client/src/api/social.api.js`：对应 REST 封装

### Changed
- 首页布局：在 `ContinueWatching` 与 `WeeklySchedule` 之间插入 `ActivityFeed`
- `App.jsx`：注册 `/u/:username` 路由指向 `UserProfilePage`
- `server/index.js`：注册 `/api/users` 路由与 `/api/feed` 端点

---

## [0.1.1.0] - 2026-03-25

### Added
- **社区 Phase 1：热门排行榜** — `GET /api/anime/trending`，按订阅数聚合排名，1 小时内存缓存（TTL），最多返回 20 条
- **社区 Phase 1：在看用户** — `GET /api/anime/:anilistId/watchers`，返回正在观看的用户头像列表及总人数
- `WatchersAvatarList` 组件：彩色首字母圆形头像 + "+N 人" 溢出文本，展示在番剧详情页订阅按钮下方
- `TrendingSection` 组件：首页水平滚动热门卡片，含 shimmer 骨架屏加载态
- `AnimeCard` 支持 `rank` 和 `watcherCount` props：显示 `#N` 排名徽章和 👥 观看人数徽章
- i18n：新增 `home.trendingLabel`、`home.trendingTitle`、`anime.watchers`、`anime.watchersMore`（中英文）
- `Subscription` 模型新增 `anilistId` 索引（优化 trending 聚合查询）
- 服务端测试：新增 `getTrending` 和 `getWatchers` 的 6 个 Jest+Supertest 单元测试（覆盖 happy path、参数校验、边界情况）

### Changed
- 首页布局：在 `ContinueWatching` 上方插入 `TrendingSection`
- 番剧详情页：在 `SubscriptionButton` 下方插入 `WatchersAvatarList`

---

## [0.1.0.0] - 2026-03-25

### Added
- 弹幕/评论删除：改用内联确认 UI，替换浏览器原生 `window.confirm()` 弹窗
- 评论发布失败时显示内联错误提示（`postError`）
- 种子搜索 5 分钟内存缓存（Map + TTL），减少对 acg.rip 的重复请求
- 测试基础设施：client 使用 Vitest + @testing-library/react（9 个测试），server 使用 Jest + Supertest（6 个测试）
- `docs/designs/community-platform-v2.md`：社区平台三阶段设计文档（含 CEO / Eng / Design Review 评审结论）
- 版本追踪：创建 `VERSION` 文件（`0.1.0.0`）

### Changed
- 种子数据源：从 Anime Garden 切换至 acg.rip RSS（`anime.controller.js`）

### Removed
- `client/src/utils/constants.js` 中的 `SEASON_LABELS` 对象（无消费者）
- `client/src/components/subscription/StatusBadge.jsx`（未被使用）

---

## 2026-03-07

### 18:26 · 初始化项目

- 创建 GitHub 仓库 `lawrenceli0228/animego`，配置 SSH 认证
- 写入 `.gitignore`（保护 `.env`、`node_modules`）
- 写入项目架构说明 `README.md`
- 配置 `.claude/launch.json` 开发服务器启动项

---

### 18:58 · 完成全栈代码开发（64 文件 / 7775 行）

**后端 · Express + MongoDB Atlas**

- `server/index.js` — Express 入口，CORS + Cookie 配置
- `server/config/db.js` — Mongoose 连接 MongoDB Atlas
- `server/models/` — User（bcrypt 加密）、AnimeCache、Subscription
- `server/services/anilist.service.js` — AniList GraphQL 代理 + MongoDB 缓存
- `server/controllers/` — 认证（JWT 双 Token）、番剧、订阅
- `server/routes/` — `/api/auth`、`/api/anime`、`/api/subscriptions`
- `server/middleware/` — JWT 验证、限流、错误处理

**前端 · React 18 + Vite**

- 暗色电影风格 UI（`#0a0e1a` 深海军蓝 + `#7c3aed` 紫 + `#06b6d4` 青）
- 页面：首页、季度、番剧详情、搜索、登录、注册、个人追番
- 组件：AnimeCard / AnimeGrid / 订阅按钮 / 季度选择器 / 搜索栏 / 分页
- TanStack Query 管理服务端状态，axios 自动刷新 Token

---

### 19:08 · 修复 AniList API 429 限流

**问题：** 每次请求都直接打 AniList，触发 90次/分钟限制

**修复（`anilist.service.js`）：**

- `getSeasonalAnime` — 优先读 MongoDB 缓存，命中则跳过 AniList 请求
- `searchAnime` — 新增内存缓存，相同搜索 10 分钟内不重复请求
- `queryAniList` — 加出站限速，两次请求间隔 ≥ 700ms（≈85次/分钟）

**涉及文件：**
- `server/services/anilist.service.js`

---

### 19:17 · 修复页面无限刷新死循环

**问题根因：**

```
无 cookie → /auth/refresh 返回 401
→ axios 拦截器捕获 → 再调一次 refresh → 失败
→ window.location.href = '/login'  ← 触发整页重载
→ AuthContext 重新挂载 → 再调 refresh → 无限循环
```

**修复：**

- 拦截器跳过 `/auth/refresh` 自身的 401（防套娃）
- 移除 `window.location.href` 硬跳转，改为派发 `auth:expired` 自定义事件
- `AuthContext` 用原生 `axios` 调 refresh，不触发拦截器
- `AuthContext` 监听 `auth:expired` 事件，优雅清除登录状态

**涉及文件：**
- `client/src/api/axiosClient.js`
- `client/src/context/AuthContext.jsx`

---

### 19:22 · 改为访客友好模式，无需强制登录

**需求：** 用户打开网站直接显示番剧内容，不强制跳转登录页

**修复：**

- `AuthContext` 拆分 `initializing`（启动 session 检查）和 `loading`（登录/注册操作中）两个独立状态
- `ProtectedRoute` 改用 `initializing` 判断，session 检查完成前不提前重定向
- `LoginPage` / `RegisterPage` 新增：已登录用户访问时自动跳回首页

**访客浏览流程：**

```
打开网站 → 首页番剧立即渲染
         → 后台静默检查 session（~200ms）
         ├── 有 session → Navbar 显示用户名和追番入口
         └── 无 session → 访客模式，Navbar 显示登录/注册按钮
仅 /profile 需要登录，其余页面全部公开访问
```

**涉及文件：**
- `client/src/context/AuthContext.jsx`
- `client/src/components/common/ProtectedRoute.jsx`
- `client/src/pages/LoginPage.jsx`
- `client/src/pages/RegisterPage.jsx`

---

---

## 2026-03-08

### · 根本修复缓存翻页与 429 限流（`fix: cache pagination and rate limit with full season pre-fetch`）

**问题：** 翻到第 2 页及以后返回空数组；每次翻页仍打 AniList 存在 429 风险

**修复：**

- 新增 `warmSeasonCache(season, year)` — 服务器启动后后台预热整个季度（每页 50 条全量写入 MongoDB）
- `getSeasonalAnime` 改为 4 级降级策略：已预热 MongoDB → 未预热时实时拉取 → 内存缓存兜底
- `server/index.js` 服务器就绪后异步触发 `warmCurrentSeason()`，不阻塞启动

**涉及文件：**
- `server/services/anilist.service.js`
- `server/index.js`

---

### · 首页新增每周放送日历（`feat: add weekly airing schedule to homepage`）

- 新增 `/api/anime/schedule` 接口，从 AniList 拉取本周 7 天播出计划，按本地日期分组，30 分钟内存缓存
- 新增 `WeeklySchedule` 组件：日期标签页（今天高亮）+ 当日番剧竖向列表（封面、集数、播出时间、评分）
- 前端 `localToday()` 用客户端本地时区计算今日日期，避免 UTC 时差错位

**涉及文件：**
- `server/queries/weeklySchedule.graphql.js`（新增）
- `server/controllers/anime.controller.js`
- `server/routes/anime.routes.js`
- `client/src/components/anime/WeeklySchedule.jsx`（新增）
- `client/src/hooks/useAnime.js`
- `client/src/api/anime.api.js`

---

### · 首页改版：Hero 轮播图 + 每周卡片网格（`feat: replace homepage grid with top-5 hero carousel`）

- 移除首页番剧方格，改为当季评分前 5 轮播图（`HeroCarousel`）：全宽 banner、Ken Burns 缩放、5 秒自动切换、悬停暂停、方向箭头、点状指示器
- 每周更新从竖向列表改为横向卡片网格（`auto-fill, minmax(140px, 1fr)`），每张卡片含封面（3:4）、标题、集数标签、时间、评分，悬停上浮效果

**涉及文件：**
- `client/src/components/anime/HeroCarousel.jsx`（新增）
- `client/src/components/anime/WeeklySchedule.jsx`（重构为卡片网格）
- `client/src/pages/HomePage.jsx`

---

### · 首页新增「继续追番」板块（`feat: add continue watching section to homepage`）

- 登录用户首页轮播图下方、每周更新上方新增横向滚动卡片条
- 展示当前状态为 `watching` 的全部追番：封面图 + 观看进度条 + 集数角标（已看/总集数）+ 标题
- 未登录或无在追番剧时自动隐藏，不占空间

**涉及文件：**
- `client/src/components/anime/ContinueWatching.jsx`（新增）
- `client/src/pages/HomePage.jsx`

---

### · 中英文切换 / 集数列表 / 磁力搜索 / 每集评论（`feat: add i18n, episode list, torrent search and episode comments`）

**中英文切换（i18n）**

- 新增 `LanguageContext.jsx` — 轻量级双语 Context，暴露 `t(key)` 和 `lang`，语言偏好持久化到 `localStorage`，默认中文
- 新增 `client/src/locales/zh.js` / `en.js` — 全站 UI 文案翻译字典（Navbar、首页、详情页、订阅、搜索、季度、登录/注册、集数评论等）
- Navbar 右上角新增 `中 / EN` 切换按钮，全站文案实时响应无需刷新

**集数列表**

- 新增 `EpisodeList.jsx` — 番剧详情页底部显示全部集数（自适应卡片网格）
- 已登录用户：已看集数绿色高亮，当前进度集数紫色高亮（数据来自 `useSubscription`）
- 每集卡片含集数编号 + 已看标记 + 磁链按钮
- `episodes` 为空时显示「集数信息待更新」友好提示

**磁力链接搜索**

- 新增 `TorrentModal.jsx` — 点击每集磁链按钮弹出全屏遮罩 Modal
- 后端 `GET /api/anime/torrents?q=` 请求 Nyaa.si RSS，`fast-xml-parser` 解析 XML，返回标题、磁链、大小、做种数
- 默认搜索词：`{titleEnglish || titleRomaji} + {episode}`；支持用户手动修改后重新搜索

**每集评论**

- 新增 `EpisodeComment` 数据模型（`anilistId + episode + userId + content`，双字段复合索引）
- 新增 REST 接口：`GET/POST /api/comments/:anilistId/:episode`（公开读 / 登录写）、`DELETE /api/comments/:id`（仅本人）
- 新增 `EpisodeComments.jsx` — 点击集数卡片手风琴展开评论区，同时只展开一集
- 已登录：文本框 + 发布按钮；访客：「请登录后参与评论」提示 + 登录跳转链接

**涉及文件：**
- `server/models/EpisodeComment.js`（新增）
- `server/controllers/comment.controller.js`（新增）
- `server/routes/comment.routes.js`（新增）
- `server/index.js`（注册 `/api/comments` 路由）
- `client/src/context/LanguageContext.jsx`（新增）
- `client/src/locales/zh.js` / `en.js`（新增）
- `client/src/components/anime/EpisodeList.jsx`（新增）
- `client/src/components/anime/TorrentModal.jsx`（新增）
- `client/src/components/anime/EpisodeComments.jsx`（新增）
- 全站各组件/页面接入 `t()` 双语支持

---

### · Bangumi 中文标题集成 + bgmId 外链（`feat: integrate Bangumi API for Chinese titles with bgmId linking`）

**中文标题后台富化**

- 新增 `server/services/bangumi.service.js` — 封装 Bangumi API（速率限制 800ms/请求），全局异步富化队列，不阻塞主请求
- `AnimeCache` 模型新增 `titleChinese`（String）、`bgmId`（Number）、`bangumiEnriched`（Boolean）三个字段
- `fetchBangumiData()` 搜索 `bgm.tv` 返回 `{ titleChinese, bgmId }`，优先用日文原名匹配
- `anilist.service.js` 三处调用 `enqueueEnrichment()`：季度预热、搜索结果、详情页懒加载；放送表额外批查 `titleChinese` 并合并

**前端中文标题显示**

- 新增 `pickTitle(obj, lang)` — 中文模式优先级：`titleChinese → titleNative → titleRomaji → titleEnglish`
- 5 个组件（AnimeCard / AnimeDetailHero / HeroCarousel / WeeklySchedule / ContinueWatching）全部切换使用 `pickTitle`

**bgm.tv 外链**

- 番剧详情页 `AnimeDetailHero` 徽章栏新增「在 Bangumi 查看 / View on Bangumi」外链按钮（红色主题，`target="_blank"`）
- 仅在 `bgmId` 非空时渲染，链接至 `https://bgm.tv/subject/{bgmId}`

**涉及文件：**
- `server/models/AnimeCache.js`（新增 3 字段）
- `server/services/bangumi.service.js`（新增）
- `server/services/anilist.service.js`（富化调用 + 放送表 titleChinese 拼接）
- `client/src/utils/formatters.js`（新增 `pickTitle`）
- `client/src/components/anime/AnimeDetailHero.jsx`（bgmId 外链）
- 5 个组件接入 `pickTitle`

---

### · 磁链搜索重构：接入 Anime Garden API + 三栏 UI（`feat: redesign torrent search with Anime Garden API`）

**数据源切换**

- 废弃 Nyaa.si RSS + XML 解析，改用 [Anime Garden API](https://api.animes.garden)（聚合 Nyaa.si + ACG.rip）
- API 直接返回预解析的 `fansub.name` 字段，覆盖 ANi、LoliHouse、SubsPlease 等中文字幕组
- 默认搜索词改为 `{titleRomaji} - {零补位集数}`（如 `Sousou no Frieren - 05`），匹配 Nyaa 命名惯例
- `formatBytes()` 处理 Anime Garden 以 KB 为单位的文件大小，正确转换为 MB/GB

**三栏弹窗重设计**

- 左侧栏：番剧名 + 字幕组过滤列表（自动聚合 + 按数量排序 + 数量 badge + 「全部/All」按钮）
- 中间列表：每条结果显示完整标题（单行省略）、分辨率 badge（1080P/720P）、编码 badge（HEVC/AVC/WEB-DL）、文件大小、日期
- 右侧：番剧封面图
- 复制磁链 ⎘ 按钮（点击变绿 ✓）+ 直接打开磁链 ↗ 按钮（唤起本地 BT 客户端）
- 切换字幕组时列表立即过滤；新搜索完成后自动重置为「全部」

**涉及文件：**
- `server/controllers/anime.controller.js`（重写 `getTorrents`，移除 XML 相关代码）
- `client/src/components/anime/TorrentModal.jsx`（完整重写）
- `client/src/locales/zh.js` / `en.js`（新增 `groupAll`、`openMagnet`、`date` 键）

---

## Git 提交记录

| Hash | 时间 | 说明 |
|------|------|------|
| `feb3ca6` | 2026-03-07 18:26 | Initial project setup: AnimeGo anime website |
| `5e8aa59` | 2026-03-07 18:58 | feat: implement full-stack AnimeGo anime website |
| `800f0ef` | 2026-03-07 19:08 | fix: resolve AniList 429 rate limit with cache-first strategy |
| `083d5ec` | 2026-03-07 19:17 | fix: resolve infinite page refresh loop on startup |
| `f11f453` | 2026-03-07 19:22 | fix: guests see content immediately, no forced login |
| `c459c6a` | 2026-03-08 | fix: cache pagination and rate limit with full season pre-fetch |
| `1585800` | 2026-03-08 | feat: add weekly airing schedule to homepage |
| `8df7df3` | 2026-03-08 | feat: replace homepage grid with top-5 hero carousel |
| `95eaeba` | 2026-03-08 | feat: add continue watching section and weekly grid layout |
| *(pending)* | 2026-03-08 | feat: add i18n, episode list, torrent search and episode comments |
| *(pending)* | 2026-03-08 | feat: integrate Bangumi API for Chinese titles with bgmId linking |
| *(pending)* | 2026-03-08 | feat: redesign torrent search with Anime Garden API |

仓库地址：`https://github.com/lawrenceli0228/animego`
