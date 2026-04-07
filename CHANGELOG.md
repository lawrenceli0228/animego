# AnimeGo 开发日志

---

## [0.5.0] - 2026-04-07

### 首页内容丰富化

**新增区块：**
- **经典好番推荐 (Completed Gems)** — Bilibili「猜你喜欢」风格，5 列网格，封面全铺 + 底部渐变遮罩叠加标题/类型/评分，"换一批"按钮随机刷新
  - `GET /api/anime/completed-gems?limit=6` — MongoDB `$sample` 随机采样高分完结番（≥75 分）
- **年度评分排行榜 (Yearly Rankings)** — Editorial 紧凑列表，Top 10 按评分降序，Top 3 金色排名数字
  - `GET /api/anime/yearly-top?year=2026&limit=10` — 查 AnimeCache 全年 TV/MOVIE/ONA 按评分排序

**视觉统一：**
- `AnimeGrid` 从 `auto-fill minmax(160px)` 改为固定 5 列网格（900px→3 列，600px→2 列），季度页/搜索页同步生效

**UX 改进：**
- 路由切换自动滚顶 — `ScrollToTop` 组件监听 `pathname` 变化调用 `window.scrollTo(0, 0)`

**首页排列顺序调整：**
Hero → 热追 → 我的在追 → 本周更新 → 经典好番 → 关注动态 → 年度榜

**已创建后删除的功能（代码已清理）：**
- 类型精选 (Genre Spotlight) — 硬编码类型列表不够灵活，待改为动态热门类型后重做
- 制作公司精选 (Studio Spotlight) — 封面比例问题 + 偏高级功能，延后

---

## [0.4.0] - 2026-04-07

### Bug 修复

- **Shimmer 骨架屏动画不可见** — `@keyframes shimmer` 动画 `background-position` 对纯色背景无效，6 处骨架屏全部改为渐变背景 + `backgroundSize: '200% 100%'`（`AnimeDetailHero`, `EpisodeList`, `TrendingSection`, `ActivityFeed`）

### 代码质量

- **Follow controller DRY 重构** — `getFollowers`/`getFollowing` 提取公共函数 `paginateFollows`，消除重复逻辑
- **AnimeDetailHero 样式重构** — 30+ 内联样式提取到模块级 `S` 常量对象，提升可读性
- **新增骨架屏单元测试** — `AnimeDetailHero.test.jsx` 6 个测试覆盖中英文模式、富化中/完成/未富化场景

### 新功能：管理后台

**RBAC 基础设施：**
- `User.role` 字段（enum: `'admin'` / `null`）
- JWT 三路径（register/login/refresh）携带 role 到 accessToken
- `adminAuth` 中间件，非管理员返回 403

**仪表盘概览（`GET /api/admin/stats`）：**
- 8 路并行 `countDocuments` 汇总：用户数、番剧数、追番记录、关注关系、待审查数
- 富化进度条可视化（v0/v1/v2 占比）

**富化管理：**
- `GET /api/admin/enrichment` — 分页列表 + 4 种筛选（全部/需审查/已修正/未富化）+ 搜索（数字匹配 anilistId，文本匹配三语标题）
- `POST /api/admin/enrichment/:id/reset` — 重置 bangumiVersion=0，清除富化字段，优先重新入队
- `POST /api/admin/enrichment/:id/flag` — 设置/清除 adminFlag（needs-review / manually-corrected / null）
- `AnimeCache.adminFlag` 字段 + 索引

**用户管理（CRUD）：**
- `POST /api/admin/users` — 创建用户，用户名/邮箱重复检测返回 409
- `PATCH /api/admin/users/:id` — 编辑用户名/邮箱，重复检测
- `DELETE /api/admin/users/:id` — 删除用户 + 级联清理（Subscription + Follow），禁止自删
- `GET /api/admin/users` — 分页列表 + 搜索 + MongoDB aggregate 批量统计追番数/粉丝数

**前端：**
- `AdminDashboard.jsx` — 三板块 UI：仪表盘概览 / 富化管理（搜索+筛选+分页表格） / 用户管理（创建表单+行内编辑+两步确认删除）
- Navbar 管理员入口（仅 `role === 'admin'` 可见）
- 中英文本地化 ~70 个 key

**测试：**
- `admin.controller.test.js` — 22 个测试覆盖：adminAuth 403、stats、enrichment list/filter/search/reset/flag、user list/create/update/delete/self-delete-prevention/duplicate-detection
- 服务端 124 tests、客户端 95 tests 全部通过

### 提交记录

| Hash | 描述 |
|------|------|
| `f88dcb7` | fix: repair shimmer animations and refactor follow controller + detail hero |
| `af4b41c` | feat: add admin dashboard with enrichment management and user CRUD |

---

## [0.3.0.0] - 2026-04-05

### 方向决策（CEO Review + Office Hours）

- **产品方向待验证** — Phase 1-4 功能完整但零真实用户。通过 CEO Review 确认：在没有用户数据前不做新功能开发，先验证需求
- **核心假设重新定义** — 创始人自我审视后认为产品核心不是"社交平台"，而是"观影伴侣"：看完一集后轻量参与的情绪价值（类似 B 站弹幕体验）
- **dandanplay 集成方向** — dandanplay 有播放+弹幕但无社区，AnimeGo 有社区但无播放。组合可能是差异化方向，决定做独立 PoC 验证

### 计划：10 人验证 + dandanplay PoC

**验证期（2 周）：**
1. 部署现有 Phase 1-4 到 Railway 生产环境
2. 招募 10 个追番朋友实际使用，观察留存和行为
3. dandanplay API 申请 + 独立 HTML PoC（本地视频播放 + 弹幕匹配）
4. 收集反馈数据，决定下一步方向（追番社区 vs 看番平台）

**Pre-deploy checklist：**
- `server/.env` 生产配置（独立 JWT_SECRET、MongoDB Atlas URI）
- `app.set('trust proxy', 1)`（Railway 反向代理 TLS 终止必需，否则 secure cookie 不生效）
- httpOnly cookie secure 标志 + HTTPS
- Express morgan 生产日志开启
- 不开启 Railway autoscaling（单实例 Socket.IO，10 人规模）

**成功标准：** ≥30% 留存（第二周仍在使用）、≥5 条功能反馈、dandanplay API 可行性确认

**失败预案：** 留存不达标 → 转向 dandanplay 集成方向（需独立验证）

### 设计文档

- Office Hours 设计文档：`~/.gstack/projects/.../lawrence_li-feat-community-phase4-design-20260405-121020.md`
- CEO Plan：`~/.gstack/projects/.../ceo-plans/2026-04-05-validation-direction.md`
- 审查评分：设计文档 8/10（2 轮对抗性审查）、Outside Voice 发现 6 个问题（trust proxy 已修复）

---

## [0.2.2.0] - 2026-04-03

 ### Changed
  - **角色 & 配音演员名固定显示日文** — `CharacterSection` 移除语言适配逻辑，`nameJa`/`voiceActorJa` 始终优先，不再因语言设置切换为中文名
  - **Bangumi 标题匹配精确化** — `fetchBangumiData` 从 `list[0]` 改为在最多 5 条结果中寻找 `name === titleNative` 的精确匹配；仅精确命中时才写入
  `titleChinese`，非精确匹配仍保留 `bgmId` 但不写中文标题，避免续集 OVA 等变体污染正片翻译


### Fixed
- **bgmId 为 null 时客户端无限轮询** — Phase 1-3 搜索不到番剧时（新番未被 Bangumi 收录），原来写 `bangumiVersion: 1`，Phase 4 因 `!bgmId` 跳过，`bangumiVersion` 永远停在 1，客户端每 4 秒轮询死锁。现在直接写 `bangumiVersion: 2, episodeTitles: []` 标记完成
- **历史卡记录自愈** — `getAnimeDetail` 缓存命中时检测 `bangumiVersion === 1 && !bgmId` 的残留记录，自动推进到 version 2，无需重启或手动干预

### Performance
- **详情页秒开（placeholderData）** — `useAnimeDetail` 新增 `placeholderData`，优先从 seasonal/trending/search 的 React Query 缓存中查找该番数据；有 placeholder 时 `isLoading = false`，从列表点进详情页立刻渲染，无 loading spinner
- **富化优先队列** — `bangumi.service.js` 为 Phase 1-3 和 Phase 4 各增加 `enrichPriority` 数组；`enqueueEnrichment(items, priority)` 和 `enqueuePhase4Enrichment(items, priority)` 支持 `priority` 参数；`getAnimeDetail` 调用时传 `priority = true`，用户主动点击的番剧从队尾插到队首，等待时间从 60s+ 降至 ≤800ms；Phase 1-3 的 priority 项完成后，Phase 4 继承 priority

---

## [0.2.1.0] - 2026-04-02

### Fixed
- **历史季度中文标题缺失** — `getSeasonalAnime()` 路径③（部分缓存）和路径④（冷启动）新增 `enqueueEnrichment()` 调用，历史季度番剧现在在首次访问后会触发 Bangumi 富化
- **第一页中文标题不更新** — `useSeasonalAnime` 新增条件轮询（`refetchInterval: 20s`），当页面中存在 `bangumiEnriched: false/undefined` 的条目时自动轮询，富化完成后无需手动刷新即可看到中文标题，全部富化完成后自动停止轮询

### Changed
- `useSeasonalAnime` `staleTime` 从 5 分钟缩短为 1 分钟，确保富化完成后下次访问能及时拿到中文数据
- `SeasonPage` `AnimeGrid` 添加 `key={dataUpdatedAt}`，季度切换时新数据到达触发 `fadeUp` 动画，所有卡片同时出现而非逐个替换

---

## [0.2.0.0] - 2026-04-02

### Added
- **社区 Phase 1：趋势发现** — `GET /api/anime/trending` 热追排行榜（订阅数聚合，1h 内存缓存）；`GET /api/anime/:anilistId/watchers` 在看用户头像列表
- **社区 Phase 2：社交图谱** — 单向关注系统（`POST/DELETE /api/users/:username/follow`）；公开个人主页 `/u/:username`；关注者/关注列表；好友动态 Feed（`GET /api/feed`）
- **社区 Phase 3：实时弹幕** — WebSocket（socket.io）弹幕系统，按 `anilistId:episode` 隔离房间；`EpisodeWindow` 集合原子化首播窗口（`$setOnInsert` 消除竞态）；1 条/5s 用户级内存限流；JWT Handshake + 每事件重验（`TokenExpiredError` 精准识别）
- **iOS Blue 设计系统** — `#0a84ff` 替换全站紫色系；Apple True Black 三层背景（`#000000 → #1c1c1e → #2c2c2e`）；DESIGN.md 设计规范文档
- **WCAG 触控区域修复** — 弹幕颜色、语言切换按钮、轮播圆点、日期筛选标签均 ≥44px
- **磁力搜索重设计** — 入口迁至番剧详情页，三源并发（动漫花园 + acg.rip + Nyaa），集数筛选器，字幕组识别
- **测试基础设施** — Vitest（client）+ Jest+Supertest（server）；新增 17 个测试文件，共 81 条用例（ActivityFeed、FollowButton、danmaku.controller、follow.controller、profile.controller 等）
- `TrendingSection` 组件（首页横向卡片）；`WatchersAvatarList` 组件（番剧详情页）；`FollowButton`；`ActivityFeed`；`DanmakuOverlay`；`DanmakuInput`；`DanmakuSection`；`UserProfilePage`；`FollowListPage`
- `Danmaku` 模型（含 1 年 TTL 自动清理索引）；`EpisodeWindow` 模型；`Follow` 模型
- i18n：新增 `social.*`、`danmaku.*` 键组（中英双语）
- `useDanmaku`、`useSocial` hooks；`social.api.js`、`danmaku.api.js`
- CLAUDE.md 架构文档；docs/designs/community-platform-v2.md 设计决策记录

### Fixed
- `danmaku:join` 移入 `socket.on('connect', …)` 回调，修复重连后房间订阅丢失
- `follow.controller.js` 自关注检测改用 `ObjectId.equals()`，修复字符串与 ObjectId 比较误判
- `comment.controller` 内容长度校验改为 `content.trim().length`，修复含尾随空格内容被误拒（400）
- 弹幕 `lastSent` Map 添加 10k 上限防内存无限增长；`danmaku:join` 加参数校验 + 10 房间上限
- 弹幕历史接口加 500 条上限并倒序取最近（`.sort(-1).limit(500).then(reverse)`）
- `torrentCache` LRU 500 条上限；查询长度上限 200 字符防缓存投毒；RSS `magnet:` 协议校验
- `useFeed` 添加 `enabled: !!user` 防止未登录时发起请求
- `useSubscription` 静默处理 404（未订阅用户不抛错）
- `AuthContext` 使用 `useRef` 防止 React 18 StrictMode 下双重初始化
- `FollowButton` 关注/取消关注后显示 toast 反馈；`minWidth: 88px` 防按钮宽度抖动
- `ActivityFeed` 未登录时隐藏；空动态时显示友好提示文案
- `profile.controller.getProfile` 订阅列表上限 200 条；`getFeed` 关注列表上限 500 条

### Changed
- `server/index.js` 改用 `http.createServer` + `server.listen`，Socket.IO 绑定同端口
- 全站 success 色从 `#34d399` 统一为 Apple `#30d158`；次要文字从 `#475569` 统一为 `rgba(235,235,245,0.30)`
- `DanmakuSection` 标签色改用 teal `#5ac8fa`（符合 DESIGN.md 弹幕分区规范）
- `SeasonSelector` / `ProfilePage` tab 背景从 `rgba(26,34,53,0.8)` 统一为 `#1c1c1e`

---

## [0.1.5.0] - 2026-03-28

### Added
- **测试覆盖扩充** — 新增 5 个测试套件（48 → 48 个用例）：`EpisodeList` 高亮边界条件（6）、`LanguageContext` 回退行为（4）、`TrendingSection` 状态（4）、`WatchersAvatarList` 显示逻辑（5）、`comment.controller` 权限与内容校验（7）
- `UserProfilePage` 番剧列表"显示更多"分页（默认 12 部）
- `test/setup.js` 添加 `localStorage` mock，解决 jsdom 环境下 `LanguageContext` 语言初始化问题

### Fixed
- `UserProfilePage` `ShareButton`：`navigator.clipboard.writeText` 现在有 try/catch，剪贴板权限被拒时弹出错误 toast 而非静默失败
- `DanmakuInput` `handleSend()` 添加 `!connected` 防卫，修复通过 form 提交绕过 disabled 按钮的边界情况
- `comment.controller` 内容长度校验改为 `content.trim().length`，修复含尾随空格的合法内容被误拒（400）问题
- `UserProfilePage` `expanded` 状态在切换用户时（路由参数变化）正确重置
- `LanguageContext.test` 每个用例前清空 `localStorage`，防止测试间语言状态泄漏
- `test/setup.js` localStorage mock 添加 `configurable: true`，避免多线程测试池下重定义报错
- `UserProfilePage` 补充缺失的 `useState`/`useEffect` React 导入
- `zh.js`/`en.js` 新增 `detail.linkCopyFailed` 翻译 key

---

## [0.1.4.0] - 2026-03-28

### Added
- **磁力搜索重设计** — 入口从全局搜索迁移至番剧详情页，支持集数筛选器（全部/01/02…），字幕组识别从标题方括号提取
- `GET /api/anime/torrents` 新增第三方源：动漫花园（dmhy）+ Nyaa.si，三源并发 `Promise.allSettled`，任一失败不影响其他结果
- **iOS Blue 设计系统** — 全站 `#0a84ff` 替换紫色系，Apple True Black 三层背景（`#000000 → #1c1c1e → #2c2c2e`）
- WCAG 触控区域修复：弹幕颜色、语言切换按钮、轮播圆点、日期筛选标签均≥44px

### Fixed
- `danmaku:join` 事件移入 `socket.on('connect', …)` 回调，修复重连后房间订阅丢失问题
- `follow.controller.js` 自关注检测改用 `ObjectId.equals()`，修复字符串与 ObjectId 比较误判
- 弹幕 `lastSent` Map 添加 10k 上限防内存无限增长；新增 `username` 非空校验
- `torrentCache` 增加 500 条上限 LRU 淘汰；查询长度上限 200 字符防缓存投毒
- RSS `magnet:` 协议校验（acg.rip + Nyaa），阻断 `javascript:` / `data:` URI 注入
- followers/following 路由注册补全

### Changed
- **弹幕 `liveEndsAt` 竞态修复** — 引入 `EpisodeWindow` 集合（唯一索引 `{anilistId, episode}`），用 `findOneAndUpdate + $setOnInsert` 原子化首播窗口创建，消除并发首条弹幕竞态
- **Socket JWT 过期断连** — `socket.use()` 每事件重验 JWT，过期时 emit `auth:expired` 并断开连接；客户端监听后触发统一登出流程
- `danmaku.controller.js` `liveEndsAt` 改从 `EpisodeWindow` 读取，历史弹幕不再携带冗余字段

---

## [0.1.3.0] - 2026-03-25

### Added
- **社区 Phase 3：实时弹幕** — WebSocket（socket.io）弹幕系统，按番剧+剧集隔离房间
- `Danmaku` model：`{ anilistId, episode, userId, username, content, liveEndsAt }`，含 `(anilistId, episode, createdAt)` 复合索引
- `socketAuth` 中间件：JWT Handshake 验证，连接时附加 `socket.user`
- `danmaku.handler.js`：`danmaku:join/leave/send` 事件处理，1条/5秒用户级内存限流，2小时首播窗口（`liveEndsAt`）
- `GET /api/danmaku/:anilistId/:episode`：HTTP 历史弹幕接口，返回弹幕列表 + `liveEndsAt`
- `DanmakuOverlay` 组件：4 条泳道飞行弹幕，CSS `right→left` 动画，自动清理已播完元素
- `DanmakuInput` 组件：50字上限，字符计数器，WebSocket 连接状态指示灯（绿/灰）
- `DanmakuSection` 组件：HTTP 历史 + 实时消息合并去重，LIVE 绿色徽章，首播窗口关闭后显示只读提示
- `useDanmaku` hook：`useDanmakuHistory`（TanStack Query）+ `useDanmakuSocket`（socket.io-client）
- i18n：新增 `danmaku.*` 键组（中英文）
- `server/index.js`：改用 `http.createServer` + socket.io 绑定同端口
- `EpisodeList`：剧集展开面板顶部插入 `DanmakuSection`，评论区保留在下方

### Changed
- `server/index.js`：`app.listen` → `http.createServer(app)` + `server.listen`

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
