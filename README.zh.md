[English](README.md) | **中文**

# AnimeGo

全栈动漫追番、发现与本地播放平台。浏览每季新番、管理追番列表、本地视频文件匹配弹幕播放、与其他番友互动。

**在线访问：** [animegoclub.com](https://animegoclub.com)

---

## 项目状态

**状态：** 全栈重构中 — 迁移到 Next.js 14 + TypeScript
**重构启动：** 2026-05-10(基于 v2.0.0)
**构建方式：** Claude Code 辅助开发(产品方向、决策、部署由作者负责)

### 当前重构
代码库正从 Vite SPA + Express 迁移到全栈 Next.js + TypeScript。目标:
- 在 SEO 关键路由(`/anime/:id`、`/seasonal`、`/search`)启用服务端渲染
- 客户端与 API 端到端类型安全
- 单一运行时部署(Next.js standalone)
- 89+ Express endpoint 迁移到 Next API routes

线上 [animegoclub.com](https://animegoclub.com) 在重构期间继续跑 v2.0.x 的 Vite SPA 构建。迁移分阶段计划见 `docs/migration/`。

### 已知限制(有意为之,非 bug)
- **弹幕匹配** — 不追求 100% 准确率,冷门续作用手动选集兜底。原因见 project memory `feedback_danmaku_matching`(明确不接 LLM/AI 匹配)。
- **Bangumi 富化** — 后台管道,新番可能需要一个周期才出现中文标题/评分。
- **单实例 WebSocket** — Socket.IO 弹幕未接 Redis adapter,横向扩容需补(见 TODO.md 待办五)。
- **无用户隐私开关** — `/u/:username` 追番页当前阶段默认公开(见 TODO.md 待办四)。

### 本地开发
1. 读本 README + [CHANGELOG.md](CHANGELOG.md)(最近 2-3 条即可还原当前心智模型)。
2. 读 [TODO.md](TODO.md) 了解有意推迟的事项。
3. `npm install && npm run dev:server` + `npm run dev:client` — 本地能跑起来即可。
4. SSH 到 VPS,`docker compose ps` — 确认生产正常。
5. 动 UI 前先读 [DESIGN.md](DESIGN.md)。

---

## 功能特性

### 浏览与发现
- **季度新番** — 按类型、格式、状态筛选，按评分/标题/格式排序
- **热门排行** — 按订阅数排名的热门番剧
- **年度榜单** — 当年最高评分番剧
- **完结佳作** — 高分完结作品推荐，支持刷新
- **每周放送** — 当季番剧播出时间一览
- **搜索** — 全文搜索 + 类型筛选
- **番剧详情** — 横幅、双评分（AniList + Bangumi）、简介、角色、制作人员、关联作品、推荐
- **分集标题** — 来自 Bangumi，续集自动偏移归一化

### 追番与观看
- **追番系统** — 在看 / 已完结 / 想看 / 弃坑
- **观看进度** — 记录当前集数，已看集数高亮
- **继续观看** — 首页展示正在追的番剧及进度条
- **磁力搜索** — 聚合 ACG.rip RSS 磁力链接，支持字幕组筛选

### 本地播放器 + 弹幕
- **拖放即播** — 拖入番剧文件夹或选择视频文件（MKV、MP4、AVI、WebM）
- **自动弹幕匹配** — 通过弹弹Play API 进行文件 hash + 文件名匹配，多阶段降级（hash 匹配 -> 关键词匹配 -> 逐文件匹配）
- **MKV 内嵌字幕提取** — 浏览器端 Web Worker 提取 ASS/SSA/SRT 字幕，自动转换为 VTT 显示
- **逐集弹幕选择器** — 每一集可手动设置或更换弹幕源；支持在弹弹Play 上搜索任意番剧并选择对应集数
- **无阻塞播放** — 视频立即播放，字幕和弹幕在后台异步加载
- **集数导航** — 无需退出播放器即可切换集数

### 社区
- **弹幕** — 基于 Socket.IO 的实时弹幕系统
- **剧集评论** — 按集评论，支持回复和点赞
- **关注系统** — 关注其他用户，在动态中查看他们的追番更新
- **公开主页** — `/u/:username` 展示追番列表、观看统计和粉丝/关注数
- **好友动态** — 已关注用户的最新追番更新
- **分享** — Web Share API + 剪贴板回退

### SEO 与社交
- **服务端渲染元数据** — 完整爬虫 HTML，含结构化数据（JSON-LD）、OG 标签、面包屑
- **动态站点地图** — 从数据库自动生成，按评分排序，动态优先级
- **内容丰富** — 番剧详情页包含角色、制作人员、关联作品，利于搜索引擎收录
- **Google Search Console** 已验证

### 管理后台
- **富化监控** — 实时显示 Phase 1-3、Phase 4、V3 队列状态
- **内联编辑** — 直接编辑中文标题和 Bangumi ID
- **V3 自愈** — 批量修复缺失的中文标题，带进度条、暂停/继续
- **用户管理** — 创建、编辑、删除用户；查看订阅和粉丝

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
| 播放器 | Artplayer · JASSUB（ASS 字幕）· Web Workers（MD5 hash、MKV 解析） |
| 外部 API | AniList GraphQL · Bangumi API · 弹弹Play API · ACG.rip RSS |
| 部署 | Docker Compose · Nginx 反向代理 · SSL |
| SEO | 动态站点地图 · JSON-LD 结构化数据 · OG 标签 · robots.txt |

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

复制 `.env.example` 到 `server/.env` 并填写：

```env
MONGODB_URI=mongodb+srv://...
JWT_SECRET=your_jwt_secret
JWT_REFRESH_SECRET=your_refresh_secret
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
PORT=5001
CLIENT_ORIGIN=http://localhost:5173
CACHE_TTL_HOURS=24
DANDANPLAY_APP_ID=你的弹弹Play AppId
DANDANPLAY_APP_SECRET=你的弹弹Play AppSecret
```

> 弹弹Play API 凭据可在 [api.dandanplay.net](https://api.dandanplay.net/) 申请

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
  | /api/*
Express API -> 控制器 -> 服务层
  |                       |
MongoDB（缓存 + 用户数据） AniList GraphQL API
                            |（后台富化）
                           Bangumi API（中文标题、评分、角色、分集）
                            |（按需调用）
                           弹弹Play API（弹幕匹配、集数映射、弹幕评论）
                            |（实时）
                           Socket.IO（实时弹幕）
```

### 数据管道

1. **AniList 请求** — 季度/搜索/详情查询，700ms 节流
2. **MongoDB 缓存** — 24h TTL，过期自动刷新
3. **Bangumi 富化** — 4 阶段后台管道：
   - Phase 1-3：关键词搜索 -> `titleChinese` + `bgmId`
   - Phase 4：评分、角色中文名、分集标题
   - V3：通过 `bgmId` 直接查询修复缺失的中文标题
4. **优先队列** — 用户请求的番剧插队到队首
5. **缓存预热** — 服务启动时预填充当季番剧

### 弹幕匹配流程

1. **文件解析** — 从文件名提取集数号（支持 `[字幕组] 标题 - 01.mkv`、`S01E01`、`EP01` 等格式）
2. **Hash 计算** — Web Worker 计算文件前 16MB 的 MD5（符合弹弹Play 规范）
3. **三阶段匹配** — hash+文件名组合匹配 -> AnimeCache 关键词匹配 -> 逐文件 hash 回退
4. **集数映射** — 弹弹Play 集数 ID 映射到本地文件，支持 OVA/SP（`O1`、`S1` 格式）
5. **弹幕加载** — 通过弹弹Play 集数 ID 加载弹幕，由 Artplayer 弹幕插件渲染

### 认证流程

- `accessToken` 仅存于 React 内存（不写 localStorage）
- `refreshToken` 存于 httpOnly Cookie
- Axios 拦截器自动处理 401 -> 刷新 -> 重试
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
| `POST /api/dandanplay/match` | 文件 hash/文件名匹配番剧 |
| `GET /api/dandanplay/search` | 在弹弹Play 搜索番剧 |
| `GET /api/dandanplay/episodes/:animeId` | 获取集数列表 |
| `GET /api/dandanplay/comments/:episodeId` | 获取弹幕评论 |
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

## 致谢

- [AniList](https://anilist.co/) — 番剧元数据与 GraphQL API
- [Bangumi 番组计划](https://bgm.tv/) — 中文标题、评分、角色和分集数据
- [弹弹Play](https://www.dandanplay.com/) — 弹幕匹配 API 与弹幕评论数据库。感谢弹弹Play 开发者的支持。
- [ACG.rip](https://acg.rip/) — 种子 RSS 订阅源

---

## 许可证

MIT
