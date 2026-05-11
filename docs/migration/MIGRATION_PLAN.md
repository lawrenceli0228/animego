# AnimeGo 全栈迁移计划

**启动:** 2026-05-10
**baseline:** v2.0.0(commit `7af1d3e`)
**目标终态:** Next.js 14 + TypeScript + Bun runtime 全栈应用
**总工时估算:** 220-395 hr (中位 310 hr) ~ 业余 5-9 个月

> **UI 迁移风险:** 这是技术栈替换不是重设计,但 SSR 引入 7 个隐形 UI 风险(FOUC、hydration mismatch、accentCache 闪烁等)。详见 § 3.7,共 +10 hr 分摊到 M2/M3/M4/M7。

---

## 1. 决策摘要

### 范围(用户已拍板,不再 reduce)

| 组件 | 现状 | 终态 |
|------|------|------|
| 前端框架 | Vite SPA + React 18 + JSX | Next.js 14 App Router + RSC + TSX |
| 后端 | Express 4 + 89+ endpoint | Next API routes(全迁,不保留 Express)|
| 语言 | JavaScript + JSDoc | TypeScript(`strict: false` 起步)|
| Auth | JWT in localStorage | httpOnly cookies + middleware |
| Runtime | Node.js | Bun 1.3+(dev + production 全切)|
| 包管理 | npm | bun |
| 构建 | Vite + Vitest | Next build + Vitest 跑在 Bun |
| 部署 | docker compose:Express + Vite static + nginx + mongo | docker compose:Next standalone(Bun)+ nginx + mongo |

### 不在范围

- React 19 升级(锁 React 18.x 直到迁移完成)
- shadcn/ui 等组件库引入
- 国际化 i18n 拆 lib(沿用现有 LanguageContext)
- 完整 `strict: true` TS(留作迁移后单独 PR)
- Mobile app
- monorepo 共享 types(server + client 同 schema 留作后续)

### 已做的关键决策记录

| 决策点 | 选择 | 影响工时 |
|--------|------|---------|
| TS 迁移范围 | 全量 .jsx/.tsx + 测试转 + strict: false | 60-120 hr |
| Next.js 路径 | Path A: 全栈迁移,不做双栈 | 150-275 hr |
| Express 命运 | 全迁 Next API routes,不保留 | +60-100 hr |
| Bun 切换 | dev + production 全切 | +15-30 hr |

---

## 2. 阶段计划

```
P0  Foundation                            12-25 hr
P1  API + Auth(Express 89+ endpoint 全迁) 80-140 hr  ← 最大头
P2  静态/Public 页面                       17-27 hr  (+2 UI mitigation)
P3  SEO 核心(anime/seasonal/search)       18-33 hr  (+3 UI mitigation)
P4  Library + Player                      45-85 hr  (+5 UI mitigation) ← 最难
P5  Admin                                 15-30 hr
P6  部署架构(双 Dockerfile)               22-45 hr
P7  测试 + 性能                           16-31 hr  (+1 visual regression)
P8  Bun Canary(production 监控)           5-10 hr
─────────────────────────────────────────────
总: 220-395 hr
```

### Phase 0 — Foundation(12-25 hr)

```
├── 起 feat/next-migration 分支
├── bunx create-next-app@latest next-app --typescript --app --src-dir
├── package.json scripts 全切 bun:
│   ├── "dev:client": "bun --bun next dev"
│   ├── "dev:server": "bun --watch server/index.js"
│   ├── "build": "bun run next build"
│   ├── "start": "bun server.js"
│   └── "test": "bun run vitest"
├── rm package-lock.json && bun install (生成 bun.lockb 二进制)
├── bun add -d bun-types (Bun 全局类型 Bun.file/Bun.serve 等)
├── tsconfig.json (strict: false,noImplicitAny + strictNullChecks)
│   ├── moduleResolution: "bundler" (Bun 原生模式)
│   └── types: ["bun-types"]
├── next.config.js: rewrites 临时回老路由到 Vite 旧实现
├── next.config.js: 不要设 output: 'standalone' until M6 (跟 custom server 决策对齐)
├── 验证: 改一个文件,build + test + dev 跑通
├── monorepo 决定: 在 client/ 旁起 next-app/(推荐),还是 client/ → client-legacy/?
└── ⚡ UI 风险 inventory (见 §3.7):
    ├── grep 出全部 localStorage callsite (~25 个,'lang'、'animego.heatmapConfig'、accentCache 等)
    ├── 写入 docs/migration/UI_RISKS.md(M2/M3/M4 mitigation 对照清单)
    └── 截 v2.0 visual baseline:首页 / /anime/154587 / /library 各 1 张全屏(1280×800)
```

**Tests (P0):**
- 浏览器 `localhost:3000` 出 Next 默认页
- `localhost:3000/api/anime/trending` 经 rewrite 到 5001 返回真数据
- `bun run vitest <sample.test.ts>` 单测通过(**注意:** 用 `bun run vitest`,不是 `bun test` — 后者是 Bun 内置 runner,API 不兼容)
- `bun run build` 出 `.next/standalone/`

**Baseline 测量(M2/M3/M8 acceptance 对照基准):**
- 跑当前 v2.0 production Lighthouse:`/`、`/anime/154587`、`/seasonal` 三个路径,记 LCP/SEO/TBT/A11y
- 记 Cloudflare Analytics 7 天:Google 引荐流量、indexing 数(从 GSC)
- 记 socket.io 7 天断流率(从 docker logs grep `disconnect`):**M8 Bun canary 的 ±5% 阈值对照这个基线**

**Acceptance:** Next + Bun 起来,API rewrite 通老 Express,build/test/dev 三链路全绿,baseline 数据写入 `docs/migration/BASELINE.md`。

### Phase 1 — API + Auth 全迁(80-140 hr)

**关键决策待定:** socket.io 在 Next.js standalone 模式下需要 custom server.js 入口替代 `next start`。这影响 P6 部署架构。

**M1 拆 5 个 sub-milestone,每个独立 PR ship。**渐进迁移,任意 sub-PR 出问题不影响其他。

#### M1.1 — Mongoose pool + `/api/anime/*`(15-25 hr)

```
├── lib/mongodb.ts:globalThis cache pattern(Next dev hot reload 必需)
│   ├── serverSelectionTimeoutMS: 5000 (防 Bun 下重连卡死)
│   ├── socketTimeoutMS: 45000
│   └── maxPoolSize: 10 (Bun pool 比 Node 略激进,防爆)
├── /api/anime/trending/route.ts
├── /api/anime/seasonal/route.ts
├── /api/anime/search/route.ts
├── /api/anime/[id]/route.ts(detail)
├── /api/anime/torrents/route.ts
├── /api/anime/watchers/route.ts
├── /api/anime/completed-gems/route.ts
├── /api/anime/yearly-top/route.ts
├── /api/anime/schedule/route.ts
├── ⚡ 顺路:enqueueEnrichment 支持 bgmId 键(待办 bgmId)
└── ⚡ 顺路:torrentCache 改 Redis(待办磁力 cache,如果决定引入 Redis)
```

**Tests:** trending 缓存命中 + Subscription 空 + limit clamp + `[id]` 不存在返回 404。**新旧对比回归(关键路径)**:trending、search、detail 三个 endpoint 跑新旧 response shape diff,assert 完全等价。

#### M1.2 — Auth + cookies + middleware(20-35 hr)

```
├── /api/auth/register/route.ts
├── /api/auth/login/route.ts(set httpOnly cookie)
├── /api/auth/refresh/route.ts
├── /api/auth/logout/route.ts(clear cookie)
├── /api/auth/me/route.ts(read cookie)
├── /api/auth/reset-password/route.ts
├── middleware.ts:ProtectedRoute 替代客户端 <ProtectedRoute>
│   └── ⚠️ 必须 export const config = { runtime: 'nodejs' }(Bun 不支持 edge runtime,且让我们能用 jsonwebtoken 不必换 jose)
├── 客户端 fetch 全部加 credentials: 'include'
├── bcrypt 决策:**保留 bcrypt 不切 Bun.password**(老 hash 跟新 API 不互通,会破坏现有用户登录)
│   └── Bun 下 bcrypt 慢约 15%(50ms → 60ms),用户无感
└── ⚡ 顺路:User.isPublic 字段(待办四)
```

**Tests:** login 设置 cookie 正确(httpOnly + Secure + SameSite=Lax)+ me 有/无 cookie 200/401 + middleware 重定向逻辑。**新旧对比回归(关键路径)**:login + me + refresh 三个 endpoint。**E2E**:Playwright 注册→登录→/api/auth/me。

#### M1.3 — Admin + Follow + Profile(15-25 hr)

```
├── /api/admin/dashboard/route.ts
├── /api/admin/enrichment/route.ts
├── /api/admin/resetEnrichment/route.ts
├── /api/follow/* (subscribe, unsubscribe, isFollowing)
└── /api/profile/* (user profile, watchlist, feed)
```

**Tests:** 移植 server/__tests__ 的 follow.controller.test.js / profile.controller.test.js 等价跑通。**新旧对比回归**:仅 `/api/profile/feed` 一条(分页边界容易出错),其他靠移植测试。

#### M1.4 — Comments + Danmaku HTTP routes(10-15 hr)

```
├── /api/comments/* (post, list, delete)
└── /api/danmaku/* (post 历史弹幕,不含 socket.io 实时部分)
```

**Tests:** 移植 server/__tests__ 的 comments / danmaku 等价跑通。**新旧对比回归**:仅 `comments POST` 一条(权限边界容易出错)。

#### M1.5 — 独立 ws-server (Bun + socket.io 微服务)(20-40 hr)← 最高风险

**架构变更(2026-05-10 P0 决策):** Next.js custom server 跟 `output: 'standalone'` 不兼容(Next 官方明示)。socket.io 拆成**独立微服务** `ws-server/`,Next 保持 standalone build。两个 service 在 docker-compose 里共存,nginx 路由 `/socket.io/*` 到 ws-server。

```
新增目录: ws-server/
├── ws-server/index.ts:独立 Bun + socket.io 入口(端口 3001)
├── ws-server/package.json:独立 deps(socket.io, mongoose, jsonwebtoken)
├── ws-server/Dockerfile:FROM oven/bun:1.3-alpine
├── 从 server/socket/* 抽逻辑到 ws-server/(共享 mongoose models 通过 monorepo 引用)
├── client 连接 url 不变(同源 /socket.io,nginx 反代)
├── auth 复用 cookie(ws-server 也读 httpOnly cookie 验 JWT)
├── ⚡ 顺路:socket.io-redis adapter 接入点预留(待办五)
└── 部署期 hand-off 计划:老 Express 保留 socket.io,新 ws-server 起 3001 端口,nginx 流量逐步切
```

```
路由架构:
                 ┌──────────────┐
nginx :443 ─────►│  /socket.io/*│──► ws-server:3001 (Bun)
                 │  /api/*      │──► app:3000 (Next standalone, Bun)
                 │  /*          │──► app:3000 (Next standalone HTML)
                 └──────────────┘
```

**Tests:** 集成测试 100 并发连接 30 分钟无掉线(单实例)+ Atlas reconnect 模拟 + cookie auth 验证(ws-server 跟 app 共享同一 JWT secret)。**关键 gate:** 这个 sub-PR 上线前必须有 24h soak test。

---

**M1 整体 Acceptance:**
- 88+ HTTP endpoint 都在 Next API routes(socket.io 在独立 ws-server)
- ws-server 独立目录可单独跑(`cd ws-server && bun index.ts`)
- 老 Express 保留代码(rollback 用,M6 之前不下线)
- 全套 server/__tests__ 等价测试在 next-app/__tests__ + ws-server/__tests__ 跑通
- 关键路径 6-10 个 endpoint 新旧 response shape 对比通过(不是 89+ 全部,**避免 30+ hr 隐藏工作**)
- E2E auth flow 全绿(包括 socket.io 认证流)

### Phase 2 — Public Pages(17-27 hr)

```
├── LandingPage → Server Component
│   └── 拿 trending / yearly-top from Mongo (RSC fetch)
├── About / Privacy / Terms → RSC
├── 加 metadata API(title / OG / Twitter card)
├── sitemap.xml 生成器(基于 anime IDs)
└── ⚡ UI mitigation (+2 hr,见 §3.7):
    ├── A1: app/layout.tsx 加 inline script 同步读 localStorage→data attr(防 lang/danmaku FOUC)
    └── /、/about、/privacy 各加 loading.tsx skeleton(~20 行)
```

### Phase 3 — SEO 核心(18-33 hr)

```
├── /anime/[id] → ISR (revalidate 60s)
│   └── 这是 SEO 主战场,为每部番生成静态页
├── /seasonal/[season]/[year] → ISR
├── /search → searchParams 服务端 + 客户端交互混合
├── robots.txt + structured data (JSON-LD anime schema)
└── ⚡ UI mitigation (+3 hr,见 §3.7):
    ├── B1: anime schema 加 accentColor 字段 + 一次性 migration script 回填存量(防卡片首屏跳色)
    │       AnimeCard 改读 props.accentColor,accentCache 退化为客户端 fallback
    ├── /anime/[id]、/seasonal、/search 各加 loading.tsx skeleton
    └── AnimeCard <Link prefetch={false}>(防首页滑动触发 50+ 卡片预加载)
```

### Phase 4 — Library + Player(40-80 hr)← 最容易翻车

```
├── /library → 全部 'use client'
│   └── Dexie / IndexedDB / FSA 全部 dynamic({ssr:false}) 包裹
├── /player → 'use client'
│   ├── artplayer 必须 dynamic import only
│   ├── dandanplay-vi 同上
│   └── 弹幕 socket.io 客户端连接
├── 现有 useFileHandles / useImport / useLibrary 全部 review 边界
├── react-router-dom 全删 → next/navigation
└── ProtectedRoute → middleware 鉴权
```

**reauth E2E 注意:** v2.0.0 已加 `UnavailableSeriesSection.test.jsx`(4 cases)+ `LibraryPage.test.jsx`(2 cases)wiring 单元覆盖。Phase 4 的 E2E **是补充,不是替代**:E2E 在真浏览器 + 真 IDB + 真 FSA 跑端到端,单元测试不替代但也不删除。两者并存。

**⚡ UI mitigation (+5 hr,见 §3.7):**
- 'use client' 边界审计:`grep -rn "useState\|useEffect\|window\|document" app/library app/player`,逐个确认入口加了 `'use client'`
- /library、/player 各加 loading.tsx skeleton(IDB 读取期间不白屏)
- 50+ 文件夹真机测试:DevTools Console 红色 hydration warning 必须清零

### Phase 5 — Admin(15-30 hr)

```
├── /admin/* → middleware.ts 鉴权(role check)
├── 各 admin 页面 RSC 化能 RSC 的部分
└── 数据修复工具(dedupe, merge, refresh metadata)保留客户端交互
```

### Phase 6 — 部署架构(22-45 hr)

```
├── app/Dockerfile (Bun 主用):
│   FROM oven/bun:1.3-alpine AS build
│   ...
│   CMD ["bun", "server.js"]  (Next standalone)
│
├── app/Dockerfile.node (Node 备用,5 分钟内可 rollback):
│   FROM node:22-alpine AS build
│   ...
│   CMD ["node", "server.js"]
│
├── ws-server/Dockerfile (新增,M1.5 决策):
│   FROM oven/bun:1.3-alpine
│   COPY ws-server/ ./
│   RUN bun install --frozen-lockfile --production
│   EXPOSE 3001
│   CMD ["bun", "index.ts"]
│
├── docker-compose.yml:
│   ├── app: 主 Next standalone (端口 3000)
│   ├── ws-server: 独立 socket.io (端口 3001) ← 新增
│   ├── mongodb: 不变
│   └── nginx: 路由分发
│
├── nginx/default.conf 改:
│   ├── location /socket.io/* → proxy_pass http://ws-server:3001 (含 WebSocket upgrade headers)
│   ├── location /api/* → proxy_pass http://app:3000
│   ├── location /_next/static/* → proxy_pass http://app:3000 (允许 CF 长 cache)
│   ├── location / → proxy_pass http://app:3000
│   └── ⚡ 必须加 cross-origin isolation headers(player route 用 jassub libass-wasm 依赖 SharedArrayBuffer):
│       add_header Cross-Origin-Opener-Policy "same-origin" always;
│       add_header Cross-Origin-Embedder-Policy "credentialless" always;
│       add_header Cross-Origin-Resource-Policy "same-origin" always;
│       (credentialless 而非 require-corp:AniList/Bangumi 海报 CDN 不发 CORP,credentialless 用 no-cors 兜底)
│       (production 同 Vite dev config — feat/library-libass 已验证可用)
│

├── Cloudflare cache rules (具体方案 — ISR 协调):
│   ├── ❗ Page Rule 1: /_next/static/* → Edge Cache TTL 1 year (允许 CF 长 cache 静态)
│   ├── ❗ Page Rule 2: /anime/*、/seasonal/* → Bypass Cache(让 Next ISR 自己管,避免 CF 缓存掉 ISR 输出)
│   ├── Page Rule 3: /api/* → Bypass Cache
│   ├── Page Rule 4: /socket.io/* → Bypass Cache + 启用 WebSocket
│   └── 原因: ISR 在 Next 内部 60s revalidate,CF 缓存会让 revalidate 失效。让 CF 只 cache 静态资源
│
└── CI/CD(.github/workflows):
    └── actions/setup-node → oven/setup-bun
```

### Phase 7 — 测试 + 性能(16-31 hr)

```
├── 137 个测试文件适配:
│   ├── react-router → next/navigation mock
│   ├── 保留 vitest(跑在 Bun runtime)
│   └── 不要换 bun:test (API 不完全兼容,徒增工作)
├── 新加 Playwright E2E:
│   ├── 关键 flow: 注册 → 登录 → 添加文件夹 → 播放
│   ├── 关键 flow: 番剧详情 → 订阅 → watchlist
│   └── 关键 flow: 重新授权 reauth(本次刚加的 UX)
├── ⚡ UI 视觉回归 (+1 hr,见 §3.7):
│   └── Playwright screenshot diff:首页 / /anime/154587 / /library
│       对照 M0 截的 v2.0 baseline,像素差 ≤ 1% 才能 pass
└── Lighthouse 验证:
    ├── LCP < 1s on /anime/[id]
    ├── SEO ≥ 95
    └── Accessibility ≥ 90
```

### Phase 8 — Bun Canary(5-10 hr)← production 部署后

```
├── 监控 socket.io 长连接断流率(对比 Node baseline)
├── 监控 mongoose Atlas reconnect 事件
├── Atlas connection pool 使用率
├── 24h soak test: 100 并发 socket.io 客户端
└── 第一周每天看 docker logs 找 Bun-specific 异常
```

---

## 3. Architecture Risks(critical)

| ID | 风险 | 概率 | 后果 | Mitigation |
|----|------|------|------|-----------|
| **R0** | **socket.io @ Bun 1.3 长连接稳定性** | 中 | 弹幕掉线增多 | P8 之前 24h soak test;断流 > Node baseline 5% 则 production 退回 Node |
| R1 | Next.js RSC streaming + Bun 偶发延迟 | 中 | LCP 退化 | Phase 4 后 Lighthouse 真机对比 |
| R2 | mongoose Atlas reconnect 在 Bun 下偶发不重连 | 低 | 服务挂直到重启 | mongoose `serverSelectionTimeoutMS` + healthcheck restart |
| R3 | bcrypt N-API 在 Bun 下慢约 15% | 已知 | 登录 ~50ms → 60ms,用户无感 | 接受,不切 Bun.password(避免 hash 不互通) |
| R4 | Next.js middleware 在 Bun 下行为差异 | 中 | auth 偶发 401 | E2E 覆盖 + Phase 8 canary |
| R5 | IndexedDB / FSA / artplayer 漏标 'use client' 白屏 | 高 | Phase 4 大量 debug | Phase 4 中段停下跑完整 E2E,不要堆积 |
| R6 | P1 大爆破:90 endpoint 全迁期间产线靠老 Express | 高 | 切流量期间网站不稳 | Express 保持跑,Next 项目并行起,P1 完后切流量 |
| R7 | Auth cookies 切换 forced logout | 必然 | 全员重新登录一次 | 切换前 announce + grace period |

**R0 / R6 / R7 是 critical**,必须提前规划 mitigation。

---

## 3.5 Phase Gating 规则

每个 phase 进下一个之前必须满足:

1. **Tasks 全勾** — phase 内所有 checkbox 完成
2. **Tests 全绿** — `bun run vitest` + 该 phase 新加的 E2E 全过
3. **Acceptance 验证** — 该 phase Acceptance section 列的指标都达标
4. **Commit + push** — feat/next-migration 分支已合并 PR(或至少 commit)
5. **Rollback 链可用** — 验证能回上一个 phase 状态(M0 之后每个 phase 都要有 git tag 标记进度)

**M1 内部 sub-milestone gating 同上**(M1.1 → M1.2 之间也要 gate)。

特殊 gates:

- **M0 → M1 gate:** `docs/migration/BASELINE.md` 已写入(Lighthouse + socket.io 断流率 + GSC 数)
- **M1.5 → M2 gate:** socket.io 24h soak test 通过(单实例 100 并发)
- **M3 → M4 gate:** ISR 路由 Lighthouse SEO ≥ 95
- **M6 → M7 gate:** rollback test 验证过(手动切 Dockerfile 5 分钟内回 Node)
- **M7 → M8 gate:** 全部 1650+ vitest + 5 Playwright E2E 绿,production 部署 stage(canary 10% 流量)

**违规处理:** 任何 gate 不达标,**不进下一个 phase**。退回修。

---

## 3.6 Migration Impact(顺路完成的旧 TODO)

下表把 TODO.md Part 2 的 ⚡ 项映射到具体 phase task。phase 实施时同步关闭对应旧 TODO。

| 旧 TODO | Phase | Sub-task | 关闭条件 |
|---------|-------|---------|---------|
| 待办四 `User.isPublic` | M1.2 | Auth migration 时 User schema 加 `isPublic: Boolean = true`,profile API 按此字段过滤非本人访问 | M1.2 PR merge |
| 待办 `enqueueEnrichment` 支持 bgmId 键 | M1.1 | bangumi.service 改 enqueueMap 支持 bgmId(或加第二张 map) | M1.1 PR merge |
| 待办磁力 cache 持久化(Redis)| M1.1 | torrentCache 改 Redis 后端(若 M1.5 决定引入 Redis,提前到 M1.1 一并搬;否则延后到 M1.5) | M1.5 PR merge(条件性)|
| 待办五 WebSocket Redis Pub/Sub | M1.5 | 不立即接 Redis adapter,但 socket.io custom server 写法预留 adapter slot,加 TODO comment | M1.5 PR merge(只是预留接入点) |
| 待办十六 Sentry 错误监控 | M6 | Dockerfile 加 Sentry SDK,生产环境 DSN 通过 env 注入 | M6 PR merge(部署前) |
| 待办十七 Admin 富化速率保护 | M5 | resetEnrichment 走 enqueueEnrichment 排队,不绕过 | M5 PR merge |

**强制要求:** phase 实施 PR 必须在 commit message 里写 `Closes TODO #四 (User.isPublic)` 等。否则旧 TODO 状态飘移,Part 2 表格永远清不掉。

---

## 3.7 UI 迁移风险审计

> 这次迁移**没有重设计 UI** — 颜色、字体、布局、组件全部 1:1 平移(JSX → TSX 输出等价)。`DESIGN.md` 设计令牌不动。但 SPA → SSR 的 runtime 变化引入 7 处隐形 UI 风险,每处都能修。

### 风险清单

| # | 风险 | 严重度 | 现象 | Phase | Mitigation |
|---|------|-------|------|-------|-----------|
| U0 | Hydration mismatch | ★★★ | 进 `/library` 闪 200–500ms + Console 红色 warning | M4 | 'use client' 审计 + dynamic({ssr:false}) |
| U1 | localStorage FOUC | ★★★ | 服务器渲 ZH → 客户端切 EN,文字全闪;弹幕开关、播放速率、热图配置同闪 | M2 | **A1** inline script |
| U2 | accentCache 卡片跳色 | ★★ | 首页 100+ 番剧卡 SSR 出灰色 → hydrate 跳成番剧主色 | M3 | **B1** anime.accentColor 入 schema |
| U3 | Loading 态切换 | ★★ | SPA 白屏+spinner → RSC 没 fallback 时 Suspense 默认空 | M2/M3/M4 | 5 个 loading.tsx skeleton |
| U4 | 强制重登期 login 页 | ★★ | M1.2 流量翻倍,旧 UI 暴露 | M1.2 前 | 视觉肉眼审 + 友好提示组件 |
| U5 | next/link 默认 prefetch | ★ | 滑首页触发 50+ 番剧详情预加载,流量翻倍 | M3 | AnimeCard prefetch={false} |
| U6 | 视觉回归无 baseline | ★ | 改 1 行 CSS 不知道哪里坏了 | M0 + M7 | M0 截 baseline + M7 Playwright 像素 diff |

### 拍板决策(2026-05-11)

| 决策 | 选择 | 理由 |
|------|------|------|
| **A · localStorage FOUC 防护** | **A1: `next-themes` 同款 inline script** | 工业标准,1–2 hr 工作量,first paint 就对 |
| **B · accentCache 长期方案** | **B1: anime document 加 accentColor 字段 + ISR SSR 直出彩色** | 一次性 migration script,长期受益,符合 ISR 设计哲学 |

### A1 实施模板(M2 落地)

```tsx
// app/layout.tsx — 必须放 <head> 顶部,React 之前同步执行
<head>
  <script dangerouslySetInnerHTML={{ __html: `
    try {
      const lang = localStorage.getItem('lang') || 'zh';
      document.documentElement.setAttribute('data-lang', lang);
      const dm = localStorage.getItem('animego.danmaku.visible');
      if (dm !== null) document.documentElement.setAttribute('data-danmaku', dm);
      const rate = localStorage.getItem('animego.playback.rate');
      if (rate) document.documentElement.style.setProperty('--player-rate', rate);
    } catch (e) {}
  `}} />
</head>
```

CSS / 组件根据 `[data-lang]` `[data-danmaku]` 决定渲染分支。`next-themes` 包不直接用(不需要主题切换),但模式抄它的 — 见 [next-themes 源码](https://github.com/pacanukeha/next-themes/blob/main/packages/next-themes/src/index.tsx)。

### B1 实施模板(M3 落地)

```ts
// server/models/Anime.js (M3 之前,在 server/ 老 schema 加字段)
const AnimeSchema = new Schema({
  // ... existing fields ...
  accentColor: { type: String, default: null },  // hex e.g. "#ff6b9d"
})

// scripts/migrate-accent-colors.ts (一次性脚本)
// 读 client/src/utils/accentCache.js 的提取逻辑 (Vibrant.js)
// 服务器跑一遍,把所有 anime.coverImage → 主色调写回 anime.accentColor
// production 跑前先 staging 验证,~5000 部番剧约 30 分钟

// app/anime/[id]/page.tsx (M3 ISR 化时)
const anime = await getAnime(params.id)
return <AnimeCard anime={anime} accentColor={anime.accentColor} />

// AnimeCard 改读 props,accentCache 客户端只做 cover 换图后的兜底
```

### 工时账

| Phase | 增量 | 内容 |
|-------|-----|------|
| M0 | 0 hr | localStorage inventory + visual baseline 截图(顺路,~30 分钟) |
| M2 | +2 hr | A1 inline script + 3 个 loading.tsx |
| M3 | +3 hr | B1 schema + migration script + 3 loading.tsx + prefetch={false} |
| M4 | +5 hr | 'use client' 审计 + 2 loading.tsx + 50+ 文件夹 hydration 测试 |
| M7 | +1 hr | Playwright visual regression 配置 |
| **总** | **+10 hr** | 中位 +10,合并到总工时 220–395 hr |

### 不修的副作用(接受)

- **首屏 LCP 比 SPA 更快**(SSR 直出 HTML)— 这是好事,不算副作用
- **react-router-dom → next/navigation** 微差(useLocation 拆成 usePathname + useSearchParams)— 用户感知 0,M4 重构期顺手切
- **Next `<Link>` prefetch 行为** — U5 已修(关掉 AnimeCard 的)
- **页面切换"感觉"略不同**(Next 等 RSC payload 比 SPA 慢 ~50ms)— 用户感知不到

### M7 视觉回归 baseline 流程

```bash
# M0 时(还在 v2.0 SPA):
npx playwright codegen --device "Desktop Chrome" --viewport-size 1280,800
# 录:首页 → /anime/154587 → /library(已添加 1 个文件夹)
# 截 3 张 PNG → docs/migration/baseline-screenshots/

# M7 时(Next.js 全栈):
# Playwright 同样路径截图,跟 baseline 做 pixel diff
# 阈值 ≤ 1% 像素差才 pass(允许微小渲染差异,大改动会被抓)
```

---

## 4. Rollback Plan

### Production Bun → Node 回滚(5 分钟)

```bash
# VPS 上:
ssh root@45.152.65.208 "cd /opt/animego && \
  sed -i 's|dockerfile: Dockerfile$|dockerfile: Dockerfile.node|' docker-compose.yml && \
  docker compose build app && \
  docker compose up -d app"
```

双 Dockerfile 必须从 Phase 6 第一天就维护,不能等到出事再写。

### 完整迁移 → v2.0 SPA 回滚(30 分钟)

```bash
# 万一 Next.js 整体出大问题:
ssh root@45.152.65.208 "cd /opt/animego && \
  git checkout v2.0.x-stable && \
  docker compose down && \
  docker compose build && \
  docker compose up -d"
```

迁移期间 v2.0.x 必须保持一个稳定 tag 在 main 之外,**不能** rebase/force push 掉。

---

## 5. Worktree Parallelization

```
P0 (Foundation + Bun 切换)  → 必须串行
P1 (API + Auth 全迁)        → 必须串行(基础)

P1 完成后可分 lane 并行:
  Lane A: P2 + P3 (SEO 页面)              [worktree-seo]
  Lane B: P4 (Library/Player)             [worktree-app]
  Lane C: P5 (Admin)                      [worktree-admin]

P6 部署 必须等所有 lane 合并
P7 测试 持续穿插
P8 Canary 部署后第一周
```

并行能压缩 20-30 hr。单人 + Claude Code 协作下并行价值有限。

---

## 6. 起步动作(P0 第一天)

```bash
# 1. 起分支
git checkout -b feat/next-migration

# 2. 用 bun scaffold Next 项目
bunx create-next-app@latest next-app \
  --typescript --app --src-dir \
  --import-alias "@/*" --eslint --tailwind=false

# 3. bun 进项目
cd next-app && bun install

# 4. 配 next.config.js: rewrites 让 /api/* 临时走老 Express
#    rewrites: [{ source: '/api/:path*', destination: 'http://localhost:5001/api/:path*' }]

# 5. 验证 bun + next 跑得通
bun --bun next dev
# 在另一个窗口
bun --watch server/index.js

# 6. 浏览器开 localhost:3000,Next 默认页面应出现
#    访问 localhost:3000/api/anime/trending 走 rewrite 到 5001 应该有数据
```

P0 收工标准:**Next + Bun 起来,API 通过 rewrite 走老 Express 拿到数据**。

---

## 7. Status Tracking

| Phase | Status | Started | Completed | Hours actual |
|-------|--------|---------|-----------|-------------:|
| P0 Foundation | not started | — | — | — |
| P1 API + Auth | not started | — | — | — |
| P2 Public Pages | not started | — | — | — |
| P3 SEO Core | not started | — | — | — |
| P4 Library + Player | not started | — | — | — |
| P5 Admin | not started | — | — | — |
| P6 Deploy | not started | — | — | — |
| P7 Test + Perf | not started | — | — | — |
| P8 Bun Canary | not started | — | — | — |

---

## 8. 后续 TODO(迁完后单独 PR)

- [ ] 开 `strict: true` 清扫 `any`(20-40 hr)
- [ ] Lighthouse CI on every PR,LCP regression block merge(5-10 hr)
- [ ] Server 端 schema 与 client end-to-end 类型(monorepo shared types)
- [ ] React 19 升级(等 Next 官方 stable)
- [ ] Bun 1.5+ 稳定后,考虑 `Bun.password` 替代 bcrypt(需迁移现有 hash)

---

## Appendix C — Framework Specifics(Next.js 14 + Bun 1.3 实施参考)

> 实施期遇到具体 API 问题时先查这里。doc references 是 `nextjs.org/docs/app/` 和 `bun.sh/docs/`。

### Next.js 14 App Router 关键 API

```ts
// app/api/anime/[id]/route.ts — API handler
import { NextRequest, NextResponse } from 'next/server'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  return NextResponse.json({ id: params.id })
}
```

```ts
// app/api/auth/login/route.ts — set httpOnly cookie
import { cookies } from 'next/headers'
cookies().set('session', token, { httpOnly: true, secure: true, path: '/', maxAge: 86400 })
```

```ts
// middleware.ts — 鉴权 + Bun 必需 nodejs runtime
import { NextResponse } from 'next/server'
export const config = {
  runtime: 'nodejs',                       // ⚠️ Bun 不支持 edge runtime
  matcher: ['/library/:path*', '/admin/:path*'],
}
export function middleware(req) {
  if (!req.cookies.get('session')) return NextResponse.redirect(new URL('/login', req.url))
  return NextResponse.next()
}
```

```tsx
// app/anime/[id]/page.tsx — RSC + ISR
export const revalidate = 60
export async function generateMetadata({ params }) { /* ... */ }
export default async function Page({ params }) {
  const anime = await getAnime(params.id)  // 直接 await,RSC 内
  return <article>{anime.title}</article>
}
```

```tsx
// 'use client' + dynamic import (artplayer / dandanplay-vi 必须)
'use client'
import dynamic from 'next/dynamic'
const ArtPlayer = dynamic(() => import('@/components/ArtPlayer'), { ssr: false })
```

```ts
// lib/mongodb.ts — globalThis cache(M1.1 必需)
import mongoose from 'mongoose'
declare global { var _mongooseCache: { conn: any; promise: any } }
if (!global._mongooseCache) global._mongooseCache = { conn: null, promise: null }
export async function connectDB() {
  if (global._mongooseCache.conn) return global._mongooseCache.conn
  if (!global._mongooseCache.promise) {
    global._mongooseCache.promise = mongoose.connect(process.env.MONGODB_URI!, {
      serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000, maxPoolSize: 10,
    })
  }
  global._mongooseCache.conn = await global._mongooseCache.promise
  return global._mongooseCache.conn
}
```

### ws-server/index.ts(M1.5 独立微服务模板)

```ts
// ws-server/index.ts
import { createServer } from 'http'
import { Server } from 'socket.io'
import jwt from 'jsonwebtoken'
import { parse as parseCookie } from 'cookie'
import { connectDB } from './lib/mongodb'  // 共享 mongoose

await connectDB()
const httpServer = createServer()
const io = new Server(httpServer, { path: '/socket.io', cors: { origin: false } })

io.use((socket, next) => {
  const cookies = parseCookie(socket.handshake.headers.cookie || '')
  try {
    const payload = jwt.verify(cookies.session, process.env.JWT_SECRET!)
    socket.data.userId = payload.userId
    next()
  } catch { next(new Error('unauth')) }
})

io.on('connection', (socket) => {
  socket.on('danmaku:send', (msg) => io.to(msg.roomId).emit('danmaku:new', msg))
})

httpServer.listen(3001, () => console.log('ws-server :3001'))
```

### Bun 关键命令

```bash
# dev
bun --bun next dev          # 全程 Bun runtime,出问题退 bun next dev
bun --watch server/index.ts # 替代 nodemon (15ms vs 500ms)

# install
bun install                 # 生成 bun.lockb (二进制,必须 commit)
bun install --frozen-lockfile
bun install --production

# test (保留 vitest!)
bun run vitest run          # ✅ 用这个,API 兼容现有 137 测试
# bun test                  # ❌ 不用,vi.mock 不兼容

# production
bun server.js               # Next standalone + 自定义 server
```

### tsconfig.json(Bun 优先)

```jsonc
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",  // Bun 原生
    "strict": false,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "types": ["bun-types"],         // bun add -d bun-types
    "jsx": "preserve",
    "allowJs": true,
    "skipLibCheck": true
  }
}
```

### 关键坑汇总(实施时容易踩)

| 坑 | 解 |
|----|----|
| `cookies()` / `headers()` 在 RSC 调用后该 route 变 dynamic | 接受;只在需要的 page 用 |
| custom server 不兼容 `output: 'standalone'` | M1.5 走独立 ws-server,app 保持 standalone |
| Bun 不支持 edge runtime | middleware.ts 必须 `runtime: 'nodejs'` |
| Cloudflare 会缓存 ISR HTML 输出 | CF Page Rule:`/anime/*`、`/seasonal/*` Bypass Cache |
| `bun.lockb` 不 commit → CI 慢 2-5 min | 必须 commit 二进制 lockfile |
| Bun.password 跟 bcrypt hash 不互通 | 保留 bcrypt,接受 15% 慢 |
| `next dev` hot reload 多 mongo connection | globalThis cache pattern 必装 |
| socket.io 跑 Next.js 内部 | 拆独立 ws-server,nginx 反代 |

---

## Appendix A — 关键决策日志

| 日期 | 决策 | 备选 | 选择 | 理由 |
|------|------|------|------|------|
| 2026-05-10 | TS 范围 | M1+M2 / M1+M2+M3 / 全量 strict / 仅 M1 | M1+M2+M3(全量,strict:false)| 用户选最大覆盖,strict 后续做 |
| 2026-05-10 | Next.js 范围 | C 预渲染 / B 双栈 / A 全栈 / 不同时做 | A 全栈一步到位 | 一次性做完,不留半成品 |
| 2026-05-10 | Express 命运 | 保留+Next 反代 / 全迁 / 混合 | 全迁到 Next API routes | 单一 runtime,不留双栈复杂度 |
| 2026-05-10 | Runtime | Hybrid(dev Bun, prod Node)/ 全切 Bun / 不动 | 全切 Bun(dev+prod)| 一步到位,Phase 8 canary 兜底 |
| 2026-05-10 | socket.io 跑哪 | A: 放弃 standalone / B: 独立 ws-server / C: Express 留 socket.io | B: 独立 ws-server 微服务 | 读 Next docs 发现 custom server ⛔ standalone,选 B 保持 standalone + 不违背 M1 全迁 |
| 2026-05-10 | bcrypt vs Bun.password | 切 Bun.password / 保留 bcrypt | 保留 bcrypt | 老 hash 不互通,15% 慢可接受 |
| 2026-05-10 | middleware runtime | edge / nodejs | nodejs | Bun 不支持 edge runtime,顺便能用 jsonwebtoken |
| 2026-05-11 | localStorage FOUC 防护 | A1 inline script / A2 cookie / A3 Suspense | A1 inline script | 工业标准,1–2 hr,first paint 就对 |
| 2026-05-11 | accentColor 长期方案 | B1 schema 字段 / B2 客户端 fade-in | B1 schema 字段 | 一次性 migration,符合 ISR 设计哲学 |

---

## Appendix B — Innovation Token 使用

按 Garry Tan / Dan McKinley 的 "三个 innovation tokens" 原则,本次迁移使用了 **4 个 token**:

1. Next.js 全栈替代 Vite SPA + Express
2. Express → Next API routes 全迁(89+ endpoint)
3. JWT localStorage → httpOnly cookies + middleware auth
4. Node → Bun runtime 全切

预算超支 1 个 token,通过以下方式 hedge:

- **R0 mitigation**: socket.io soak test + 双 Dockerfile rollback
- **R6 mitigation**: 老 Express 在 P1 期间不下线
- **R7 mitigation**: Auth 切换公告 + grace period
- **完整 rollback 链**: 任何 phase 出大事,5-30 分钟可回 v2.0

---

**Last updated:** 2026-05-11 (加 §3.7 UI 迁移风险审计 + A1/B1 决策 + M0/M2/M3/M4/M7 mitigation tasks,共 +10 hr)
