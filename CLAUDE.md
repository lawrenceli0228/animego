# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Design System
Always read `DESIGN.md` before making any visual or UI decisions.
All font choices, colors, spacing, border-radius, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match `DESIGN.md`.

Key rules at a glance:
- **Accent color:** `#0a84ff` (iOS Blue) — the ONLY primary action color. No purple, no gradients on interactive elements.
- **Backgrounds:** `#000000` → `#1c1c1e` → `#2c2c2e` (three-layer Apple True Black)
- **Teal `#5ac8fa`:** secondary accent, information/read-only scenes only — not for clickable actions
- **Fonts:** Sora (display/headings) + DM Sans (body/UI) + JetBrains Mono (code/data)
- **No decorative animations** — motion must serve state comprehension

## Commands

### Development
```bash
# Install all dependencies (monorepo)
npm install

# Start backend (port 5001) — run in terminal 1
npm run dev:server

# Start frontend (port 5173) — run in terminal 2
npm run dev:client
```

### Testing
```bash
# Client tests (Vitest + jsdom)
npm run test --workspace=client

# Client tests in watch mode
npm run test:watch --workspace=client

# Server tests (Jest)
npm run test --workspace=server

# Run a single server test file
npx jest --workspace=server server/__tests__/anime.controller.test.js
```

### Lint & Build
```bash
npm run lint --workspace=client
npm run build                         # builds client only
npm start                             # runs server in production mode
```

## Architecture

This is a **monorepo** with two workspaces: `client/` (React SPA) and `server/` (Express API).

### Request Flow
1. Client calls `/api/*` — Vite dev proxy forwards to `localhost:5001`
2. Express routes → controllers → services
3. `anilist.service.js` checks `AnimeCache` in MongoDB first; on miss, fetches from AniList GraphQL (≥700ms throttle between calls), upserts cache with 24h TTL
4. `bangumi.service.js` runs in the background to fill in `titleChinese` without blocking the main response
5. Server starts with `warmCurrentSeason()` to pre-populate cache for the current season

### Auth Flow
- `accessToken` lives in React memory only (never localStorage), expires in 15 minutes
- `refreshToken` stored in `httpOnly` cookie, expires in 7 days
- `axiosClient.js` intercepts 401s, calls `/auth/refresh` automatically, retries original request, emits `auth:expired` event on failure
- `AuthContext.jsx` listens for `auth:expired` to log the user out

### Real-time (Phase 3)
- Socket.IO server at `server/socket/index.js` attached to the same HTTP server as Express
- `socketAuth` middleware validates JWT on handshake
- `danmaku.handler.js` handles danmaku (bullet comment) events room-keyed by `anilistId:episode`
- Client hook: `client/src/hooks/useDanmaku.js`

### State Management
- Server state via **TanStack Query** (all hooks in `client/src/hooks/`)
- Auth state via `AuthContext` (React context)
- Language (zh/en) via `LanguageContext` + `localStorage`
- Translations in `client/src/locales/zh.js` and `en.js` — add keys to both files when adding new UI text

### Key Patterns
- All API responses use `{ data: ... }` or `{ data: [...], pagination: {...} }` or `{ error: { code, message } }`
- `pickTitle(anime, lang)` in `formatters.js` selects the right title based on current language
- `AnimeCard` accepts optional `rank` and `watcherCount` badge props
- Rate limit: 100 requests / 15 min / IP on all `/api` routes

### Environment Variables
**`server/.env`** — `MONGODB_URI`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `JWT_EXPIRES_IN=15m`, `JWT_REFRESH_EXPIRES_IN=7d`, `PORT=5001`, `CLIENT_ORIGIN=http://localhost:5173`, `CACHE_TTL_HOURS=24`

**`client/.env`** — `VITE_API_BASE_URL` (leave empty for dev; Vite proxy handles `/api`)

## Bangumi 富化管道设计规范

### 背景
Bangumi 富化分两个阶段在后台异步执行：
- **Phase 1-3**（`enqueueEnrichment`）：获取 `titleChinese` + `bgmId`，写入 `bangumiVersion=1`
- **Phase 4**（`enqueuePhase4Enrichment`）：获取评分、角色中文名、分集标题，写入 `bangumiVersion=2`

### 已知坑：分集标题无法写入（2026-04）

**根因：三层问题叠加，形成"初次失败后永不重试"的死结**

1. **Bangumi v0 API 不可靠**
   - `/v0/subjects/{bgmId}/episodes` 对部分番剧返回 404（番剧本身存在但该端点无数据）
   - **正确做法：使用旧 API `/subject/{bgmId}/ep`**，更稳定，覆盖面更广

2. **续集集数偏移问题**
   - Bangumi 续集（S2）的 `sort` 字段继承 S1 编号（如 S1 有 28 集，S2 的 sort=29-38）
   - 必须做偏移归一化：`episode = Math.round(e.sort) - (Math.floor(eps[0].sort) - 1)`
   - 使用 `e.sort` 而非 `e.ep`（`e.ep` 对续集不可靠）

3. **Guard 阻止已有记录重新处理**
   - `enqueuePhase4Enrichment` 不能对 `bangumiVersion >= 2` 的记录设置提前退出
   - `processPhase4Queue` 的 skip 条件必须检查 `episodeTitles == null`，而不是只看 version
   - **正确 skip 条件**：`doc.bangumiVersion >= 2 && episodeTitles != null`（有 version 且有 titles 才跳过）

### 已知坑：bgmId 为 null 时客户端无限轮询（2026-04）

**根因：** Phase 1-3 找不到番剧（如新番未被 Bangumi 收录），`bgmId = null`，写 `bangumiVersion: 1`。
客户端检测到 `bangumiVersion < 2` 每 4 秒轮询一次。但 Phase 4 入队时检查 `!item.bgmId` 直接 skip，
`bangumiVersion` 永远停在 1，形成无限轮询死锁。

**正确做法：** Phase 1-3 完成后若 `bgmId = null`，直接写 `bangumiVersion: 2, episodeTitles: []`，
标记为已完成，阻止客户端继续轮询。`getAnimeDetail` 缓存命中时若发现 `bangumiVersion === 1 && !bgmId`，
同样直接修复写入 version 2。

### 自愈设计原则
- `episodeTitles` 用 `null`（未尝试）vs `[]`（尝试过但无数据）作哨兵区分，不能混用
- Phase 4 结束后**必须**写入 `episodeTitles`（哪怕是 `[]`），否则无法判断是否已尝试
- `anilist.service.js` 的 `getAnimeDetail` 缓存命中分支必须包含对 `bangumiVersion >= 2 && episodeTitles == null` 的重新入队逻辑
- 客户端 `useAnimeDetail` 的 `refetchInterval` 需同时检查 `bangumiVersion < 2` 和 `episodeTitles` 是否为空

### Bangumi API 参考
- 番剧搜索：`GET https://api.bgm.tv/search/subject/{keyword}?type=2&responseGroup=small&max_results=5`
- 番剧详情（评分）：`GET https://api.bgm.tv/v0/subjects/{bgmId}`
- 角色列表：`GET https://api.bgm.tv/v0/subjects/{bgmId}/characters`
- **分集列表（用这个）**：`GET https://api.bgm.tv/subject/{bgmId}/ep`（旧 API，稳定）
- 速率限制：请求间隔 ≥ 800ms

### 优化：详情页富化延迟（2026-04）

**根因：两层延迟叠加**

1. **React Query 缓存不共享**
   - 季度/热门页缓存 key = `['seasonal', ...]` / `['trending', ...]`
   - 详情页 key = `['anime', id]`，完全独立，不复用已有数据
   - 用户点击卡片后详情页从零发 API 请求，显示 loading spinner
   - 实际上列表页已经有这个番的数据（包括已富化字段），但详情页看不到

2. **富化队列 FIFO 无优先级**
   - `warmSeasonCache` 一次入队整季 ~80 个番
   - 每 800ms 处理一个，全季处理完需 64s+（Phase 4 更长）
   - 用户点击的番剧排在队尾，等待时间 = 前面所有番剧的处理时间

**解决方案（已实现）：**

1. **客户端 `placeholderData`**（`client/src/hooks/useAnime.js`）
   - `useAnimeDetail` 添加 `placeholderData`，从 seasonal/trending/search 缓存中找该番数据
   - 有 placeholder 时 `isLoading = false`，页面立刻渲染，无 loading spinner
   - 后台 API 调用返回后无缝替换为完整数据

2. **服务端优先队列**（`server/services/bangumi.service.js`）
   - Phase 1-3 和 Phase 4 各增加 `enrichPriority` / `enrichPhase4Priority` 数组
   - `enqueueEnrichment(items, priority)` 支持 priority 参数；priority 项插到队首
   - Phase 1-3 的 priority 项完成后，Phase 4 入队也继承 priority
   - `getAnimeDetail` 调用时传 `priority = true`；批量入队（warmCache、季度页）用默认 `false`
