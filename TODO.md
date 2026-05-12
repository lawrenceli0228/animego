# AnimeGo 待办

> **当前阶段:** 全栈重构期 v2(2026-05-12 起)。详细 plan 见 [docs/migration/MIGRATION_PLAN.md](docs/migration/MIGRATION_PLAN.md) — single source of truth。
>
> **v2 vs v1:** 后端从 Bun+Next.js → **Go+PostgreSQL**;迁移路径从 strangler-fig → **big-bang + shadow traffic**;schema 从 hybrid → **全 normalize**。详见 plan §1 决策日志。
>
> 本文档只追踪进度,详细 Tasks / Tests / Acceptance 在 MIGRATION_PLAN.md。

---

## Part 1 — 重构 Workflow 进度

### 🟡 P0: Go 骨架 + Postgres + Backup (0/5)

起 `feat/go-backend` 分支 + Go + Postgres + R2 backup。**20-35 hr**

- [ ] 起分支 + `go-api/` 项目结构(chi + pgx + sqlc + river)
- [ ] docker-compose 加 postgres:16-alpine
- [ ] Cloudflare R2 bucket + rclone + nightly pg_dump cron
- [ ] backup → restore 演练通过
- [ ] 验收:`:8080/health` OK + postgres healthy + R2 backup 当天有文件

---

### 🔴 P1: Migration Tool (0/4) ← critical

Go 单二进制 `cmd/migrate-mongo`,一次性 Mongo → Postgres。**40-60 hr**

- [ ] 14 张 Postgres 表 + 索引 + tsvector(`migrations/0001_init.sql` + `0002_indexes.sql`)
- [ ] pg_cron 安装 + danmaku TTL 任务
- [ ] 7 个 collection-specific transform 函数 + testcontainers 测试
- [ ] **dry-run on prod mongodump 副本通过**,row count 差异 < 0.1%

---

### 🔴 P2: Go API 重写 (0/7 sub-milestones)

37 endpoint + 317 测试。**100-160 hr + P2.7 测试 60-80 hr**

拆 7 个 sub-milestone,每个独立 PR ship:

- [ ] **P2.1** `/api/anime/*` 9 endpoint + 富化 queue (river)(35-55 hr)
- [ ] **P2.2** `/api/auth/*` 7 endpoint + JWT + bcrypt + Gmail SMTP(18-28 hr)
- [ ] **P2.3** `/api/admin/*` 14 endpoint + adminAuth + 富化 queue 控制(15-22 hr)
- [ ] **P2.4** `/api/subscriptions/*` + `/api/users/*` + `/api/feed`(12-18 hr)
- [ ] **P2.5** `/api/comments/*` + `/api/danmaku/*`(HTTP only)(8-12 hr)
- [ ] **P2.6** `/api/dandanplay/*` + 3-phase match(12-25 hr)
- [ ] **P2.7** testify + testcontainers-go 等价重写 317 测试(60-80 hr)← **显式新拆 phase**

⚡ 顺路完成的旧 TODO:待办四(`is_public`)在 P2.2、enqueueEnrichment bgmId 在 P2.1、磁力 cache 持久化在 P2.1。

---

### 🟢 P3: Next.js 14 骨架 + Bun (0/3)

Next + Bun + rewrites 通老 Express + baseline 测量。**15-25 hr**

- [ ] 起 `next-app/` scaffold + bun + bun.lockb
- [ ] next.config.js rewrites 通老 Express:5001(P9 cutover 时改 go-api:8080)
- [ ] **建 baseline:** v2.0.1 Lighthouse 三路径 + Express 错误率 7 天 + socket.io 断流率 + GSC 索引数

---

### 🟢 P4: Public Pages RSC (0/4)

LandingPage / About / Privacy → RSC + sitemap + metadata。**17-27 hr**

- [ ] LandingPage RSC 化(fetch Go /api/anime/trending + yearly-top)
- [ ] sitemap.xml + 全局 metadata
- [ ] U1 inline script 防 lang/danmaku FOUC + 3 个 loading.tsx skeleton
- [ ] 验收:Lighthouse SEO ≥ 95 + LCP < 1.5s + view-source 看到 anime 数据

---

### 🟢 P5: SEO 核心 ISR (0/4)

`/anime/[id]` + `/seasonal/*` + `/search` ISR 化。**18-33 hr**

- [ ] `/anime/[id]` ISR + JSON-LD TVSeries(8 query Go 拼数据)
- [ ] `/seasonal/[season]/[year]` + `/search` ISR
- [ ] U2 anime_cache.accent_color 字段 + migration 回填 + AnimeCard 改读 props
- [ ] 验收:SSR HTML 包含 anime 数据 + Lighthouse SEO 100 + JSON-LD Rich Results 通过

---

### 🔴 P6: Library + Player + libass 平移 (0/6) ← 最容易翻车

全 client-side。Dexie / IndexedDB / FSA / artplayer / jassub 全部 dynamic({ssr:false})。**45-85 hr**

- [ ] `/library` + `/player` 'use client'
- [ ] artplayer / dandanplay-vi / jassub libass-wasm dynamic import
- [ ] react-router-dom → next/navigation 全替换(72 文件)
- [ ] reauth E2E(补充 v2.0.1 已有的 6 个 wiring 单元测试)
- [ ] U0 + U3:'use client' 边界审计 + 2 loading.tsx skeleton
- [ ] 验收:50+ 文件夹无 hydration mismatch + jassub 字幕跟 v2.0.1 一致

---

### 🟢 P7: Admin RSC + middleware (0/3)

middleware role check + admin 页面 RSC。**15-25 hr**

- [ ] middleware admin 鉴权(runtime: nodejs)
- [ ] admin 页面 RSC + 富化 queue 控制 UI(river client)
- [ ] 验收:E2E admin 角色越权测试

⚡ 顺路完成:待办十七(admin 富化速率保护)。

---

### 🟡 P8: 部署架构 (0/6)

4 个 Dockerfile(app/Bun + go-api/distroless + ws-server/Node + Express/rollback)+ nginx + Cloudflare + Sentry。**30-50 hr**

- [ ] go-api Dockerfile multi-stage distroless
- [ ] Next.js app Dockerfile (Bun)
- [ ] docker-compose 5 容器(app + go-api + ws-server + postgres + mongo + nginx)
- [ ] nginx 路由分发 + COOP/COEP/CORP + WASM CSP + local-fonts Permissions-Policy
- [ ] Cloudflare cache rules + GitHub Actions CI (setup-go + setup-bun)
- [ ] 验收:VPS staging 4 容器跑通 + Sentry 收到 staging error 流

⚡ 顺路完成:待办十六(Sentry)。

---

### 🔴 P8.5: Shadow Traffic 1 周 (0/4) ← critical gate

cutover 前 7 天,nginx mirror 复制 prod 流量到 Go,验证 P99。**15-25 hr**

- [ ] nginx mirror directive + X-Shadow-Traffic header 识别
- [ ] Go shadow mode:走完所有逻辑但不返回响应,记 metrics
- [ ] Prometheus + Grafana(docker-compose 加 2 service)+ 告警阈值
- [ ] **critical gate:** 7 天后错误率 < 1% + P99 < 200ms + 0 Go panic → 进 P9;否则延期

---

### 🔴 P9: Big-Bang Cutover (0/5) ← production critical

凌晨 3-5am UTC+8 维护窗口,nginx 一次切流量到 go-api。**10-20 hr**

- [ ] T-7 day:全站 banner 公告维护 + 关闭注册 24h 前
- [ ] T+0 维护窗口:停 Express → 跑 migration → row count 校验 → nginx 改 upstream
- [ ] T+1h:Grafana + Sentry 验证 + 真实用户 smoke test
- [ ] T+24h:错误率 < 1% + 0 critical bug → cutover 成功
- [ ] T+30day:停 mongo 容器 + mongodump → R2(灾难恢复,不是 rollback)

**Critical gate:** T+24h 错误率 > 1% 或 critical bug → nginx 一行回 Express,Postgres 写入数据丢失(详见 plan § 4)

---

### 🟢 P10: Lighthouse CI + Sentry + Playwright E2E (0/4)

5 关键 E2E + Lighthouse CI + Sentry + pg_stat_statements。**15-30 hr**

- [ ] 5 个 Playwright E2E(注册→播放、详情→订阅、reauth、admin 越权、弹幕实时)
- [ ] Lighthouse CI on every PR(LCP regression > 10% block)
- [ ] Sentry production DSN 接入 go-api + app
- [ ] 1342 client 测试适配 next/navigation

---

## Part 2 — 未完成产品 TODO(部分迁移期消化)

| 待办 | 标题 | 优先级 | Effort | Migration impact |
|------|------|------|------|------|
| 四 | `users.is_public` 字段 | P3 | S | ⚡ P2.2 顺路 |
| 五 | WebSocket Redis Pub/Sub | P3 | M | 不在 v2 plan 范围(ws-server 长期 follow-up) |
| 十六 | Sentry 错误监控 | P2 | S | ⚡ P8 顺路(go-api + app 双 SDK) |
| 十七 | Admin 重新富化速率保护 | P2 | S | ⚡ P2.3 + P7 顺路(river queue 控制) |
| - | `enqueueEnrichment` 支持 bgmId 键 | P3 | S | ⚡ P2.1 顺路(river 任务支持 bgmId) |
| - | 磁力 cache 持久化(Postgres 表)| P2 | S | ⚡ P2.1 顺路 |

详细见 [docs/migration/MIGRATION_PLAN.md § 3.6](docs/migration/MIGRATION_PLAN.md)。

---

### 迁后 TODO(P0-P10 全部完成后)

- [ ] 开 `strict: true` 清扫 `any`(20-40 hr)
- [ ] Lighthouse CI on every PR,LCP regression block merge
- [ ] Go server-side schema 与 client TS 端到端类型(codegen via OpenAPI)
- [ ] React 19 升级(等 Next 官方 stable + artplayer 兼容)
- [ ] ws-server → Go(等 socket.io v4 Go 库成熟,可能永不迁)
- [ ] Postgres → managed(Supabase / Neon)如果 VPS 不够用了
- [ ] 待办五:socket.io-redis adapter(多 ws-server 实例时)

---

## Part 3 — 已归档(完成项)

### v0.1 - v0.2(社区化前期)

- [x] **待办一:** 季度番剧翻页数据为空(2026-03-08)
- [x] **待办二:** 限流未根本解决(2026-03-08)
- [x] **待办三:** 补写核心测试(v0.1.0-v0.1.4)
- [x] **待办八:** 建立 DESIGN.md 设计系统文档(2026-03-27)
- [x] **待办九:** 全局 Toast 通知系统(2026-03-28)
- [x] **待办十:** 弹幕输入框断线状态视觉处理(2026-03-28)
- [x] **待办十一:** 用户追番列表分页(2026-03-28)
- [x] **待办十二:** follow / profile / danmaku 控制器测试(v0.2.0)
- [x] **待办十三:** `useFollow` 关注/取关失败 Toast 反馈
- [x] **待办十四:** `GET /api/feed` 分页支持

### v1.x(SEO + 富化)

- [x] **待办十五:** 启动时全量扫描未富化番剧(`sweepUnenriched`)
- [x] **待办十八:** 部署后 Google Search Console 操作(2026-04-17)

### v2.0(本地媒体库)

- [x] 本地影音库 P1-P5(2026-05-09 v2.0.0)
- [x] **2026-05-10 patch:** UnavailableSeriesSection 加 section-level「重新授权」按钮

### v2.0.1(libass-wasm 字幕渲染)

- [x] **libass-wasm 集成**(2026-05-11,PR #9,commit `bcb0a51`)— MKV 内嵌 ASS 字幕渲染 + zlib 解压 + CJK 字体 fallback + COOP/COEP/CORP

---

_最后更新:2026-05-12(/plan-eng-review v2 审核后,supersedes v1 plan from 2026-05-10)_
