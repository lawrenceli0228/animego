# AnimeGo

一个全栈动漫浏览与追番网站。访客可浏览所有番剧、查看每周放送表、搜索磁力链接；登录用户可追番、记录观看进度、参与剧集评论。

番剧数据来自 **AniList GraphQL API**（免费，无需 Key），中文标题由 **Bangumi API** 补充，磁力资源聚合自 **Anime Garden**（Nyaa.si + ACG.rip）。

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18 + Vite + TanStack Query + React Router v7 + Axios |
| 后端 | Node.js + Express |
| 数据库 | MongoDB + Mongoose |
| 认证 | JWT（Access Token 15m + Refresh Token 7d）+ bcrypt |
| 外部 API | AniList GraphQL、Bangumi API、Anime Garden |
| 样式 | 纯 CSS，深色影院风格（深海蓝 `#0a0e1a` + 紫色 `#7c3aed` + 青色 `#06b6d4`）|

> 数据库推荐使用 **MongoDB Atlas** 免费套餐（512MB），无需本地安装。

---

## 功能特性

### 访客可用
- **首页**：Top 5 番剧英雄轮播（自动滚动 + 手动控制，Ken Burns 缩放效果）
- **每周放送表**：当前一周各日番剧播出时间一览
- **季度浏览**：按年份 + 季度筛选番剧，支持分页
- **番剧详情**：横幅、评分、简介、剧集数、Bangumi 中文标题及链接
- **剧集列表**：展示全部剧集，支持磁力搜索
- **磁力资源**：通过 Anime Garden 聚合搜索 Nyaa.si 和 ACG.rip 种子，支持字幕组筛选
- **搜索**：全文搜索 + 类型多选过滤
- **中英文切换**：UI 全面国际化，偏好本地持久化

### 登录用户专属
- **追番管理**：添加番剧到追番列表，状态分为「在看 / 完结 / 想看 / 弃坑」
- **观看进度**：记录当前观看至第几集，剧集列表高亮已看内容
- **继续观看**：首页横向滚动卡片，展示正在追的番剧及进度条
- **剧集评论**：按剧集发表评论，支持删除自己的评论

---

## 项目结构

```
animego/
├── package.json                      # Monorepo workspaces ["client", "server"]
│
├── client/                           # React SPA（端口 5173）
│   ├── vite.config.js                # API 代理：/api → localhost:5001
│   └── src/
│       ├── main.jsx                  # 入口：QueryClient + AuthContext + LanguageContext
│       ├── App.jsx                   # 路由配置
│       ├── api/
│       │   ├── axiosClient.js        # Bearer Token 注入 + 401 自动刷新 + auth:expired 事件
│       │   ├── auth.api.js
│       │   ├── anime.api.js
│       │   └── comment.api.js
│       ├── context/
│       │   ├── AuthContext.jsx       # 用户状态、会话持久化
│       │   └── LanguageContext.jsx   # i18n：zh/en 切换，localStorage 持久化
│       ├── hooks/
│       │   ├── useAnime.js           # useSeasonal, useSearch, useAnimeDetail, useSchedule, useTorrents
│       │   ├── useSubscription.js
│       │   └── useComment.js
│       ├── locales/
│       │   ├── zh.js                 # 中文翻译字典
│       │   └── en.js                 # 英文翻译字典
│       ├── pages/
│       │   ├── HomePage.jsx          # 轮播 + 每周放送 + 继续观看
│       │   ├── SeasonPage.jsx        # 季度浏览 + 分页
│       │   ├── AnimeDetailPage.jsx   # 详情 + 剧集列表 + 评论
│       │   ├── SearchPage.jsx
│       │   ├── LoginPage.jsx
│       │   ├── RegisterPage.jsx
│       │   └── ProfilePage.jsx       # 我的追番（分状态标签页）
│       ├── components/
│       │   ├── layout/               # Navbar, Footer, Layout
│       │   ├── anime/
│       │   │   ├── AnimeCard.jsx
│       │   │   ├── AnimeGrid.jsx
│       │   │   ├── AnimeDetailHero.jsx
│       │   │   ├── HeroCarousel.jsx  # 首页英雄轮播
│       │   │   ├── WeeklySchedule.jsx
│       │   │   ├── ContinueWatching.jsx
│       │   │   ├── EpisodeList.jsx
│       │   │   ├── EpisodeComments.jsx
│       │   │   └── TorrentModal.jsx  # 磁力搜索弹窗
│       │   ├── subscription/         # SubscriptionButton, StatusBadge
│       │   ├── search/               # SearchBar
│       │   ├── season/               # SeasonSelector
│       │   └── common/               # ProtectedRoute, LoadingSpinner, Pagination
│       └── utils/
│           ├── constants.js          # SEASON_LABELS, STATUS_OPTIONS, GENRE_OPTIONS
│           └── formatters.js         # pickTitle（语言感知）, formatDate, formatBytes
│
└── server/                           # Express API（端口 5001）
    ├── index.js                      # Express 入口 + CORS + 路由 + warmCurrentSeason()
    ├── config/db.js
    ├── middleware/
    │   ├── auth.middleware.js        # JWT 验证
    │   ├── errorHandler.js
    │   └── rateLimiter.js            # 100 请求 / 15 分钟 / IP
    ├── models/
    │   ├── User.js
    │   ├── AnimeCache.js             # AniList + Bangumi 数据缓存，TTL 24h
    │   ├── Subscription.js           # 追番状态 + 观看进度
    │   └── EpisodeComment.js
    ├── routes/ & controllers/        # 路由与控制器
    ├── services/
    │   ├── anilist.service.js        # AniList 查询 + MongoDB 缓存 + 缓存预热
    │   ├── bangumi.service.js        # 异步补充中文标题（后台队列，不阻塞主请求）
    │   └── auth.service.js
    └── queries/                      # AniList GraphQL 查询语句
```

---

## 数据模型（Mongoose）

```js
// User.js
{
  username: String,       // unique
  email: String,          // unique, lowercase
  password: String,       // bcrypt hash
  refreshToken: String,   // 登出时置 null
}

// AnimeCache.js — AniList + Bangumi 合并缓存，24h TTL
{
  anilistId: Number,      // unique
  titleRomaji: String,
  titleEnglish: String,
  titleNative: String,    // 日文原名
  titleChinese: String,   // Bangumi 中文标题
  bgmId: Number,          // Bangumi ID，用于构造 bangumi.tv 链接
  coverImageUrl: String,
  bannerImageUrl: String,
  description: String,
  episodes: Number,
  status: String,
  season: String,
  seasonYear: Number,
  averageScore: Number,
  genres: [String],
  format: String,
  cachedAt: Date,
}

// Subscription.js — 追番进度合并在同一张表中
{
  userId: ObjectId,
  anilistId: Number,
  status: 'watching' | 'completed' | 'plan_to_watch' | 'dropped',
  currentEpisode: Number,
  lastWatchedAt: Date,
}
// 索引：{ userId, anilistId }（唯一）

// EpisodeComment.js
{
  anilistId: Number,
  episode: Number,
  userId: ObjectId,
  username: String,       // 冗余存储，避免 join 查询
  content: String,
}
// 索引：{ anilistId, episode }
```

---

## API 端点

### 统一响应格式

```json
{ "data": { ... } }
{ "data": [...], "pagination": { "page": 1, "perPage": 20, "total": 100, "totalPages": 5 } }
{ "error": { "code": "VALIDATION_ERROR", "message": "..." } }
```

### 认证 `/api/auth`

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/register` | 注册，返回 `{ accessToken, user }` |
| POST | `/auth/login` | 登录，返回 `{ accessToken, user }` |
| POST | `/auth/refresh` | 通过 httpOnly Cookie 中的 refreshToken 换取新 accessToken |
| POST | `/auth/logout` | 清除服务端 refreshToken 及 Cookie |
| GET  | `/auth/me` | 获取当前用户信息（需 JWT）|

> **Token 策略：** refreshToken 存于 `httpOnly` Cookie（防 XSS），accessToken 仅保存在前端内存（不写 localStorage）。

### 番剧 `/api/anime`（访客可用）

| 方法 | 路径 | 参数 |
|------|------|------|
| GET | `/anime/seasonal` | `year`, `season`, `page`, `perPage` |
| GET | `/anime/search` | `q`, `genre`, `page`, `perPage` |
| GET | `/anime/schedule` | — |
| GET | `/anime/:anilistId` | — |
| GET | `/anime/torrents` | `q`, `episode` |

### 追番 `/api/subscriptions`（需 JWT）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/subscriptions` | 获取当前用户所有追番记录 |
| POST | `/subscriptions` | `{ anilistId, status }` |
| PATCH | `/subscriptions/:anilistId` | `{ status?, currentEpisode? }` |
| DELETE | `/subscriptions/:anilistId` | 取消追番 |

### 评论 `/api/comments`（读取访客可用，写入需 JWT）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/comments/:anilistId/:episode` | 获取该集评论 |
| POST | `/comments/:anilistId/:episode` | 发表评论（需 JWT）|
| DELETE | `/comments/:id` | 删除自己的评论（需 JWT）|

---

## 缓存与限流策略

- **缓存预热**：服务端启动时自动调用 `warmCurrentSeason()`，将当前季度全部番剧写入 MongoDB，避免首次请求触发 AniList 限流
- **请求节流**：AniList 出站查询间隔 ≥ 700ms，防止触发 429
- **缓存 TTL**：AnimeCache 手动检查时间戳，超 24h 时下次请求自动从 AniList 刷新并 upsert
- **Bangumi 异步队列**：中文标题在后台异步补充，不阻塞番剧主请求
- **API 限流**：所有 `/api` 路由限流 100 请求 / 15 分钟 / IP

---

## 开发启动

### 前置条件

- Node.js 18+（原生支持全局 `fetch`）
- [MongoDB Atlas](https://mongodb.com/atlas) 免费账户

### 安装与启动

```bash
# 安装所有依赖（client + server）
npm install

# 终端 1：启动后端（端口 5001）
npm run dev --workspace=server

# 终端 2：启动前端（端口 5173）
npm run dev --workspace=client
```

访问 `http://localhost:5173`

### 环境变量

**`server/.env`**

```
MONGODB_URI=mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/animego
JWT_SECRET=your_jwt_secret_here
JWT_REFRESH_SECRET=your_refresh_secret_here
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
PORT=5001
CLIENT_ORIGIN=http://localhost:5173
CACHE_TTL_HOURS=24
```

**`client/.env`**

```
VITE_API_BASE_URL=
```

> 前端留空即可，Vite 开发服务器通过代理将 `/api` 转发至 `localhost:5001`。

---

## 页面路由

```
/              → 首页（轮播 + 每周放送 + 继续观看）
/season        → 季度番剧列表
/anime/:id     → 番剧详情（剧集 + 评论）
/search        → 搜索
/login         → 登录
/register      → 注册
/profile       → 我的追番（需登录）
```

---

## NPM 依赖

**server:** `express`, `mongoose`, `bcrypt`, `jsonwebtoken`, `cookie-parser`, `cors`, `dotenv`, `express-validator`, `express-rate-limit`, `fast-xml-parser`, `nodemon`

**client:** `react`, `react-dom`, `react-router-dom`, `axios`, `@tanstack/react-query`, `react-hot-toast`
