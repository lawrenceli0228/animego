# AnimeGo 待办

> **当前阶段:** 全栈重构期 v2(2026-05-12 起)。详细 plan 见 [docs/migration/MIGRATION_PLAN.md](docs/migration/MIGRATION_PLAN.md) — single source of truth。
>
> **v2 vs v1:** 后端从 Bun+Next.js → **Go+PostgreSQL**;迁移路径从 strangler-fig → **big-bang + shadow traffic**;schema 从 hybrid → **全 normalize**。详见 plan §1 决策日志。
>
> 本文档只追踪进度,详细 Tasks / Tests / Acceptance 在 MIGRATION_PLAN.md。

---

## Part 1 — 重构 Workflow 进度

### 🟡 P0: Go 骨架 + Postgres + Backup + dev script (0/6,二轮 review 2C 加 dev.sh)

起 `feat/go-backend` 分支 + Go + Postgres + R2 backup + 本机 dev 一键起。**20-35 hr**

- [ ] 起分支 + `go-api/` 项目结构(chi + pgx + sqlc + river)
- [ ] docker-compose 加 postgres:16-alpine
- [ ] Cloudflare R2 bucket + rclone + nightly pg_dump cron
- [ ] backup → restore 演练通过 + R2 30-day retention cron 实跑
- [ ] **scripts/dev.sh 一键起 6 进程**(postgres + mongo + go-api + ws-server + Next + .env.example check)
- [ ] 验收:`:8080/health` OK + postgres healthy + R2 backup 当天有文件 + scripts/dev.sh 工作

---

### 🔴 P1: Migration Tool (0/6,二轮 review 6A + tests gap) ← critical

Go 单二进制 `cmd/migrate-mongo`,一次性 Mongo → Postgres。**40-60 hr**

- [ ] 14 张 Postgres 表 + 索引 + **search_vec generated column STORED + GIN**(3P)+ **全 CASCADE FK**(1C) + pg_trgm extension
- [ ] pg_cron 安装 + danmaku TTL 任务 + **pg_cron 实际 fire test**(P1 test gap)
- [ ] 7 个 collection-specific transform 函数 + testcontainers 测试
- [ ] **field-level parity test:10 个 UI-critical field × 1000 sample 严格 equal**(6A)
- [ ] **idempotency:同 mongo dump 重跑 PG 不重 row**(P1 test gap)
- [ ] **dry-run on prod mongodump 副本通过**,row count 差异 < 0.1%

---

### 🔴 P2: Go API 重写 (0/8 sub-milestones)

48 endpoint + 311 测试。**112-185 hr + P2.7 测试 60-80 hr + P2.8 ws-server 10-15 hr**

拆 8 个 sub-milestone,每个独立 PR ship:

- [ ] **P2.1** `/api/anime/*` 9 endpoint + 富化 queue (river) + 2-tier cache 主从决策(35-55 hr)
- [ ] **P2.2** `/api/auth/*` 7 endpoint + JWT + bcrypt + Gmail SMTP + **dual-accept header+cookie 7天**(18-28 hr)
- [ ] **P2.3** `/api/admin/*` 14 endpoint + adminAuth + 富化 queue 控制(15-22 hr)
- [ ] **P2.4** `/api/subscriptions/*` + `/api/users/*` + `/api/feed`(12-18 hr)
- [ ] **P2.5** `/api/comments/*` + `/api/danmaku/*`(HTTP only)(8-12 hr)
- [ ] **P2.6** `/api/dandanplay/*` + 3-phase match(**二轮 review 6C +12hr → 24-37 hr**)
- [ ] **P2.7** testify + testcontainers-go 等价重写 311 测试(60-80 hr)
- [ ] **P2.8** **ws-server 拆出独立服务**(10-15 hr,二轮 review 3A NEW)← LRU rate-limit + JWT 共享 + PG INSERT ON CONFLICT

⚡ 顺路完成的旧 TODO:待办四(`is_public`)在 P2.2、enqueueEnrichment bgmId 在 P2.1、磁力 cache 持久化在 P2.1。

---

### 🟢 P3: Next.js 16 骨架 + Bun (0/3,二轮 review 1A 改版本)

Next 16 + Bun + rewrites 通老 Express + baseline 测量。**15-25 hr**

- [ ] 起 `next-app/` scaffold + bun + bun.lockb (Next.js 16,React 19 默认,Turbopack stable)
- [ ] next.config.js rewrites 通老 Express:5001(P9 cutover 时改 go-api:8080)
- [ ] **建 baseline:** v2.0.1 Lighthouse 三路径 + Express 错误率 7 天 + socket.io 断流率 + GSC 索引数 + **prod metrics req/s p50/p95/p99 + 峰值**(8A) + **vnstat 30-day outbound + VPS 带宽 plan**(TODO-1 / Pf4)

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

### 🟡 P8: 部署架构 (0/7,二轮 review 5A+5C+test gap 改)

3 个 Dockerfile(app/Bun + go-api/distroless + ws-server/Node;**5C 删 Dockerfile.node**)+ nginx + Cloudflare + Sentry。**30-50 hr**

- [ ] go-api Dockerfile multi-stage distroless
- [ ] Next.js app Dockerfile (Bun + Next.js 16)
- [ ] docker-compose 6 容器(app + go-api + ws-server + postgres + mongo + nginx)+ rollback profile
- [ ] nginx 路由分发 + COOP/COEP/CORP + WASM CSP + local-fonts Permissions-Policy
- [ ] **5 nginx header 联动 Playwright 测试:libass + cross-origin font + console.error 清零**(test gap)
- [ ] Cloudflare cache rules + GitHub Actions CI (setup-go + setup-bun) + **build-express workflow 推 :rollback-T0 tag**(5A)
- [ ] 验收:VPS staging 3 容器跑通 + Sentry 收到 staging error 流 + sentry alert 验证

⚡ 顺路完成:待办十六(Sentry)。

---

### 🔴 P8.5: Shadow Traffic 1 周 + 演练 (0/6,二轮 review 1T+2T+Pf4 加 2 项) ← critical gate

cutover 前 7 天,nginx mirror 复制 prod 流量到 Go,验证 P99。**15-25 hr**

- [ ] nginx mirror directive + X-Shadow-Traffic header 识别
- [ ] Go shadow mode:走完所有逻辑但不返回响应,记 metrics
- [ ] Prometheus + Grafana(docker-compose 加 2 service)+ 告警阈值
- [ ] **Pf4 mirror throttle:** 若 baseline outbound × 2 > VPS cap,降到 50% sample
- [ ] **Day-6 cutover dress rehearsal:** staging 完整 T+0 序列(ws-server stop → Express stop → migration → switch)
- [ ] **Day-7 rollback drill:** ssh + nginx switch 计时 <5min
- [ ] **critical gate:** 7 天后错误率 < 1% + P99 < baseline×1.5 + 0 Go panic + 2 演练通过 → 进 P9

---

### 🔴 P9: Big-Bang Cutover (0/6,二轮 review 5A+5T) ← production critical

凌晨 3-5am UTC+8 维护窗口,nginx 一次切流量到 go-api。**10-20 hr**

- [ ] T-7 day:全站 banner 公告维护 + 关闭注册 24h 前
- [ ] **T-1 day:GH Actions trigger build-express + 推 :rollback-T0 tag 到 registry**(5A)
- [ ] **T+0 维护窗口序列(修正):** stop ws-server → stop Express → 跑 migration → field+row 校验 → nginx 改 upstream(5T)
- [ ] T+1h:Grafana + Sentry 验证 + 真实用户 smoke test
- [ ] T+24h:错误率 < 1% + 0 critical bug → cutover 成功
- [ ] T+30day:停 mongo 容器 + mongodump → R2(灾难恢复,不是 rollback)

**Critical gate:** T+24h 错误率 > 1% 或 critical bug → nginx 一行回 Express,Postgres 写入数据丢失(详见 plan § 4)

---

### 🟢 P10: Lighthouse CI + Sentry + Playwright E2E + 性能拍板 (0/7,二轮 review TODO-3+TODO-4+Pf1+Pf5 加 3 项)

5 关键 E2E + Lighthouse CI + Sentry + pg_stat_statements。**15-30 hr**

- [ ] 5 个 Playwright E2E(注册→播放、详情→订阅、reauth、admin 越权、弹幕实时)
- [ ] Lighthouse CI on every PR(LCP regression > 10% block)
- [ ] Sentry production DSN 接入 go-api + app
- [ ] **Sentry alert wiring fire test:注 fake error → 验证 email/Slack 30s 内收到**(TODO-3)
- [ ] **Playwright 视觉回归:pixel-diff 0.1% threshold + PR 评论 "visual: ok" 触发 CI re-snap**(TODO-4)
- [ ] **P5 dual-mode 详情页 P10 拍板:基于 P8.5 数据决定 8-query 或 json_agg 默认**(Pf1)+ **pgx pool size 25-50**(Pf5)
- [ ] 1328 client 测试适配 next/navigation(原 plan 写 1342,实际 1328)

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

_最后更新:2026-05-12 19:00(/plan-eng-review **二轮 deep re-run** 后,19 个新 finding,17 resolved + 2 unresolved-accepted。NEW P2.8 ws-server split phase,Next.js 14→16,schema 全 CASCADE + search_vec generated column,P8.5 加 day-6 dress rehearsal + day-7 rollback drill,P9 序列加 stop ws-server)_
