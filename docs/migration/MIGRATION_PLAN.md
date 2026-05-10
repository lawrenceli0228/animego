# AnimeGo 全栈迁移计划

**启动:** 2026-05-10
**baseline:** v2.0.0(commit `7af1d3e`)
**目标终态:** Next.js 14 + TypeScript + Bun runtime 全栈应用
**总工时估算:** 210-385 hr (中位 300 hr) ~ 业余 5-9 个月

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
P2  静态/Public 页面                       15-25 hr
P3  SEO 核心(anime/seasonal/search)       15-30 hr
P4  Library + Player                      40-80 hr   ← 最难,IndexedDB 边界
P5  Admin                                 15-30 hr
P6  部署架构(双 Dockerfile)               22-45 hr
P7  测试 + 性能                           15-30 hr
P8  Bun Canary(production 监控)           5-10 hr
─────────────────────────────────────────────
总: 210-385 hr
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
├── rm package-lock.json && bun install (生成 bun.lock)
├── tsconfig.json (strict: false,开 noImplicitAny + null checks)
├── next.config.js: rewrites 临时回老路由到 Vite 旧实现
├── 验证: 改一个文件,build + test + dev 跑通
└── monorepo 决定: 在 client/ 旁起 next-app/(推荐),还是 client/ → client-legacy/?
```

### Phase 1 — API + Auth 全迁(80-140 hr)

```
├── Express 89+ endpoint 重写到 Next app/api/*/route.ts
│   ├── /api/anime/* (trending, seasonal, search, detail)
│   ├── /api/auth/* (register, login, refresh, logout)
│   ├── /api/admin/* (enrichment, dashboard)
│   ├── /api/follow/* (subscribe, watchlist)
│   ├── /api/comments/*
│   ├── /api/danmaku/* (含 socket.io ← 关键风险点)
│   └── ...
├── Mongoose globalThis cache pattern(Next.js dev hot reload 必需)
├── JWT localStorage → httpOnly cookies
├── ProtectedRoute(client)→ middleware.ts(server)
└── socket.io 在 Next.js 怎么跑(Next 不直接支持长连接 server,需要 custom server 或 next-socket.io adapter)
```

**关键决策待定:** socket.io 在 Next.js standalone 模式下需要 custom server.js 入口替代 `next start`。这影响 P6 部署架构。

### Phase 2 — Public Pages(15-25 hr)

```
├── LandingPage → Server Component
│   └── 拿 trending / yearly-top from Mongo (RSC fetch)
├── About / Privacy / Terms → RSC
├── 加 metadata API(title / OG / Twitter card)
└── sitemap.xml 生成器(基于 anime IDs)
```

### Phase 3 — SEO 核心(15-30 hr)

```
├── /anime/[id] → ISR (revalidate 60s)
│   └── 这是 SEO 主战场,为每部番生成静态页
├── /seasonal/[season]/[year] → ISR
├── /search → searchParams 服务端 + 客户端交互混合
└── robots.txt + structured data (JSON-LD anime schema)
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

### Phase 5 — Admin(15-30 hr)

```
├── /admin/* → middleware.ts 鉴权(role check)
├── 各 admin 页面 RSC 化能 RSC 的部分
└── 数据修复工具(dedupe, merge, refresh metadata)保留客户端交互
```

### Phase 6 — 部署架构(22-45 hr)

```
├── Dockerfile (Bun 主用):
│   FROM oven/bun:1.3-alpine AS build
│   ...
│   CMD ["bun", "server.js"]
│
├── Dockerfile.node (Node 备用,5 分钟内可 rollback):
│   FROM node:22-alpine AS build
│   ...
│   CMD ["node", "server.js"]
│
├── docker-compose.yml:
│   ├── app 服务: build 用 Dockerfile (Bun)
│   ├── mongodb 不变
│   └── nginx: proxy_pass 改 next:3000
│
├── nginx/default.conf 改:
│   └── 全部 proxy 给 next standalone(不再分 static + api)
│
├── Cloudflare cache rules 重做:
│   ├── ISR 路由(/anime/*, /seasonal/*) → cache 60s respect Cache-Control
│   ├── /api/* → no-cache
│   └── 静态资源 → cache 1 year
│
└── CI/CD(.github/workflows):
    └── actions/setup-node → oven/setup-bun
```

### Phase 7 — 测试 + 性能(15-30 hr)

```
├── 137 个测试文件适配:
│   ├── react-router → next/navigation mock
│   ├── 保留 vitest(跑在 Bun runtime)
│   └── 不要换 bun:test (API 不完全兼容,徒增工作)
├── 新加 Playwright E2E:
│   ├── 关键 flow: 注册 → 登录 → 添加文件夹 → 播放
│   ├── 关键 flow: 番剧详情 → 订阅 → watchlist
│   └── 关键 flow: 重新授权 reauth(本次刚加的 UX)
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

## Appendix A — 关键决策日志

| 日期 | 决策 | 备选 | 选择 | 理由 |
|------|------|------|------|------|
| 2026-05-10 | TS 范围 | M1+M2 / M1+M2+M3 / 全量 strict / 仅 M1 | M1+M2+M3(全量,strict:false)| 用户选最大覆盖,strict 后续做 |
| 2026-05-10 | Next.js 范围 | C 预渲染 / B 双栈 / A 全栈 / 不同时做 | A 全栈一步到位 | 一次性做完,不留半成品 |
| 2026-05-10 | Express 命运 | 保留+Next 反代 / 全迁 / 混合 | 全迁到 Next API routes | 单一 runtime,不留双栈复杂度 |
| 2026-05-10 | Runtime | Hybrid(dev Bun, prod Node)/ 全切 Bun / 不动 | 全切 Bun(dev+prod)| 一步到位,Phase 8 canary 兜底 |

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

**Last updated:** 2026-05-10 (initial plan)
