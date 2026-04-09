[English](README.md) | **中文**

# AnimeGo

全栈动漫追番与发现平台。浏览每季新番、管理追番列表、发送弹幕评论、与其他番友互动。

**在线访问：** [animegoclub.com](https://animegoclub.com)

番剧数据来自 [AniList GraphQL API](https://anilist.gitbook.io/anilist-apiv2-docs/)（免费，无需 Key）。中文标题与评分由 [Bangumi API](https://bangumi.github.io/api/) 补充。

---

## 功能特性

### 浏览与发现
- **季度新番** — 按类型、格式、状态筛选，按评分/标题/格式排序
- **热门排行** — 按订阅数排名的热门番剧
- **每周放送** — 当季番剧播出时间一览
- **搜索** — 全文搜索 + 类型筛选
- **番剧详情** — 横幅、评分、简介、角色、制作人员、关联作品、推荐
- **分集标题** — 来自 Bangumi，续集自动偏移归一化

### 追番与观看
- **追番系统** — 在看 / 已完结 / 想看 / 弃坑
- **观看进度** — 记录当前集数，已看集数高亮
- **继续观看** — 首页展示正在追的番剧及进度条
- **磁力搜索** — 聚合 ACG.rip RSS 磁力链接，支持字幕组筛选

### 社区
- **弹幕** — 基于 Socket.IO 的实时弹幕系统
- **剧集评论** — 按集评论，支持回复和点赞
- **关注系统** — 关注其他用户，在动态中查看他们的追番更新
- **公开主页** — `/u/:username` 展示追番列表和粉丝/关注数
- **好友动态** — 已关注用户的最新追番更新
- **分享** — Web Share API + 剪贴板回退

### SEO 与社交
- **动态站点地图** — 从数据库自动生成，1 小时缓存
- **OG 标签** — 服务端为社交爬虫和搜索引擎返回 meta 标签
- **动态页面标题** — 每个页面的 `document.title` 支持中英文
- **Google Search Console** 已验证

### 管理后台
- **富化监控** — 实时显示 Phase 1-3、Phase 4、V3 队列状态
- **内联编辑** — 直接编辑中文标题和 Bangumi ID
- **V3 自愈** — 批量修复缺失的中文标题，带进度条、暂停/继续
- **用户管理** — 查看注册用户和活动

### 国际化
- 完整中英文 UI — 一键切换，偏好持久化
- `pickTitle()` 根据当前语言选择最佳标题

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 · Vite · TanStack Query v5 · React Router v7 |
| 后端 | Node.js · Express · Socket.IO |
| 数据库 | MongoDB · Mongoose |
| 认证 | JWT（access 15m + refresh 7d）· bcrypt · httpOnly Cookie |
| 外部 API | AniList GraphQL · Bangumi API · ACG.rip RSS |
| 部署 | Docker Compose · Nginx 反向代理 |
| SEO | 动态站点地图 · OG 标签 · robots.txt |

---

## 快速开始

### 前置条件

- Node.js 20+
- MongoDB（本地或 [MongoDB Atlas](https://mongodb.com/atlas) 免费版）

### 安装与启动

```bash
# 安装依赖
npm install

# 终端 1：启动后端（端口 5001）
npm run dev:server

# 终端 2：启动前端（端口 5173）
npm run dev:client
```

访问 `http://localhost:5173`

### 环境变量

**`server/.env`**

```env
MONGODB_URI=mongodb+srv://...
JWT_SECRET=your_jwt_secret
JWT_REFRESH_SECRET=your_refresh_secret
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
PORT=5001
CLIENT_ORIGIN=http://localhost:5173
CACHE_TTL_HOURS=24
```

**`client/.env`**

```env
VITE_API_BASE_URL=
```

> 开发环境留空即可，Vite 会将 `/api` 代理到 `localhost:5001`。

---

## Docker 部署

```bash
docker compose up -d --build
```

服务：`app`（Node.js）· `mongodb`（Mongo 7）· `nginx`（反向代理 + SSL）

---

## 架构

```
客户端 (React SPA)
  ↓ /api/*
Express API → 控制器 → 服务层
  ↓                       ↓
MongoDB（缓存 + 用户数据） AniList GraphQL API
                            ↓（后台异步）
                           Bangumi API（中文标题、评分、角色、分集）
                            ↓（实时）
                           Socket.IO（弹幕）
```

### 数据管道

1. **AniList 请求** — 季度/搜索/详情查询，700ms 节流
2. **MongoDB 缓存** — 24h TTL，过期自动刷新
3. **Bangumi 富化** — 4 阶段后台管道：
   - Phase 1-3：关键词搜索 → `titleChinese` + `bgmId`
   - Phase 4：评分、角色中文名、分集标题
   - V3：通过 `bgmId` 直接查询修复缺失的中文标题
4. **优先队列** — 用户请求的番剧插队到队首
5. **缓存预热** — 服务启动时预填充当季番剧

### 认证流程

- `accessToken` 仅存于 React 内存（不写 localStorage）
- `refreshToken` 存于 httpOnly Cookie
- Axios 拦截器自动处理 401 → 刷新 → 重试
- `auth:expired` 事件触发登出

---

## API 端点

统一响应格式：`{ data }` · `{ data, pagination }` · `{ error: { code, message } }`

| 路由 | 说明 |
|------|------|
| `POST /api/auth/register` | 注册 |
| `POST /api/auth/login` | 登录 |
| `POST /api/auth/refresh` | 刷新 Token |
| `POST /api/auth/logout` | 登出 |
| `GET /api/auth/me` | 当前用户 |
| `GET /api/anime/seasonal` | 季度番剧 |
| `GET /api/anime/search` | 搜索 |
| `GET /api/anime/schedule` | 每周放送 |
| `GET /api/anime/trending` | 热门排行 |
| `GET /api/anime/:id` | 番剧详情 |
| `GET /api/anime/:id/watchers` | 在看用户 |
| `GET /api/anime/torrents` | 磁力搜索 |
| `GET/POST/PATCH/DELETE /api/subscriptions` | 追番 CRUD |
| `GET/POST/DELETE /api/comments` | 剧集评论 |
| `GET/POST/DELETE /api/users/:username/follow` | 关注系统 |
| `GET /api/feed` | 好友动态 |
| `WS /` | Socket.IO — 弹幕事件 |

速率限制：所有 `/api` 路由 100 请求 / 15 分钟 / IP。

---

## 测试

```bash
# 客户端测试（Vitest + jsdom）
npm run test --workspace=client

# 服务端测试（Jest）
npm run test --workspace=server
```

---

## 许可证

MIT
