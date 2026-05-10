# AnimeGo 待办

> **当前阶段:** 全栈迁移期(2026-05-10 起)。详细 plan 见 [docs/migration/MIGRATION_PLAN.md](docs/migration/MIGRATION_PLAN.md) — single source of truth。
>
> 本文档只追踪进度,详细 Tasks / Tests / Acceptance 在 MIGRATION_PLAN.md。

---

## Part 1 — 重构 Workflow 进度

### 🟡 M0: Foundation(0/4)

起 `feat/next-migration` 分支 + Next + Bun + baseline 测量。**12-25 hr** · 详见 [MIGRATION_PLAN.md § Phase 0](docs/migration/MIGRATION_PLAN.md)

- [ ] 起分支 + scaffold Next 14 + Bun
- [ ] tsconfig + next.config rewrites + bun.lockb + bun-types
- [ ] **建 baseline:** v2.0 SPA 当前 Lighthouse 分 + socket.io 7 天断流率 + GSC 索引数(M2/M3/M8 acceptance 对照用)
- [ ] 验收:`bun --bun next dev` + API rewrite + `bun run vitest` 三链路全绿

---

### 🔴 M1: API + Auth 全迁(0/5 sub-milestones)

89+ endpoint 全迁 Next API routes,Auth localStorage → cookies。**80-140 hr** · 详见 [MIGRATION_PLAN.md § Phase 1](docs/migration/MIGRATION_PLAN.md)

拆成 5 个 sub-milestone,每个独立 PR ship:

- [ ] **M1.1** Mongoose globalThis pattern + `/api/anime/*` 9 个 endpoint(15-25 hr)
- [ ] **M1.2** `/api/auth/*` 6 个 endpoint + cookies + middleware ProtectedRoute(20-35 hr)
- [ ] **M1.3** `/api/admin/*` + `/api/follow/*` + `/api/profile/*`(15-25 hr)
- [ ] **M1.4** `/api/comments/*` + `/api/danmaku/*`(10-15 hr)
- [ ] **M1.5** 独立 ws-server 微服务(Bun + socket.io,端口 3001)+ 长连接验证(20-40 hr)

⚡ 顺路完成的旧 TODO(见 Part 2 映射):待办四(`isPublic`)在 M1.2、待办 bgmId 入队在 M1.1、磁力 cache 持久化考虑在 M1.1。

---

### 🟢 M2: Public Pages(0/4)

LandingPage / About / Privacy → RSC + metadata + sitemap。**15-25 hr** · [MIGRATION_PLAN.md § Phase 2](docs/migration/MIGRATION_PLAN.md)

- [ ] LandingPage RSC 化
- [ ] sitemap.xml + 全局 metadata
- [ ] 验收:Lighthouse SEO ≥ 95 + LCP < 1.5s + GSC 读取 sitemap 成功

---

### 🟢 M3: SEO 核心 ISR(0/4)

`/anime/[id]` + `/seasonal/*` + `/search` ISR 化。**15-30 hr** · [MIGRATION_PLAN.md § Phase 3](docs/migration/MIGRATION_PLAN.md)

- [ ] `/anime/[id]` ISR + JSON-LD TVSeries
- [ ] `/seasonal/[season]/[year]` ISR
- [ ] `/search` searchParams 混合
- [ ] 验收:SSR HTML 包含 anime 数据(view-source 验证)+ Lighthouse SEO 100

---

### 🔴 M4: Library + Player(0/6)← 最容易翻车

全 client-side。Dexie / IndexedDB / FSA / artplayer 全部 dynamic({ssr:false})。**40-80 hr** · [MIGRATION_PLAN.md § Phase 4](docs/migration/MIGRATION_PLAN.md)

- [ ] `/library` + `/player` 'use client'
- [ ] artplayer / dandanplay-vi dynamic import
- [ ] react-router-dom → next/navigation 全替换
- [ ] reauth E2E(**补充** v2.0 已有的 6 个 wiring 单元测试,不替代)
- [ ] 验收:E2E 全 flow + 50+ 文件夹无 hydration mismatch

---

### 🟢 M5: Admin(0/3)

middleware role check + admin 页面 RSC。**15-30 hr** · [MIGRATION_PLAN.md § Phase 5](docs/migration/MIGRATION_PLAN.md)

- [ ] middleware admin 鉴权
- [ ] admin 页面 RSC 化
- [ ] 验收:E2E admin 角色越权测试

⚡ 顺路完成:待办十七(admin 富化速率保护)。

---

### 🟡 M6: 部署架构(0/5)

双 Dockerfile(Bun 主 / Node 备)+ nginx + Cloudflare ISR cache。**22-45 hr** · [MIGRATION_PLAN.md § Phase 6](docs/migration/MIGRATION_PLAN.md)

- [ ] `Dockerfile`(Bun)+ `Dockerfile.node`(rollback)
- [ ] docker-compose + nginx proxy 改 next:3000
- [ ] Cloudflare cache rules + CI 用 oven/setup-bun
- [ ] **rollback test:** 5 分钟内能切回 Node
- [ ] 验收:VPS 部署通过 + rollback 链可用

⚡ 顺路完成:待办十六(部署前 Sentry)— Bun canary 期 Sentry 兜底必需。

---

### 🟢 M7: 测试 + 性能(0/4)

137 vitest 适配 next/navigation + Playwright E2E + Lighthouse CI。**15-30 hr** · [MIGRATION_PLAN.md § Phase 7](docs/migration/MIGRATION_PLAN.md)

- [ ] 137 vitest 适配 + 5 关键 Playwright E2E
- [ ] Lighthouse CI 三个 critical 路径
- [ ] 验收:`bun run vitest` 1650 测试全绿 + Lighthouse 全绿

---

### 🟡 M8: Bun Canary(0/4)← production 部署后第一周

24h soak test + Atlas/socket.io 监控。**5-10 hr** · [MIGRATION_PLAN.md § Phase 8](docs/migration/MIGRATION_PLAN.md)

- [ ] socket.io 100 并发 24h soak test
- [ ] mongoose Atlas reconnect 验证
- [ ] **Critical gate:** 断流率 > Node baseline 5% → 立刻 rollback 到 Dockerfile.node
- [ ] 验收:一周稳定 + Lighthouse 不退化 > 10%

---

## Part 2 — 未完成产品 TODO(部分迁移期消化)

下表标记 ⚡ 的 TODO 会在对应 phase 顺路解决,Part 1 phase tasks 已包含。

| 待办 | 标题 | 优先级 | Effort | Migration impact |
|------|------|------|------|------|
| 四 | `User.isPublic` 字段 | P3 | S(人工 4h / CC ~10min)| ⚡ M1.2 顺路 |
| 五 | WebSocket Redis Pub/Sub | P3 | M(人工 2 天 / CC ~30min)| ⚡ M1.5 socket.io custom server 时预留 adapter |
| 十六 | Sentry 错误监控 | P2 | S(人工 4h / CC ~15min)| ⚡ M6 部署前必装 |
| 十七 | Admin 重新富化速率保护 | P2 | S(人工 6h / CC ~15min)| ⚡ M5 顺路 |
| - | `enqueueEnrichment` 支持 bgmId 键 | P3 | S(~20 行)| ⚡ M1.1 顺路 |
| - | 磁力 cache 持久化(Redis)| P2 | S-M | ⚡ M1.1(若 M1.5 引入 Redis 一并搬)|

详细 What/Why/Pros/Cons:见 [docs/migration/MIGRATION_PLAN.md § Migration Impact](docs/migration/MIGRATION_PLAN.md)。

---

### 迁后 TODO(M0-M8 全部完成后)

- [ ] 开 `strict: true` 清扫 `any`(20-40 hr)
- [ ] Lighthouse CI on every PR,LCP regression block merge(5-10 hr)
- [ ] Server + client schema 端到端类型(monorepo shared types)
- [ ] React 19 升级(等 Next 官方 stable + artplayer 兼容)
- [ ] Bun 1.5+ 稳定后,考虑 `Bun.password` 替代 bcrypt(需迁移现有 hash)

---

## Part 3 — 已归档(完成项)

### v0.1 - v0.2(社区化前期)

- [x] **待办一:** 季度番剧翻页数据为空(2026-03-08)— `warmSeasonCache` 全量预热
- [x] **待办二:** 限流未根本解决(2026-03-08)— 启动时预热当前季度,翻页 0 次 AniList
- [x] **待办三:** 补写核心测试(v0.1.0-v0.1.4)— Jest + Supertest + Vitest + Testing Library 全套接入
- [x] **待办八:** 建立 DESIGN.md 设计系统文档(2026-03-27)
- [x] **待办九:** 全局 Toast 通知系统(2026-03-28)
- [x] **待办十:** 弹幕输入框断线状态视觉处理(2026-03-28)
- [x] **待办十一:** 用户追番列表分页(2026-03-28)
- [x] **待办十二:** follow / profile / danmaku 控制器测试(v0.2.0,23 个新测试)
- [x] **待办十三:** `useFollow` 关注/取关失败 Toast 反馈(commit `ce3c845`)
- [x] **待办十四:** `GET /api/feed` 分页支持(commit `ce3c845`)

### v1.x(SEO + 富化)

- [x] **待办十五:** 启动时全量扫描未富化番剧(`sweepUnenriched`)
- [x] **待办十八:** 部署后 Google Search Console 操作(2026-04-17)— canonical 修复 + sitemap 5003 URLs

### v2.0(本地媒体库)

- [x] 本地影音库 P1-P5(2026-05-09 v2.0.0)— DropZone + IndexedDB + FSA + artplayer + 弹幕集成
- [x] **2026-05-10 patch:** UnavailableSeriesSection 加 section-level「重新授权」按钮(commit `c28c37a`)

---

_最后更新:2026-05-10(/plan-eng-review 审核后简化,详细 plan 移至 MIGRATION_PLAN.md)_
