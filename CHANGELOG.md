# AnimeGo 开发日志

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

仓库地址：`https://github.com/lawrenceli0228/animego`
