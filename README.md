# AnimeGo 动漫网站

按季度浏览番剧，支持登录追番和观看记录。访客可浏览所有番剧，登录用户可跟踪观看状态。番剧数据来自 AniList 免费 GraphQL API。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18 + Vite + TanStack Query |
| 后端 | Node.js + Express |
| 数据库 | MongoDB + Mongoose |
| 外部 API | AniList GraphQL（免费，无需 Key）|
| 认证 | JWT（Access + Refresh Token）+ bcrypt |

> 数据库推荐使用 **MongoDB Atlas** 免费套餐（512MB），无需本地安装。

---

## 项目结构

```
animego/
├── package.json                   # Monorepo workspaces
├── .gitignore
├── client/                        # React + Vite SPA
│   ├── package.json
│   ├── vite.config.js             # 代理 /api → localhost:5000
│   ├── index.html
│   ├── .env
│   └── src/
│       ├── main.jsx
│       ├── App.jsx
│       ├── api/
│       │   ├── axiosClient.js     # Bearer token 注入 + 401 自动刷新 + 重定向
│       │   ├── auth.api.js
│       │   ├── anime.api.js
│       │   └── subscription.api.js
│       ├── context/AuthContext.jsx
│       ├── hooks/
│       │   ├── useAnime.js
│       │   └── useSubscription.js
│       ├── pages/
│       │   ├── HomePage.jsx
│       │   ├── SeasonPage.jsx
│       │   ├── AnimeDetailPage.jsx
│       │   ├── SearchPage.jsx
│       │   ├── LoginPage.jsx
│       │   ├── RegisterPage.jsx
│       │   └── ProfilePage.jsx
│       ├── components/
│       │   ├── layout/            # Navbar, Footer, Layout
│       │   ├── anime/             # AnimeCard, AnimeGrid, AnimeDetailHero
│       │   ├── subscription/      # SubscriptionButton, StatusBadge
│       │   ├── season/            # SeasonSelector
│       │   └── common/            # ProtectedRoute, LoadingSpinner, Pagination
│       └── utils/
│           ├── constants.js
│           └── formatters.js
└── server/
    ├── package.json
    ├── .env                       # MONGODB_URI, JWT_SECRET, PORT=5000
    ├── index.js
    ├── config/db.js               # mongoose.connect()
    ├── middleware/
    │   ├── auth.middleware.js
    │   ├── errorHandler.js
    │   └── rateLimiter.js
    ├── models/                    # Mongoose 模型（替代 SQL 表）
    │   ├── User.js
    │   ├── AnimeCache.js
    │   └── Subscription.js
    ├── routes/
    ├── controllers/
    ├── services/
    │   ├── anilist.service.js     # 含缓存刷新逻辑
    │   └── auth.service.js
    └── queries/
        ├── seasonalAnime.graphql.js
        ├── searchAnime.graphql.js
        └── animeDetail.graphql.js
```

---

## 数据模型（Mongoose）

```js
// models/User.js
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  email:    { type: String, required: true, unique: true, lowercase: true },
  password:     { type: String, required: true },  // bcrypt hash
  refreshToken: { type: String, default: null },   // 当前有效的 refreshToken，登出时置 null
}, { timestamps: true })

// models/AnimeCache.js
// 缓存策略：cachedAt 超过 24 小时时，下次请求自动从 AniList 刷新并 upsert
// 可选方案：使用 MongoDB TTL 索引自动清理过期文档
//   animeCacheSchema.index({ cachedAt: 1 }, { expireAfterSeconds: 86400 })
//   当前采用手动检查 + upsert，避免 TTL 删除后短暂数据空窗
const animeCacheSchema = new mongoose.Schema({
  anilistId:      { type: Number, required: true, unique: true },
  titleRomaji:    String,
  titleEnglish:   String,
  titleNative:    String,
  coverImageUrl:  String,
  bannerImageUrl: String,
  description:    String,
  episodes:       Number,
  status:         String,
  season:         String,
  seasonYear:     Number,
  averageScore:   Number,
  genres:         [String],   // 数组原生支持
  format:         String,
  cachedAt:       { type: Date, default: Date.now },
})

// models/Subscription.js
// 观看进度合并在订阅表中，减少冗余
const subscriptionSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  anilistId:      { type: Number, required: true },
  status:         { type: String, enum: ['watching', 'completed', 'plan_to_watch', 'dropped'], required: true },
  currentEpisode: { type: Number, default: 0 },
  lastWatchedAt:  Date,
}, { timestamps: true })

subscriptionSchema.index({ userId: 1, anilistId: 1 }, { unique: true })
```

---

## API 设计

### 统一响应格式

```json
// 成功
{ "data": { ... } }

// 分页
{ "data": [...], "pagination": { "page": 1, "perPage": 20, "total": 100, "totalPages": 5 } }

// 错误
{ "error": { "code": "VALIDATION_ERROR", "message": "用户名已存在" } }
```

### 分页约定

所有支持分页的接口统一使用 `page`（默认 1）和 `perPage`（默认 20，最大 50）参数。

### 请求校验（express-validator）

所有写入接口使用 `express-validator` 做参数校验，校验失败返回 `400 VALIDATION_ERROR`。主要规则：

- **register:** `username`（3-50 字符），`email`（合法邮箱），`password`（6 位以上）
- **login:** `email`（必填），`password`（必填）
- **subscriptions POST:** `anilistId`（正整数），`status`（枚举值之一）
- **subscriptions PATCH:** `status`（可选，枚举值），`currentEpisode`（可选，非负整数）

### 认证 `/api/auth`

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/register` | 注册，返回 `{ accessToken, refreshToken, user }` |
| POST | `/auth/login` | 登录，返回 `{ accessToken, refreshToken, user }` |
| POST | `/auth/refresh` | 刷新 accessToken，传入 `{ refreshToken }` |
| POST | `/auth/logout` | 登出，清除服务端 refreshToken（需 JWT）|
| GET  | `/auth/me` | 获取当前用户（需 JWT）|

> **Token 安全策略：** refreshToken 通过 `httpOnly` cookie 传输（防 XSS），accessToken 存前端内存（不存 localStorage）。登出时服务端将 User.refreshToken 置 null，同时清除 cookie。

### 番剧 `/api/anime`（访客可用）

| 方法 | 路径 | 查询参数 |
|------|------|---------|
| GET  | `/anime/seasonal` | `year`, `season`, `page`, `perPage` |
| GET  | `/anime/search` | `q`, `genre`, `page`, `perPage` |
| GET  | `/anime/:anilistId` | — |

### 订阅 `/api/subscriptions`（需 JWT）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/subscriptions` | 获取当前用户所有订阅（含观看进度）|
| POST | `/subscriptions` | `{ anilistId, status }` 添加订阅 |
| PATCH | `/subscriptions/:anilistId` | `{ status?, currentEpisode? }` 更新状态或进度 |
| DELETE | `/subscriptions/:anilistId` | 删除订阅 |

---

## 页面结构

```
App.jsx
└── QueryClientProvider
    └── AuthContext.Provider
        └── BrowserRouter
            └── Layout（Navbar + Footer）
                ├── /         → HomePage（当前季度番剧）
                ├── /season   → SeasonPage（按年份+季度浏览）
                ├── /anime/:id → AnimeDetailPage
                ├── /search   → SearchPage
                ├── /login    → LoginPage
                ├── /register → RegisterPage
                └── /profile  → ProtectedRoute → ProfilePage
```

---

## 开发启动

```bash
# 安装依赖
npm install

# 启动后端（port 5000）
npm run dev --workspace=server

# 启动前端（port 5173）
npm run dev --workspace=client
```

### 环境变量 `client/.env`

```
VITE_API_BASE_URL=http://localhost:5000/api
```

### 环境变量 `server/.env`

```
MONGODB_URI=mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/animego
JWT_SECRET=your_jwt_secret_here
JWT_REFRESH_SECRET=your_refresh_secret_here
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
PORT=5000
CLIENT_ORIGIN=http://localhost:5173
CACHE_TTL_HOURS=24
```

> MongoDB Atlas 免费套餐：注册 [mongodb.com/atlas](https://mongodb.com/atlas) → 创建集群 → 获取连接字符串填入 `MONGODB_URI`

---

## NPM 依赖

**server:** `express`, `mongoose`, `bcrypt`, `jsonwebtoken`, `cookie-parser`, `cors`, `dotenv`, `express-validator`, `express-rate-limit`, `nodemon`

**client:** `react`, `react-dom`, `react-router-dom`, `axios`, `@tanstack/react-query`, `react-hot-toast`

> 已移除 `node-fetch@2`，Node 18+ 原生支持全局 `fetch`。新增 `cookie-parser` 用于解析 httpOnly cookie 中的 refreshToken。

---

## 实现顺序

1. MongoDB 连接 — `config/db.js` + Mongoose 模型（User / AnimeCache / Subscription）
2. 服务端基础 — Express 入口 + CORS + 错误处理 + Rate Limiter
3. AniList 服务 — `anilist.service.js`（含 24h 缓存刷新逻辑）
4. 认证路由 — register / login / refresh / logout / me
5. 番剧路由 — seasonal / search / detail
6. 订阅路由 — CRUD + 观看进度更新（`findOneAndUpdate` upsert）
7. React 骨架 — 路由 + AuthContext + QueryClient + axiosClient
8. 番剧浏览页面
9. 认证页面
10. 用户功能页面
11. 搜索功能
12. API 集成测试 — 认证、番剧、订阅接口测试
13. 部署配置 — Dockerfile + docker-compose + 生产环境构建
