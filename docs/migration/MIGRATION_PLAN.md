# AnimeGo 全栈重构计划 v2

**启动:** 2026-05-12
**Supersedes:** v1 (2026-05-10,Next.js + Bun 全栈保留 Mongo + Express)
**Baseline:** v2.0.1(commit `89516a1`,libass-wasm + Vite SPA + Express + MongoDB)
**目标终态:**
- 前端:**Next.js 16** App Router + RSC + TSX + Bun runtime(2026-05-12 二轮 review 1A 改正:14 已不在 Active LTS)
- 后端:Go 1.23 + chi + pgx + sqlc + PostgreSQL 16(VPS 自建)
- 实时:Node + socket.io 微服务(保留,Go 库未成熟)
- 部署:big-bang cutover,24h 真实回滚窗口

**总工时估算:** 410-650 hr (中位 ~530 hr) ~ 业余 7-13 个月
(二轮 review 加:P2.6 +12hr、P2.8 ws-server split +10-15hr)
**Innovation tokens:** **6** / 3(Next.js 16 把 14 那个 token 消掉,因为 React 19 默认 = stable,不再算单独 token;仍超 budget 2)

---

## 1. 决策摘要

### 范围

| 组件 | 现状 (v2.0.1) | v1 plan (已废弃) | **v2 plan (本文档)** |
|------|------|------|------|
| 前端框架 | Vite SPA + React 18 + JSX | Next.js 14 + RSC + TSX | **Next.js 16 + RSC + TSX**(二轮 review 1A 修正;React 19 默认) |
| 前端 runtime | Node | Bun 1.3 | **Bun 1.3** |
| 后端语言 | JS (Node 22 + Express 4) | TS (Bun + Next API routes) | **Go 1.23** |
| 后端 HTTP | Express | Next API routes | **chi v5** |
| ORM/Driver | Mongoose | Mongoose | **pgx v5 + sqlc** |
| 数据库 | MongoDB:7 (VPS docker) | MongoDB (同) | **PostgreSQL 16 (VPS docker,自建)** |
| 实时 | Express + socket.io 同进程 | 独立 ws-server (Bun + socket.io) | **保留 Node + socket.io 微服务**(Go 库不成熟) |
| 后端测试 | Jest + Supertest (317 个) | vitest | **testify + testcontainers-go (~317 个等价重写)** |
| 后端 jobs | in-memory queues | in-memory queues | **river**(Postgres-backed,事务性入队) |
| Auth | JWT in localStorage | httpOnly cookies + Next middleware | **httpOnly cookies + Next middleware**(Go 签 JWT,Next.js 验) |
| 缓存 | in-memory Map | in-memory | **ristretto**(in-process)+ Postgres `cache` 表(冷数据) |
| Backup | mongo 自建 + 无 backup 策略 | 同 | **nightly `pg_dump` → Cloudflare R2** |
| 迁移路径 | — | strangler-fig | **big-bang cutover + shadow traffic 预热** |
| Schema 策略 | — | — | **全 normalize(14 张表,0 JSONB)** |
| 回滚窗口 | — | — | **24h 真实窗口**(超过后 mongodump 仅作灾难恢复,不再支持) |
| 部署架构 | docker app + mongo + nginx | + ws-server | **app(Bun/Next)+ go-api(Go)+ ws-server(Node)+ postgres + nginx**(mongo cutover 后 30 天后删) |

### 不在范围

- ~~React 19 升级(等 Next 官方 stable + artplayer 兼容)~~ — 1A 决议 Next.js 16 直接给到 React 19 默认,这条 deferral 自动 closed
- shadcn/ui 等组件库引入
- 国际化 i18n 拆 lib
- 完整 TS strict: true(留作迁移后单独 PR)
- Mobile app
- monorepo 共享 types(Go/Node/TS 三语言无 monorepo type-share 方案)
- 多 Go 实例(单实例 Go 服务,跟现状 Express 单实例一致)
- ws-server 迁移到 Go(等 socket.io v4 Go 库成熟,可能永远不迁)

### 关键决策日志(2026-05-12 一并拍板)

| 决策 | 选择 | 理由 |
|------|------|------|
| **前端框架版本** | **Next.js 16(Active LTS)** | 二轮 review 1A 修正:14 已不在 Active LTS,16 是 React 19 默认 + Turbopack stable,5-13月期间不 EOL |
| 后端语言 | Go 1.23 | 单二进制,内存占用小,并发模型适合 webhook + 富化 queue |
| ORM 策略 | pgx + sqlc(无 ORM) | 类型安全 SQL,0 runtime reflection,SQL 可读 |
| Postgres 部署 | VPS docker 自建 | 与 mongo 现有模式一致,0 新账单,容器内网 latency 最低 |
| schema 风格 | 全 normalize | 14 张表,可查"演员配过哪些番"类问题;JOIN 性能信赖 Postgres |
| **schema FK** | **anime_* 子表 + user_id 全 ON DELETE CASCADE** | 二轮 review 1C:normalize 蕴含 cascade,RESTRICT 会让 admin 删失败 |
| socket.io 实现 | 保留 Node + socket.io | Go 库 v4 支持不成熟,异构服务架构永久保留 |
| **ws-server 微服务化** | **P2.8 显式拆出 ws-server/ 目录** | 二轮 review 3A:今天 socket.io 跟 Express 同进程,P8 前必须拆出独立服务 |
| 迁移路径 | big-bang cutover | 单次切流量,nginx 一行回滚;不维护 strangler-fig 路由复杂度 |
| 回滚窗口 | 24h 真实 + 30 天 mongodump | 24h 内 nginx 回 Express;超过 24h mongodump 仅作灾难恢复 |
| **Rollback image 保留** | **cutover T-1d 推 Express :rollback-T0 tag,registry 保留 30天** | 二轮 review 5A:依赖 docker image 不被 prune 不可靠,显式 tag |
| **Auth 切换过渡** | **Go API 双接 Authorization header + Cookie 7 天** | 二轮 review 4A:0-transition cutover = silent 401 storm,header→cookie 7天平滑 |
| Cutover 前验证 | shadow traffic 1 周 | nginx mirror 复制 prod 流量到 Go,验证 P99 而不切流量 |
| **Cutover 演练** | **P8.5 day-6 dress rehearsal + day-7 rollback drill** | 二轮 review 1T/2T:P9 T+0 序列从未在 staging 跑过 = 一次性大风险 |
| 测试编写 | 拆独立 phase P2.7 | testify+testcontainers 等价重写 311(实际)个 Jest,显式 80 hr |
| 详情页 read path | **P5 dual-mode(8-query / json_agg),P8.5 shadow 对比,P10 拍板** | 二轮 review Pf1:plan 之前接受 N+5,但 P10 才 benchmark 太晚;P5 实现两套 |
| 迁移工具语言 | Go(单二进制) | 跟 backend 同语言,可重复执行,无 Node deps |
| **Migration field parity** | **P1 acceptance 加 field-level parity test(10 key field × 1000 row sample)** | 二轮 review 6A:row count diff 过不代表 UI 不跳色;Mongo undefined vs PG NULL |
| **River vs lean** | **保留 river**(Postgres-backed 队列,事务性入队) | 二轮 review 7A:lean 方案(jobs 表 + 3 goroutine)更轻但 V2/V3 phase crash 恢复要自己写;river 直接给 |
| Mongo cutover 后 | 保留容器 30 天 + R2 mongodump 90 天 | 灾难恢复 + 法律取证,**不是 rollback 路径** |
| **T+0 cutover 序列** | **stop ws-server → stop Express → 跑 migration → nginx switch** | 二轮 review 5T:之前序列没 mention ws-server,会有 silent 弹幕丢 |

---

## 2. 阶段计划

```
P0   Go 项目骨架 + Postgres + R2 backup + scripts/dev.sh           20-35 hr
P1   Schema migration tool (Mongo → Postgres,Go 单二进制)         40-60 hr  ← critical
P2.1 /api/anime/* + 富化 queue                                     35-55 hr
P2.2 /api/auth/* + JWT + Gmail SMTP + dual-accept (4A)             18-28 hr
P2.3 /api/admin/* + adminAuth                                      15-22 hr
P2.4 /api/subscriptions/* + /api/users/* + /api/feed              12-18 hr
P2.5 /api/comments/* + /api/danmaku/* (HTTP only)                  8-12 hr
P2.6 /api/dandanplay/* + 3-phase match(二轮 review 6C +12hr)      24-37 hr  ← 含 episodeMap + pg_trgm 决策
P2.7 testify + testcontainers-go 等价重写 311 测试                 60-80 hr  ← 显式拆出
P2.8 ws-server 拆出 (二轮 review 3A 新增 phase)                    10-15 hr  ← NEW
P3   Next.js 16 骨架 + Bun + rewrites + prod metrics baseline      15-25 hr
P4   Public Pages RSC (LandingPage + About + sitemap + metadata)   17-27 hr
P5   SEO 核心 ISR (/anime/[id] dual-mode + /seasonal + /search)    18-33 hr
P6   Library + Player + libass-wasm + reauth E2E                   45-85 hr  ← 最难
P7   Admin RSC + middleware role check                             15-25 hr
P8   部署架构 (Dockerfile × 3 + nginx + COOP/COEP/CORP)             30-50 hr
P8.5 Shadow traffic 1 周 + day-6 dress rehearsal + day-7 rollback drill   15-25 hr  ← critical gate
P9   Big-bang cutover (ws-server stop → Express stop → migration → switch)   10-20 hr
P10  Lighthouse CI + Sentry alert wiring + Playwright + baseline   15-30 hr
─────────────────────────────────────────────────────────────────
总: 410-650 hr (中位 ~530 hr)
```

### Phase 0 — Go 项目骨架 + Postgres + Backup (20-35 hr)

```
├── 起 feat/go-backend 分支
├── 新目录 go-api/(跟 client/ server/ 平级)
│   ├── go-api/cmd/server/main.go  (chi router 入口)
│   ├── go-api/cmd/migrate-mongo/main.go  (P1 工具入口)
│   ├── go-api/internal/{config,db,middleware,routes,services}/
│   ├── go-api/internal/db/queries/*.sql  (sqlc 输入)
│   ├── go-api/internal/db/gen/*.go  (sqlc 输出)
│   ├── go-api/migrations/*.sql  (golang-migrate 输入)
│   ├── go-api/go.mod (Go 1.23,deps: chi, pgx, sqlc-runtime, golang-jwt/v5, river)
│   └── go-api/.air.toml  (hot reload for dev)
├── docker-compose.yml 新增:
│   postgres:
│     image: postgres:16-alpine
│     volumes: postgres-data
│     env: POSTGRES_USER/PASSWORD/DB
│     healthcheck: pg_isready
├── Cloudflare R2 bucket "animego-backup" + rclone config
├── crontab nightly pg_dump → R2:
│   0 3 * * * docker exec animego-postgres-1 pg_dump -U animego animego \
│     | gzip | rclone rcat r2:animego-backup/pg-$(date +\%F).sql.gz
│   0 4 * * * rclone delete --min-age 30d r2:animego-backup/
└── 验证: bun --bun next dev (frontend) + go run ./go-api/cmd/server (backend) + docker-compose up postgres
```

**Tests (P0):**
- `go test ./go-api/...` 跑通(空套件)
- pg_dump → R2 → restore 演练成功(必须真跑一次)
- backup 文件能下载 + 解压 + restore 到 staging
- R2 30-day retention cleanup cron 实际跑(模拟 31-day 老文件 + 触发 rclone delete --min-age 30d)

**Acceptance:**
- Go 服务 `:8080/health` 返回 OK
- Postgres 容器 healthy
- R2 backup 当天有文件,restore 演练通过
- **scripts/dev.sh 一键起 6 个进程**(postgres + mongo + go-api + ws-server + Next.js + 加 .env.example check)(二轮 review 2C)

### Phase 1 — Migration Tool (Mongo → Postgres) (40-60 hr) ← critical

写一个 Go 单二进制 `cmd/migrate-mongo`,一次性把 Mongo 数据 → Postgres。

```
├── go-api/cmd/migrate-mongo/main.go
│   ├── 命令:--mongo-uri --pg-uri --dry-run --collections
│   ├── 7 个 collection-specific transform 函数
│   ├── 按 FK 依赖顺序写入:users → anime_cache → subscriptions/follows/comments/danmaku/episode_windows → anime_* 子表
│   └── 进度条 + row count 双侧对比 + 失败行日志
│
├── 14 张 Postgres 表(migrations/0001_init.sql,见 Appendix D):
│   主表: users, anime_cache, subscriptions, follows, episode_comments, danmakus, episode_windows
│   子表: anime_genres, anime_studios, anime_relations, anime_characters, anime_staff, anime_recommendations, anime_episode_titles
│
├── 索引 + tsvector(migrations/0002_indexes.sql):
│   anime_cache 标题 GIN tsvector
│   subscriptions/follows/comments/danmakus 复合索引
│   anime_* 子表全部 idx(anime_id)
│
├── pg_cron 安装 + danmaku TTL 任务:
│   SELECT cron.schedule('danmaku-ttl', '0 4 * * *',
│     $$DELETE FROM danmakus WHERE created_at < NOW() - INTERVAL '1 year'$$);
│
└── Dry-run mode:
    --dry-run = 全程读 + transform + count,但不写 Postgres
    输出 "would insert N rows to anime_cache, N to anime_characters, ..."
```

**Tests (P1):**
- testify 单测每个 transform 函数(覆盖 ObjectId, Date 时区,embedded subdoc nil)
- testcontainers-go:启 mongo + postgres,导入 fixture mongo data,跑 migration,assert Postgres rows 等价
- **dry-run on prod mongo dump**:跑全量 dry-run,row count 跟 mongo count 一致,差异 < 0.1%
- **二轮 review 6A NEW** field-level parity test:10 个 UI-critical field(titleChinese/characters[0].nameCn/coverImageColor/posterAccent/startDate/...)随机抽 1000 行在 mongo 跟刚写入 PG 双查,严格 equal(null 等价容忍)
- **NEW** idempotency:同一 mongo dump 重跑 PG 不重 row(UPSERT or transaction wrap)
- **NEW** pg_cron danmaku TTL 实际 DELETE fire test(插 18-month 老 danmaku → 触发 cron 调度 → SELECT count == 0)

**Acceptance:**
- dry-run + actual run 都通过
- migration 总耗时 < 30 分钟(P9 cutover 窗口给的预算)
- 失败行 < 0.01%,失败原因有 log
- field parity test 全绿
- pg_cron TTL 真触发

### Phase 2 — Go API 重写 (5 个 sub-milestone,共 100-160 hr)

每个 sub-milestone 独立 PR ship。每个完成后 stage 部署到 staging Go 实例,跟 Express 跑 shape diff 对照。

#### P2.1 — `/api/anime/*` + 富化 queue (35-55 hr)

```
├── 9 个 endpoint:
│   GET /seasonal /search /schedule /torrents /trending /yearly-top /completed-gems
│   GET /:anilistId/watchers /:anilistId
├── 3-source 磁力聚合(animes.garden + acg.rip + nyaa.si):
│   golang.org/x/sync/errgroup 并发,8s timeout,partial 容忍
│   ristretto 1h cache (500 entries)
├── AniList GraphQL client:
│   Khan/genqlient 生成,golang.org/x/time/rate 700ms token bucket
├── 3-phase 富化 queue:
│   river 替代 in-memory queue。每 phase 一个 worker 类型:
│     - bangumi_v1 (search by title)
│     - bangumi_v2 (subject detail by bgmId)
│     - bangumi_v3 (heal-cn by bgmId)
│   river 事务性入队 + Postgres-backed,重启不丢任务
├── warmCurrentSeason / warmSeasonCache:
│   river periodic job 24h cron + 启动时 enqueue v0 orphans
└── 5 个 in-memory cache (search/schedule/trending/yearly/completed-gems):
    ristretto with TinyLFU, 1h TTL
    ⚠️ 二轮 review TODO-2:本 phase commit 前决定 2-tier cache 主从 + 文档
       (ristretto 主 vs Postgres cache 表主),invalidate 路径写下来
```

**Tests:** 9 endpoint testify 单测 + 3 关键 shape-diff with Express(trending/search/detail)+ river worker integration test
- **NEW** river 重试 on transient Bangumi 500:mock 5xx → river 默认 3 retry → 第 4 次 finally fail
- **NEW** rate limiter goroutine-safe:100 goroutine 并发调用 dandanplay limiter,assert 间隔 ≥ 800ms,无 race(go test -race)
**Acceptance:** 9 endpoint shape 与 Express 等价 + 富化 queue Postgres-backed 不丢任务 + 2-tier cache 主从决策 documented

#### P2.2 — `/api/auth/*` + JWT + Gmail SMTP (18-28 hr)

```
├── 7 个 endpoint:
│   POST /register /login /refresh /logout /forgot-password /reset-password/:token
│   GET /me
├── JWT (golang-jwt/v5):
│   access 15min HS256,JWT_SECRET from env
│   refresh 7day,httpOnly cookie + users.refresh_token 列
├── bcrypt(golang.org/x/crypto/bcrypt,cost=10,与 Express 兼容)
├── Gmail SMTP via net/smtp + GMAIL_USER/APP_PASSWORD
├── express-validator → go-playground/validator/v10 struct tag
├── express-rate-limit (10 req/15min) → 自实现 in-memory token bucket
└── 重置密码 crypto.randomBytes(32) → crypto/rand

⚠️ 二轮 review 4A 双接过渡:
   Go middleware 同时接受 Authorization: Bearer <jwt>(老 localStorage 来源)
   和 Cookie(新 httpOnly)。Cookie 主、header 后兼容 7 天。
   UI 在 banner 提示"安全升级,部分用户需重新登录"
   T+7 cookie-only,header reject 401。
```

**Tests:** register→login→me→refresh→logout E2E + bcrypt hash 兼容性 + 密码重置邮件 mock
- **二轮 review 4C** bcrypt fixture **必须用 mongo dump 真 prod hash sample(3-5 条),不是 unit test 时 hash 出的新值**
- **二轮 review 4A NEW** dual-accept unit + E2E:同一 token 通过 header / cookie 两种方式均能过验,T+7 后 header reject
**Acceptance:** 现有 Express 用户登录在 Go 后端成功(bcrypt 兼容)+ dual-accept 7-day cutover 平滑

#### P2.3 — `/api/admin/*` + adminAuth (15-22 hr)

```
├── 14 个 endpoint(stats/enrichment CRUD/users CRUD/heal-cn pause-resume/warm-all)
├── adminAuth middleware:JWT 解码 role 字段 = "admin"
├── 富化 queue 控制(pause/resume V3 queue,通过 river PauseQueue)
├── warm-all 后台跑,respond 立即(goroutine + sync.Mutex 防并发)
└── 用户 CRUD 级联删除(事务):DELETE users + subscriptions + follows
```

**Tests:** 14 endpoint shape diff + 越权 E2E(非 admin 401)+ 级联删除事务测试
**Acceptance:** admin 流程跟 Express 等价

#### P2.4 — `/api/subscriptions/*` + `/api/users/*` + `/api/feed` (12-18 hr)

```
├── /api/subscriptions: 5 endpoint(list/get/upsert/update/delete)
├── /api/users/:username/{follow,followers,following,profile}: 5 endpoint
├── GET /api/feed:活动流分页
├── follow 表设计:UNIQUE (follower_id, followee_id)
├── feed:JOIN subscriptions + users + anime_cache,500 followee 上限
└── 创建 subscription 时 side-effect:确保 anime 在 cache 里(否则触发 AniList fetch)
```

**Tests:** 移植 server/__tests__/follow.controller.test.js 和 profile.controller.test.js 的 23 个测试到 testify
**Acceptance:** follow/profile/feed 跟 Express 等价

#### P2.5 — `/api/comments/*` + `/api/danmaku/*` HTTP (8-12 hr)

```
├── /api/comments: 3 endpoint(list/post/delete)
│   adjacency-list 回复树通过递归 CTE 实现
├── /api/danmaku/:anilistId/:episode: 1 endpoint(读 500 条 + live_ends_at)
└── 写弹幕走 socket.io,不在本 phase
```

**Tests:** 评论树读取 ≡ Mongo 输出,递归 CTE 性能 OK
**Acceptance:** 评论 + 历史弹幕读取等价

#### P2.6 — `/api/dandanplay/*` + 3-phase match (二轮 review 6C +12hr → **24-37 hr**)

```
├── 4 endpoint(/match /search /comments/:episodeId /episodes/:animeId)
├── 3-phase match 逻辑(二轮 review 6C 修正描述,Bangumi 真实角色:2s timeout 兜底):
│   Phase 1: matchCombined(fileName + 可选 fileHash/fileSize) → dandanplay /api/v2/match
│            ⚠️ loose-match accept gate:!isMatched 时若 titleLooselyMatchesKeyword 通过仍接受
│            (normalizeTitle 剥离的 28-char Unicode 标点表必须按 server/utils/episodeMap.js 全部复刻)
│   Phase 2: keyword → AnimeCache 4-title regex 搜(Mongo → PG 用 pg_trgm + gin_trgm_ops)
│            → 候选 bgmId → fetchDandanEpisodes(bgmId);Bangumi 调用仅在 findSiteAnime 2s timeout 兜底
│   Phase 3: per-file fallback (files[] 提供时);仅接受 isMatched: true
├── buildEpisodeMap 3-level fallback(高 off-by-one 风险,必须 testify 全覆盖):
│   L1: 精确数字 e.number == ep
│   L2: OVA/Special rawEpisodeNumber 匹配 ^[OS](\d+)$
│   L3: regulars (rawEpisodeNumber ^\d+$) pool index 1-based:pool[epNum - 1]
│   ⚠️ usedIds dedup(不同集 不能指向同一 dandan episodeId)
├── 6 个 episode-number regex 优先级(server/services/dandanplay.service.js 第 133-145 行):
│   Japanese kanji 第N話/话/集 + extractEpisodeNumber 链 — 全部复刻
├── 限流共享(golang.org/x/time/rate):
│   AniList 700ms, Bangumi+Dandanplay 各 800ms,独立 limiter
│   ⚠️ Go 必须 goroutine-safe(原 Express closure 不是 mutex)
├── dandanplay app_id + app_secret 通过 env 注入(headers X-AppId / X-AppSecret,无 HMAC)
├── 整体 /match timeout cap(防 Phase 1 + N×Phase 2 + Phase 3 级联 8s 爆走):20s 总 timeout
└── ristretto 缓存(30min comments / 24h episodes,双 key `bgm:` / `dan:` 前缀)
```

**Tests:** /match 3-phase 路径每一条都有 testify case + timeout 兼容
- **二轮 review 6C** buildEpisodeMap 3-level edge testify 全覆盖(普通集 / OVA / Special / index 0-based vs 1-based 边界)
- **NEW** loose-match accept gate testify case(假 dandanplay 返回 !isMatched 但 title 模糊匹配)
- **NEW** AnimeCache pg_trgm 替换正确性:同 keyword 在 Mongo regex vs PG pg_trgm 命中集 diff < 5%
- **NEW** findSiteAnime 2s timeout 真触发(mock bangumi 4s response → assert 早退)
- **NEW** 整体 /match 20s timeout cap 测试(mock Phase 1+2+3 各 8s → 整体 20s abort)
**Acceptance:** /match 命中率 ≥ Express 的 99%(基于 staging 流量回放)+ buildEpisodeMap 0 off-by-one

#### P2.7 — testify + testcontainers-go 等价重写 311 测试 (60-80 hr)

```
├── server/__tests__/ 311 个 Jest+Supertest 测试逐一重写为 testify(原 plan 写 317,实际 311)
├── testcontainers-go 起 real postgres,跑每个集成测试隔离 DB
├── 测试组织:
│   go-api/internal/handlers/*_test.go    单元
│   go-api/internal/services/*_test.go    服务层单元
│   go-api/test/integration/*_test.go     端到端
├── Go test coverage gate:`go test -cover` ≥ 80%(对标 client 现有 1342)
└── CI: GitHub Actions 跑 go test + testcontainers (需 Docker-in-Docker)
```

**Tests:** 这就是测试本身
**Acceptance:** 311 个测试全绿 + 覆盖率 ≥ 80% + shape-diff regression suite 全过

**M2 整体 Acceptance:**
- 48 个 HTTP endpoint Go 实现完成(admin 14 + anime 9 + auth 7 + sub 5 + user 5 + comment 3 + danmaku 1 + dandan 4)
- 311 测试等价覆盖
- staging 部署的 Go 实例与 Express shape diff 6 关键路径全部等价
- river 富化 queue 重启不丢任务

#### P2.8 — ws-server 拆分 (二轮 review 3A NEW, 10-15 hr)

今天 socket.io 跟 Express 同进程跑(`server/index.js:125 setupSocket(server)`)。big-bang cutover 前必须拆出独立 Node 服务。

```
├── 新建 ws-server/ 目录(独立 package.json + Dockerfile + dev script)
│   ws-server/
│   ├── index.js                 socket.io setup + JWT verify + handlers
│   ├── danmaku.handler.js       (从 server/socket/ 平移 + 替换 mongoose → pg)
│   ├── Dockerfile               (Node 22-alpine)
│   ├── package.json             (socket.io, pg, jsonwebtoken)
│   └── .dockerignore
│
├── 数据访问改造(平移 server/socket/danmaku.handler.js 逻辑):
│   ├── EpisodeWindow.findOneAndUpdate → INSERT INTO episode_windows ... 
│   │                                     ON CONFLICT (anilist_id, episode) DO NOTHING
│   │                                     RETURNING live_ends_at;
│   │                                     若 nothing returned 再 SELECT(保留 $setOnInsert 原子性)
│   ├── Danmaku.create → INSERT INTO danmakus ... RETURNING id
│   └── 广播 payload {_id} → {id} (Postgres bigint/uuid,client 跟着改)
│
├── Auth(共享 JWT_SECRET via env;7C 说明 mirror Go 验证逻辑 <30 行):
│   socket.handshake.auth.token → jwt.verify(token, process.env.JWT_SECRET)
│   per-packet exp recheck 保留(server/socket/index.js:18-25 平移)
│   socket.user.userId 类型 必须跟 Go users.id FK 一致(UUID 或 bigint,Plan 后期定)
│
├── 二轮 review 2P:5s rate-limit Map cap 10K silent overflow 修
│   `Map` → `lru-cache@10000`,evict 最久未用
│   测:11000 unique userId 并发,assert 第 10001 个无 silent stop tracking
│
├── 配置:
│   PORT 3001,CORS_ORIGIN 改成 :3000(Next.js)(原代码 hardcoded :5173 Vite)
│   POSTGRES_URL 从 env 注入
│
└── 测试:
    ├── 4 events shape diff(join/leave/send/new)
    ├── EpisodeWindow ON CONFLICT race test(100 并发 send,assert live_ends_at 一致)
    ├── JWT 跨进程一致性:Go 签的 token,ws-server verify 成功
    └── LRU rate-limit 超 cap 之后仍生效
```

**Acceptance:** ws-server 跑独立容器,弹幕端到端工作,JWT 跨服务一致,LRU rate-limit 0 silent overflow

### Phase 3 — Next.js 16 骨架 + Bun (15-25 hr,二轮 review 1A 改版本)

```
├── bunx create-next-app@latest next-app --typescript --app --src-dir --eslint
│   ⚠️ Next.js 16:Turbopack stable (build + dev),React 19 默认,async cookies/headers
├── package.json scripts 切 bun
├── rm package-lock.json && bun install → bun.lockb
├── bun add -d bun-types
├── tsconfig.json (strict: false, moduleResolution: bundler, types: ["bun-types"])
├── next.config.js rewrites:
│   /api/* → http://localhost:8080/api/* (Go staging during dev)
├── 启动: bun --bun next dev + go run ./go-api/cmd/server + docker-compose up postgres
└── baseline 测量(二轮 review 8A + TODO-1 扩展):
    docs/migration/BASELINE.md 写入
      - v2.0.1 SPA 当前 Lighthouse(/、/anime/154587、/seasonal/spring/2026)
      - 当前 Express+Mongo 错误率 7 天 baseline
      - socket.io 7 天断流率(M8 canary 对照)
      - GSC 索引数(M2/M3 acceptance 对照)
      - **二轮 review 8A NEW** Express prod metrics 7 day:
        ◦ req/s p50/p95/p99 + 日峰值(从 nginx access_log 提)
        ◦ socket.io 同时在线连接数 7-day max
        ◦ P8.5 shadow 阈值改成 "P99 < baseline P99 × 1.5",不再 hardcode 200ms
      - **二轮 review Pf4/TODO-1 NEW** VPS 出方向带宽 30-day baseline:
        ◦ vnstat / iftop 当前 monthly outbound
        ◦ VPS 提供商带宽 plan threshold
        ◦ P8.5 mirror 需要 sample 比率(若 baseline × 2 > threshold 则 mirror 50% throttle)
```

**Tests:** Next + Bun dev/build/test 三链路全绿
**Acceptance:** `localhost:3000` 出 Next 默认页 + API rewrite 到 :8080 拿到真数据 + BASELINE.md 全 7 项数据写入

### Phase 4 — Public Pages RSC (17-27 hr)

```
├── LandingPage → Server Component
│   fetch from Go /api/anime/trending + yearly-top (RSC fetch)
├── About / Privacy / Terms → RSC
├── metadata API (title / OG / Twitter card)
├── sitemap.xml 生成器(基于 anime IDs from Go)
└── ⚡ UI mitigation (+2 hr,见 §3.7):
    ├── A1 inline script 防 lang/danmaku FOUC
    └── /、/about、/privacy 各加 loading.tsx skeleton
```

**Acceptance:** Lighthouse SEO ≥ 95 + LCP < 1.5s + view-source 看到 anime 数据

### Phase 5 — SEO 核心 ISR (18-33 hr)

```
├── /anime/[id] → ISR (revalidate 60s)
│   通过 Go /api/anime/:id 拿数据
│   ⚠️ 二轮 review Pf1 dual-mode:
│      Go API 实现 2 套 query strategy(feature flag):
│        - "fanout":8 个 SELECT(N+5)
│        - "agg":single SELECT … json_agg(*) … FROM anime_cache LEFT JOIN …
│      P8.5 shadow 期间 同 query 两套都跑,Grafana P99 + payload size 对比
│      P10 拍板默认走哪个,benchmark 在线
│   JSON-LD TVSeries schema
├── /seasonal/[season]/[year] → ISR
├── /search → searchParams 服务端 + 客户端混合
├── robots.txt + structured data
└── ⚡ UI mitigation (+3 hr,见 §3.7):
    ├── B1: anime_cache 加 accent_color 字段 + migration script 回填
    │       AnimeCard 改读 props.accentColor
    ├── /anime/[id]、/seasonal、/search 各加 loading.tsx skeleton
    └── AnimeCard <Link prefetch={false}>
```

**Acceptance:** /anime/[id] LCP < 1s + Lighthouse SEO 100 + JSON-LD Rich Results 验证通过

### Phase 6 — Library + Player + libass-wasm 平移 (45-85 hr)

```
├── /library + /player 全部 'use client'
│   Dexie / IndexedDB / FSA / artplayer / dandanplay-vi / jassub 全部 dynamic({ssr:false})
├── react-router-dom → next/navigation 全替换(72 文件)
├── libass-wasm 从 v2.0.1 平移:
│   Vite 配置 → Next.js 等价(public/jassub/ 不变)
│   mkvSubtitle worker(Blob URL + pako)不变
│   jassubOverlay.js 不变(只是 import 路径)
├── reauth E2E(补充 v2.0 已有的 6 个 wiring 单元测试,不替代)
└── ⚡ UI mitigation (+5 hr,见 §3.7):
    ├── 'use client' 边界审计:grep -rn "useState|useEffect|window|document" app/library app/player
    ├── /library、/player 各加 loading.tsx skeleton
    └── 50+ 文件夹 hydration 测试,Console 红色 warning 清零
```

**Acceptance:** E2E 全 flow + 50+ 文件夹无 hydration mismatch + libass 字幕跟 v2.0.1 一致

### Phase 7 — Admin RSC + middleware (15-25 hr)

```
├── /admin/* → middleware.ts 鉴权(role check,runtime: nodejs)
├── 各 admin 页面 RSC 化能 RSC 的部分
└── ⚡ 顺路完成:待办十七(admin 富化速率保护)— river queue control endpoint 实现
```

**Acceptance:** E2E admin 角色越权测试 + admin 操作走 river queue

### Phase 8 — 部署架构 (30-50 hr)

```
├── 3 个 Dockerfile(二轮 review 5C 删 Dockerfile.node;rollback 走 :rollback-T0 Express tag):
│   app/Dockerfile (Bun + Next 16 standalone)
│   go-api/Dockerfile (multi-stage build,distroless/static)
│   ws-server/Dockerfile (Node + socket.io,二轮 review P2.8 新拆出)
│
├── docker-compose.yml:
│   ├── app: Next standalone (端口 3000) [Bun]
│   ├── go-api: Go API (端口 8080) [distroless]
│   ├── ws-server: socket.io (端口 3001) [Node]
│   ├── postgres: 16-alpine (端口 5432) [自建]
│   ├── mongodb: 7 (端口 27017) [cutover 后保留 30 天]
│   └── nginx: 路由分发
│
├── nginx/default.conf:
│   location /socket.io/* → ws-server:3001 (WebSocket upgrade)
│   location /api/* → go-api:8080
│   location /_next/static/* → app:3000 (允许 CF 长 cache)
│   location / → app:3000
│   add_header Cross-Origin-Opener-Policy "same-origin"
│   add_header Cross-Origin-Embedder-Policy "credentialless"
│   add_header Cross-Origin-Resource-Policy "same-origin"
│   script-src 'wasm-unsafe-eval' for libass
│   Permissions-Policy local-fonts=(self)
│
├── Cloudflare cache rules:
│   /_next/static/* → Edge Cache TTL 1y
│   /anime/* /seasonal/* → Bypass (让 Next ISR 自管)
│   /api/* /socket.io/* → Bypass
│
├── CI/CD (.github/workflows):
│   build-go: oven/setup-bun + go test + docker build go-api
│   build-app: bun build + docker build app
│   deploy: ssh VPS + docker compose up -d
│   ⚠️ 二轮 review 5A:cutover T-1d 手动 trigger workflow
│      $ gh workflow run build-express --ref v2.0.1-stable
│      推 image tag :rollback-T0 到 registry,registry retention policy ≥ 30 day
│      docker compose 加 rollback service:
│         app-express:
│           image: ghcr.io/lawrenceli0228/animego-express:rollback-T0
│           profiles: [rollback]  # 默认不起动,docker compose --profile rollback up
│
└── ⚡ 顺路完成:待办十六(Sentry)
    sentry-go SDK for go-api
    @sentry/nextjs for app
    DSN via env
```

**Acceptance:** VPS 部署 staging 通过 + Sentry 收到 staging error 流

### Phase 8.5 — Shadow Traffic 1 周 (15-25 hr) ← critical gate

cutover 前 7 天,nginx mirror 复制 prod 流量到 Go,验证 P99。

```
├── nginx/default.conf 加 mirror directive:
│   location /api/ {
│     mirror /api-shadow;
│     mirror_request_body on;
│     proxy_pass http://express-prod:5001;  # 主流量仍走 Express
│   }
│   location = /api-shadow {
│     internal;
│     proxy_pass http://go-api:8080$request_uri;
│     proxy_request_buffering off;
│   }
│
├── Go side:
│   middleware 标记 X-Shadow-Traffic header → 收到后不返回真实响应
│   但走完所有逻辑(SQL query / external API / business logic)
│   写 metrics:延迟 P50/P95/P99 + 错误率 + per-endpoint counter
│
├── Prometheus + Grafana(轻量,docker-compose 加 2 个 service):
│   仪表盘:Go endpoint 延迟分布、错误率、SQL slow query log
│   告警阈值:错误率 > 1% / P99 > 500ms
│
├── 数据库:
│   shadow 期间 Go 写 staging Postgres(不是 prod Postgres,prod Postgres 是 cutover 时 migration 的目标)
│   shadow Postgres 用 prod mongodump dry-run 导入的副本
│
└── 7 天观察 + 2 个演练(二轮 review 1T + 2T NEW):
    Day 1-5:每日审 dashboard 找 P99 异常,fix Go bug,redeploy go-api 容器
    
    **Day 6 — Cutover dress rehearsal(1 小时窗口,staging-only)**:
      precondition:nginx 切到 dummy 503,只在 staging 网络层
      sequence: stop staging-ws-server → stop staging-Express → 跑 migration tool
              (用 staging mongo 副本) → row + field parity 反查 → nginx switch
              → 1h 烟雾 → 验证 cutover.sh 实际能 < 2h 完成
      acceptance:run 通过,实际耗时 录在 PLAN 状态表
    
    **Day 7 — Rollback drill(<5min 计时)**:
      precondition:staging Go API + Postgres 在线
      sequence: ssh staging-vps → sed -i 改 nginx upstream 回 Express
              → docker compose --profile rollback up app-express
              → nginx restart → curl /api/anime/154587 验证 Express 响应
      计时:从 sed 开始到 curl 成功,目标 < 5min
      acceptance:实际耗时 < 5min,录入 PLAN
    
    Day 7 收工:错误率 < 1% + P99 < baseline×1.5 + 两个演练都过 → 进 P9
    否则:延期,继续 fix
```

**Tests:** 7 天 shadow 期间 endpoint 覆盖 100%(每个 endpoint 都至少被影子访问 > 1k 次)
- **NEW** Day 6 自动校验脚本:scripts/check-coverage.sh 跑 SELECT count(*) FROM go_request_log WHERE endpoint = ANY(...) GROUP BY endpoint,assert 每个 endpoint count ≥ 1000
- **NEW** Shadow Postgres 隔离测试:Go 中 SHADOW_TRAFFIC=true 时禁止 INSERT/UPDATE/DELETE,unit test
- **二轮 review 1T NEW** Day 6 cutover rehearsal 必须过
- **二轮 review 2T NEW** Day 7 rollback drill 必须 < 5min

**Acceptance:** P99 < baseline×1.5 + 错误率 < 1% + 0 Go panic + 0 Postgres deadlock + cutover rehearsal pass + rollback drill < 5min

### Phase 9 — Big-Bang Cutover (10-20 hr)

凌晨 3-5am UTC+8 维护窗口。提前 7 天 announce。

```
预 cutover (T-7 day):
├── 全站 banner "5-12 03:00-05:00 维护"
├── 关闭注册 24h 前(避免 cutover 期间新用户写丢)
└── shadow traffic 最终 review,签字进 cutover

T+0 (03:00 UTC+8) — 二轮 review 5T 修正序列:
├── nginx 503 maintenance mode 上(Cloudflare worker level,/api/* 跟 /socket.io/* 都 503)
├── **先 stop ws-server**(P2.8 拆出后是独立容器):不接新弹幕写,等现有 WebSocket 自然关闭(<60s)
├── Express 容器 stop:只接现有 HTTP 完成,不接新
├── 等所有 in-flight HTTP 完成
├── ws-server + Express 容器 destroy(image 通过 :rollback-T0 已经在 registry,本机 prune 也无所谓)
├── 跑 migration tool:
│   go run ./go-api/cmd/migrate-mongo --mongo-uri=... --pg-uri=... --commit
│   预计 < 30 分钟(基于 staging dry-run)
├── 跑 row count 一致性校验:
│   docker exec ... psql -c "SELECT COUNT(*) FROM ..." 对比 mongo
│   差异 < 0.1% 通过
├── nginx 改 upstream:
│   /api/* → go-api:8080(原来是 express:5001)
│   /socket.io/* → ws-server:3001(不变,但 ws-server 改连 Postgres for danmaku read)
├── nginx 摘 503,放流量
└── 04:30 cutover 完成,1 小时缓冲观察

T+1 hour:
├── Grafana dashboard 错误率 < 0.5% ✓
├── Sentry 错误流 review
└── 验证 1 个真实用户登录 + 加文件夹 + 播放

T+24h:
├── 错误率累计 < 1% ✓
├── Postgres slow query log 没异常
├── 用户报告 0 critical bug
└── 宣布 cutover 成功

T+24h 之后:
├── ❗ 不再支持 rollback(详见 § 4)
└── mongo 容器继续跑 30 天(冻结,无新写入),仅作灾难恢复

T+30 day:
├── docker compose stop mongodb
├── mongodump 上传 R2 (animego-backup/final-mongo-cutover.dump.gz)
├── docker compose rm mongodb
├── 删 mongo-data volume
└── R2 mongodump 保留 90 天后删
```

**Tests:** P8.5 已覆盖 + cutover 后 1h smoke test
**Acceptance:**
- T+24h 错误率 < 1%
- 0 critical bug
- nginx switch < 5 分钟
- migration tool < 30 分钟
- 总 maintenance window < 2 小时

### Phase 10 — Lighthouse CI + Sentry + Playwright E2E (15-30 hr)

```
├── 5 个关键 Playwright E2E:
│   注册 → 登录 → 加文件夹 → 播放
│   番剧详情 → 订阅 → watchlist
│   重新授权 reauth
│   admin 越权
│   弹幕实时发送(socket.io 流)
├── Lighthouse CI on every PR:
│   /, /anime/154587, /seasonal/spring/2026
│   LCP regression > 10% → block merge
├── Sentry production DSN 接入 go-api + app
│   **二轮 review TODO-3 NEW**:注入 fake error → 验证 30s 内 Sentry dashboard 可见 + email/Slack 推送收到
│   acceptance: sentry-cli send-event fake → 真 alert 到 inbox
├── **二轮 review TODO-4 NEW** Playwright 视觉回归:
│   threshold 0.1% pixel-diff
│   CI block > 0.5%
│   update baseline 需 PR 评论 "visual: ok" 触发 workflow re-snapshot,不手动 approve 文件
├── **二轮 review (test gap) NEW** Phase 8 五 nginx header 联动测试:
│   Playwright 启 wasm + libass + cross-origin font load
│   COOP/COEP/CORP + WASM-CSP + Permissions-Policy 一起跑
│   console.error 清零
├── pg_stat_statements 启用 + slow query > 100ms 告警
├── pgx pool size 25 (二轮 review Pf5,从默认 10 提升 shadow 阶段已验)
├── ristretto sizing(二轮 review Pf6):anime_cache lookup cache 容量按 47K 算 50MB,加监控
├── P5 dual-mode P10 拍板:基于 P8.5 数据决定 8-query 或 json_agg 默认
└── client 1328 测试适配 next/navigation(原 plan 写 1342,实际 1328)
```

**Acceptance:**
- 1328 client + 311 go-api + 5 E2E 全绿
- Lighthouse 不退化 > 10%
- Sentry alert wiring 验证通过
- 视觉回归 baseline 建立 + workflow 可重 snap
- 5 nginx header 联动 0 console.error
- detail page query strategy 决定 + 文档

---

## 3. Architecture Risks

| ID | 风险 | 概率 | 后果 | Mitigation |
|----|------|------|------|-----------|
| **R0** | **Big-bang cutover 真发现 prod bug** | 中 | 24h 内回滚,Postgres 写入丢(用户重做) | P8.5 shadow traffic 提前 7 天覆盖 + § 4 24h 真实窗口 |
| **R1** | **migration tool 在 prod mongo 数据上崩** | 中 | cutover 时停摆 → 延期 | P1 strict dry-run on prod mongodump 副本 |
| **R2** | Go pgx connection pool 调小了高峰跑爆 | 低 | 503 高峰短期 | pgx pool 默认 10,P8.5 shadow 阶段 benchmark |
| **R3** | river queue 重启 / 跨进程行为跟 in-memory queue 不同 | 中 | 富化丢任务 / 重复执行 | P2.1 集成测试覆盖 + Postgres-backed 天然持久 |
| **R4** | jassub libass-wasm 在 Next.js 14 比 Vite 表现退化 | 低 | 字幕渲染 bug | P6 平移直接复用 v2.0.1 代码 + Playwright 截图 diff |
| **R5** | **IndexedDB / FSA / artplayer 漏标 'use client' 白屏** | 高 | P6 大量 debug | P6 中段强制 E2E + Console warning 清零 |
| **R6** | bcrypt cost=10 hash 跨语言不兼容 | 低 | 老用户登录失败 | P2.2 必须直接验证现有 mongo 中的 hash |
| **R7** | Auth cookies 切换 forced logout | 必然 | 全员重新登录 1 次 | P8.5 前公告 + grace period |
| **R8** | **全 normalize 详情页 N+5 join 真的慢** | 中 | LCP 退化 | P5 + P10 benchmark + 必要时退到 single JOIN |
| **R9** | ws-server (Node + socket.io) 跟 Go 服务双 JWT 验证不一致 | 中 | 弹幕被拒 / 越权 | 共享 JWT_SECRET via env + ws-server 验证用 Go 同一套 secret |
| **R10** | Postgres VPS 自建无 HA,单点故障 | 中 | postgres 崩 → 全站 500 | docker restart unless-stopped + R2 nightly backup + 30s 自愈 |
| **R11** | 5-runtime 异构栈(Bun/Go/Node/Postgres/mongo)运维心智负担 | 高 | on-call 难 | 文档明示;cutover 后 30 天去 mongo,4-runtime 是稳态 |
| **R12** | **VPS outbound 带宽 P8.5 mirror 翻倍可能撞 cap**(二轮 review Pf4) | 中 | shadow 流量错乱 | P3 baseline 测当前 outbound;若 ×2 > cap 则 mirror 50% throttle |
| **R13** | **Cutover T+0 序列首次现场跑**(二轮 review 1T) | 高 | 进度卡死 / 数据 corruption | P8.5 day-6 dress rehearsal,staging-only |
| **R14** | **24h rollback 链 image 被 prune**(二轮 review 5A) | 中 | 无法 rollback | cutover T-1d 推 :rollback-T0 tag,registry 30天 retain |
| **R15** | **Auth localStorage → cookie 强制重登 silent 401**(二轮 review 4A) | 高 | UX 灾难 | Go middleware dual-accept header + cookie 7天 + UI banner |
| **R16** | **ws-server rate-limit Map cap 10K silent overflow**(二轮 review Pf2) | 中 | 弹幕 spam 防御失效 | P2.8 换 LRU 有界 |
| **R17** | **dandanplay match Go port off-by-one**(二轮 review 6C) | 中 | 部分集 dandanplay 命中错位 | P2.6 testify 全覆盖 buildEpisodeMap 3-level |
| **R18** | **CASCADE FK 误删数据**(二轮 review 1C) | 低 | admin 误删 user 连带删 sub/follow/comment/danmaku | schema 明确 CASCADE,UI 加 "确认删除 N 条" 二次确认 |

**R0 / R1 / R5 / R8 / R13 / R15 是 critical**,必须提前规划 mitigation。

---

## 3.5 Phase Gating 规则

每个 phase 进下一个之前必须满足:

1. **Tasks 全勾** — phase 内所有 checkbox 完成
2. **Tests 全绿** — `go test ./...`(Go)+ `bun run vitest`(client)+ phase 新加的 E2E 全过
3. **Acceptance 验证** — 该 phase Acceptance 列的指标都达标
4. **Commit + push** — feat/go-backend 分支已合并 PR(或至少 commit)
5. **Rollback 链可用** — 验证能回上一个 phase 状态

特殊 gates:

- **P0 → P1 gate:** R2 backup → pg restore 演练通过 + scripts/dev.sh 一键起
- **P1 → P2 gate:** migration tool dry-run on prod mongodump 数据通过,row count diff < 0.1% + field parity 10×1000 全过
- **P2.7 → P2.8 gate:** 311 Go test 全绿 + 覆盖率 ≥ 80% + dandanplay 0 off-by-one
- **P2.8 → P3 gate:** ws-server 拆出独立容器,弹幕端到端工作,LRU rate-limit 替代验证
- **P6 → P7 gate:** 50+ 文件夹无 hydration mismatch + 5 个 client Playwright E2E 绿
- **P8 → P8.5 gate:** staging 部署完整 3 容器(+ rollback profile),Sentry 收到 staging error 流,sentry alert 验证通过
- **P8.5 → P9 gate (CRITICAL):** 7 天 shadow 错误率 < 1% + P99 < baseline×1.5 + 0 Go panic + Day-6 dress rehearsal pass + Day-7 rollback drill <5min
- **P9 → P10 gate:** T+24h 错误率累计 < 1%,0 critical bug

**违规处理:** 任何 gate 不达标,**不进下一个 phase**。退回修。

---

## 3.6 Migration Impact

下表把老 TODO 映射到具体 phase task。

| 旧 TODO | Phase | Sub-task | 关闭条件 |
|---------|-------|---------|---------|
| 待办四 `User.isPublic` | P2.2 | 加 `users.is_public BOOLEAN DEFAULT true` 列 | P2.2 PR merge |
| 待办 `enqueueEnrichment` 支持 bgmId 键 | P2.1 | river 任务支持 bgmId 入队 | P2.1 PR merge |
| 待办磁力 cache 持久化 | P2.1 | torrent cache 改 Postgres 表(取代 in-memory ristretto) | P2.1 PR merge |
| 待办五 WebSocket Redis Pub/Sub | ws-server 改造 | 长期 follow-up,本 plan 不涉及 | 不在 v2 plan 范围 |
| 待办十六 Sentry 错误监控 | P8 | Sentry SDK 双 service 注入 | P8 PR merge |
| 待办十七 Admin 富化速率保护 | P2.3 + P7 | river queue control endpoint + admin UI | P7 PR merge |

**强制要求:** phase PR 必须在 commit message 写 `Closes TODO #X`。

---

## 3.7 UI 迁移风险审计

> 这次后端换 Go 后,**前端 UI 风险跟 v1 plan 完全一样**(后端语言不影响 Next.js SSR 行为)。复用 v1 plan §3.7 的 7 个风险审计。

| # | 风险 | 严重度 | 现象 | Phase | Mitigation |
|---|------|-------|------|-------|-----------|
| U0 | Hydration mismatch | ★★★ | 进 `/library` 闪 200–500ms + Console warning | P6 | 'use client' 审计 + dynamic({ssr:false}) |
| U1 | localStorage FOUC | ★★★ | 服务器渲 ZH → 客户端切 EN 等闪 | P4 | A1 inline script |
| U2 | accentCache 卡片跳色 | ★★ | 首页 100+ 番剧卡 SSR 出灰色 → hydrate 跳色 | P5 | B1 anime_cache.accent_color 入 schema |
| U3 | Loading 态切换 | ★★ | RSC 没 fallback 时空白 | P4/P5/P6 | 5 个 loading.tsx skeleton |
| U4 | 强制重登期 login 页 | ★★ | cutover 后流量翻倍 | P9 前 | 视觉肉眼审 + 友好提示 |
| U5 | next/link 默认 prefetch | ★ | 滑首页触发 50+ 详情预加载 | P5 | AnimeCard prefetch={false} |
| U6 | 视觉回归无 baseline | ★ | 改 1 行 CSS 不知道哪里坏了 | P3 + P10 | P3 截 baseline + P10 Playwright 像素 diff |

详细 A1/B1 模板见 v1 plan git 历史(commit `94219e8`)。

---

## 4. Rollback Plan

### 24h 真实窗口(P9 cutover 后)

cutover 后 **24 小时内** 出现 critical bug,nginx 一行回 Express:

```bash
ssh root@45.152.65.208 "cd /opt/animego && \
  sed -i 's|proxy_pass http://go-api:8080|proxy_pass http://app:5001|' nginx/default.conf && \
  docker compose restart nginx && \
  docker compose start mongodb && \
  docker compose start app-express  # 重启 Express(P8 必须保留 Express dockerfile + image)
"
```

**前提条件:**
- Express + Mongo image 仍在 docker images 列表里(不要 prune)
- mongo 容器 stop 不 destroy(volume 保留)
- nginx config 有 "回 Express" 的注释 + 一行能恢复

**数据损失:** 24h 之间 Postgres 的所有 user-side 写入(注册、订阅、评论、弹幕)。Mongo 是 cutover 时的冻结快照。

### 超过 24h:不再支持 Rollback

**24h 之后,cutover 是 irreversible。** mongo 30 天保留 + R2 mongodump 90 天只用于:
1. **法律取证** — 用户数据 GDPR delete request 历史追溯
2. **灾难恢复** — Postgres 完全崩溃且 R2 pg_dump 同时不可用的极端 case
3. **审计** — schema 迁移 bug 事后复盘

**不可用作 rollback 路径。** 任何"切回 mongo"的操作都会丢失 cutover 后的所有用户写入。

### 完整 v2.0 SPA 回滚(放弃整个 plan)

```bash
ssh root@45.152.65.208 "cd /opt/animego && \
  git checkout v2.0.1-stable && \
  docker compose down && \
  docker compose build && \
  docker compose up -d
"
```

迁移期间 v2.0.1 必须保持稳定 tag 在 main 之外,**不能** rebase/force push 掉。

---

## 5. Worktree Parallelization

```
P0 (Go 骨架 + Postgres) → 必须串行
P1 (migration tool) → 必须串行,基础

P1 完成后可分 lane 并行:
  Lane A: P2.1 (anime + 富化)                [worktree-anime]
  Lane B: P2.2 (auth) + P2.3 (admin)         [worktree-auth-admin]
  Lane C: P2.4 (sub + user) + P2.5 (comment) [worktree-social]
  Lane D: P2.6 (dandanplay,二轮 review 6C 加重)  [worktree-dandan]

  P2.x 完成后(P2.8 独立):
  Lane E: P3 + P4 + P5 (SEO 静态前端)        [worktree-seo]
  Lane F: P6 (Library + Player + libass)     [worktree-app]
  Lane G: P7 (Admin)                          [worktree-admin]
  Lane H: P2.8 (ws-server 拆分)              [worktree-ws]     ← 二轮 review 3A NEW
        共享 PG schema + JWT_SECRET,跟其他 lane 独立

P2.7 (测试编写)持续穿插,每个 P2.x 完成后同步写
P8 (部署架构) 必须等所有 lane 合并(含 P2.8)
P8.5 (shadow) 必须等 P8 完成
P9 (cutover) 必须等 P8.5 7 天通过(含 day-6 rehearsal + day-7 rollback drill)
P10 (测试 + 性能) 持续穿插
```

**冲突警告**(二轮 review 加):
- Lane H(P2.8 ws-server)跟 Lane A(P2.1 anime + 富化)都会创建 PG `danmakus` 表的引用 — schema migration 0001 必须在两 lane 都 fork 之前 land,所以 P1 migrations 是 P2.x 全部 lane 的 base 依赖。

单人 + Claude Code 协作下并行能压缩 30-50 hr。

---

## 6. 起步动作 (P0 第一天)

```bash
# 1. 起分支
git checkout -b feat/go-backend

# 2. 起 Go 项目
mkdir -p go-api && cd go-api
go mod init github.com/lawrenceli0228/animego/go-api
go get github.com/go-chi/chi/v5
go get github.com/jackc/pgx/v5
go get github.com/sqlc-dev/sqlc/cmd/sqlc
go get github.com/golang-jwt/jwt/v5
go get github.com/riverqueue/river

# 3. 跑 sqlc init 生成基础结构
sqlc init

# 4. Docker compose 加 postgres
cat >> docker-compose.yml <<EOF
postgres:
  image: postgres:16-alpine
  environment:
    POSTGRES_USER: animego
    POSTGRES_PASSWORD: $POSTGRES_PASSWORD
    POSTGRES_DB: animego
  volumes:
    - postgres-data:/var/lib/postgresql/data
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U animego"]
EOF

# 5. R2 + rclone setup
# 一次性手动配置:rclone config → r2 backend → bucket animego-backup

# 6. 加 nightly backup cron(VPS 上 crontab -e)
0 3 * * * docker exec animego-postgres-1 pg_dump -U animego animego | gzip | rclone rcat r2:animego-backup/pg-$(date +\%F).sql.gz

# 7. 验证 backup → restore 演练(P0 acceptance)
rclone cat r2:animego-backup/pg-2026-05-12.sql.gz | gunzip | docker exec -i postgres-staging psql -U animego animego
```

P0 收工标准:**Go + Postgres 起来,空 chi router :8080/health 返回 OK,R2 backup→restore 演练通过。**

---

## 7. Status Tracking

| Phase | Status | Started | Completed | Hours actual |
|-------|--------|---------|-----------|-------------:|
| P0 Go 骨架 + Postgres + Backup | not started | — | — | — |
| P1 Migration Tool | not started | — | — | — |
| P2.1 /api/anime/* | not started | — | — | — |
| P2.2 /api/auth/* | not started | — | — | — |
| P2.3 /api/admin/* | not started | — | — | — |
| P2.4 /api/sub + user + feed | not started | — | — | — |
| P2.5 /api/comments + danmaku | not started | — | — | — |
| P2.6 /api/dandanplay/* | not started | — | — | — |
| P2.7 testify + testcontainers | not started | — | — | — |
| P2.8 ws-server 拆出 (NEW) | not started | — | — | — |
| P3 Next.js 16 骨架 + Bun | not started | — | — | — |
| P4 Public Pages RSC | not started | — | — | — |
| P5 SEO 核心 ISR | not started | — | — | — |
| P6 Library + Player | not started | — | — | — |
| P7 Admin RSC | not started | — | — | — |
| P8 部署架构 | not started | — | — | — |
| P8.5 Shadow Traffic | not started | — | — | — |
| P9 Big-Bang Cutover | not started | — | — | — |
| P10 Lighthouse + Sentry + E2E | not started | — | — | — |

---

## 8. 后续 TODO (cutover 后)

- [ ] 开 `strict: true` 清扫 `any`(20-40 hr)
- [ ] Lighthouse CI on every PR,LCP regression block merge
- [ ] Go server-side schema 与 client TS 端到端类型 (e.g., codegen via OpenAPI spec)
- [ ] React 19 升级(等 Next 官方 stable)
- [ ] ws-server → Go(等 socket.io v4 Go 库成熟,可能永不迁)
- [ ] Postgres → managed (Supabase / Neon) 如果 VPS 不够用了
- [ ] 待办五:socket.io-redis adapter(多 ws-server 实例时)

---

## Appendix A — 关键决策日志

| 日期 | 决策 | 备选 | 选择 | 理由 |
|------|------|------|------|------|
| 2026-05-12 | 后端语言 | Bun+TS / Go / Rust | **Go** | 单二进制,内存小,并发模型适合 worker queue |
| 2026-05-12 | ORM | GORM / Bun / sqlc / Ent | **pgx + sqlc** | 类型安全 SQL,0 reflection,可读 |
| 2026-05-12 | 数据库 | Postgres / MySQL / Mongo | **PostgreSQL 16** | tsvector + JSON 完整,Go 生态默认 |
| 2026-05-12 | DB 部署 | Supabase / Neon / 自建 | **VPS docker 自建** | 跟 mongo 同 pattern,0 新账单,内网低延迟 |
| 2026-05-12 | Schema | JSONB 全部 / normalize 全部 / hybrid | **全 normalize** | 关系查询完整,JOIN 性能信赖 Postgres |
| 2026-05-12 | socket.io | Node 留 / 客户端 raw WS / 等 Go 库 | **Node 永久保留** | Go 库 v4 支持不成熟,接受异构架构 |
| 2026-05-12 | 迁移路径 | strangler-fig / big-bang / dual-write | **big-bang + shadow traffic** | nginx 一行切回,不维护双路由复杂度 |
| 2026-05-12 | 回滚窗口 | 30 天 / 24h / 永久 | **24h 真实 + 30 天 mongodump 灾难恢复** | 30 天 rollback 是伪;诚实表述 24h |
| 2026-05-12 | 迁移工具语言 | Go / Node / Python | **Go** | 跟 backend 同语言,单二进制可重复执行 |
| 2026-05-12 | 测试 | 隐藏在 P10 / 拆 P2.7 / 缩水覆盖 | **拆 P2.7 (~80 hr)** | "well-tested code is non-negotiable" |
| 2026-05-12 | 详情页 read | 单 JOIN / N+5 / 并发 fan-out | **N+5,先信赖 Postgres** | 不预先优化,P10 benchmark 再决定 |
| 2026-05-12 | Cutover 前验证 | 直接 cutover / shadow / canary 5% | **shadow 1 周** | 不切流量但收影子,big-bang 前最后保险 |
| 2026-05-12 | mongo 容器 cutover 后 | 立即删 / 30 天 / 永久 | **30 天 + R2 90 天** | 灾难恢复,不是 rollback 路径 |
| 2026-05-12 | ws-server Postgres 连接 | 共享 JWT / 各自 verify | **共享 JWT_SECRET via env** | Go 跟 Node 同一套 secret,Postgres 读弹幕 |

---

## Appendix B — Innovation Token

按 Garry Tan / Dan McKinley 的 "三个 innovation tokens" 原则,本次迁移使用 **7 个 token**:

1. Next.js 全栈替代 Vite SPA + Express(Next.js 16 + React 19 默认 — 二轮 review 1A 修版本不算新 token)
2. Express → **Go 重写**(语言切换,48 endpoint + 8 个 domain)
3. **MongoDB → PostgreSQL 重写 schema**(7 collection → 14 表,全 normalize)
4. Node runtime → **Bun**(前端)
5. JWT localStorage → httpOnly cookies + 跨语言 middleware(dual-accept 7天过渡)
6. **异构后端**(Go HTTP + Node socket.io 永久微服务,二轮 review P2.8 显式拆出)
7. **Big-bang cutover** + shadow traffic + Day-6 rehearsal + Day-7 rollback drill(单次切流量 vs 灰度)

**预算超支 4 个 token**(7 vs 3)。这是高风险 pivot,通过以下方式 hedge:

- **R0 mitigation:** P8.5 shadow traffic 1 周 + 24h 真实回滚窗口
- **R1 mitigation:** P1 dry-run on prod mongodump 副本 + field-level parity test(二轮 review 6A)
- **R5 mitigation:** P6 'use client' 边界强制审计 + 自动 grep assertion script
- **R8 mitigation:** P5 dual-mode 实现(二轮 review Pf1)+ P8.5 shadow 对比 + P10 拍板
- **R13 mitigation:** P8.5 Day-6 dress rehearsal(二轮 review 1T)
- **R14 mitigation:** cutover T-1d 推 :rollback-T0 image tag(二轮 review 5A)
- **R15 mitigation:** Go middleware dual-accept header + cookie 7 天(二轮 review 4A)
- **完整 rollback 链:** 24h 内 nginx 一行回 Express;超过 24h 不支持(诚实)

**风险接受声明:** 用户已明确知悉 7 token 超支风险,接受 5-13 月业余周期 + cutover 可能延期 + 测试 100hr 显式成本。

---

## Appendix C — Go 关键代码模板

### Project layout

```
go-api/
├── cmd/
│   ├── server/main.go              # chi router + middleware + start
│   └── migrate-mongo/main.go       # one-shot migration tool (P1)
├── internal/
│   ├── config/                     # env var loading
│   ├── db/
│   │   ├── queries/*.sql           # sqlc input
│   │   └── gen/*.go                # sqlc generated
│   ├── middleware/                 # auth, ratelimit, cors
│   ├── handlers/                   # one per domain
│   ├── services/                   # business logic (anilist, bangumi, dandanplay)
│   └── jobs/                       # river workers
├── migrations/*.sql                # golang-migrate
├── sqlc.yaml
├── go.mod
└── Dockerfile (multi-stage, distroless)
```

### chi router 入口

```go
// cmd/server/main.go
package main

import (
  "net/http"
  "github.com/go-chi/chi/v5"
  "github.com/go-chi/chi/v5/middleware"
  // ...
)

func main() {
  r := chi.NewRouter()
  r.Use(middleware.Logger, middleware.Recoverer, middleware.RealIP)
  r.Use(rateLimit(300, time.Minute))

  r.Mount("/api/anime", animeHandler(deps))
  r.Mount("/api/auth", authHandler(deps))
  r.Mount("/api/admin", adminHandler(deps))
  // ... 6 more domains

  r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("ok"))
  })

  http.ListenAndServe(":8080", r)
}
```

### sqlc query example

```sql
-- internal/db/queries/anime.sql
-- name: GetAnimeByID :one
SELECT * FROM anime_cache WHERE anilist_id = $1;

-- name: GetAnimeCharacters :many
SELECT * FROM anime_characters WHERE anime_id = $1 ORDER BY display_order;
```

→ sqlc 生成 `db.GetAnimeByID(ctx, anilistID)` 返回 `AnimeCache` struct,完整类型安全。

### pgx connection pool

```go
import "github.com/jackc/pgx/v5/pgxpool"

pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
// default: max 10 conn
```

### river worker (富化 queue 替代)

```go
import "github.com/riverqueue/river"

type BangumiV1Args struct {
  AnilistID int `json:"anilist_id"`
}

func (BangumiV1Args) Kind() string { return "bangumi_v1" }

type BangumiV1Worker struct {
  river.WorkerDefaults[BangumiV1Args]
  bangumi *BangumiService
}

func (w *BangumiV1Worker) Work(ctx context.Context, job *river.Job[BangumiV1Args]) error {
  return w.bangumi.SearchByTitle(ctx, job.Args.AnilistID)
}
```

### testify + testcontainers integration test

```go
func TestGetAnimeByID(t *testing.T) {
  ctx := context.Background()
  pg, err := postgres.RunContainer(ctx, ...)
  require.NoError(t, err)
  defer pg.Terminate(ctx)

  conn := connect(pg.ConnectionString())
  defer conn.Close()
  runMigrations(t, conn)
  loadFixtures(t, conn, "anime_cache_154587.sql")

  q := db.New(conn)
  anime, err := q.GetAnimeByID(ctx, 154587)
  require.NoError(t, err)
  assert.Equal(t, "...", anime.TitleRomaji)
}
```

---

## Appendix D — Postgres Schema 概要

完整 SQL 在 `go-api/migrations/0001_init.sql`,这里只列结构。

**FK CASCADE 策略**(二轮 review 1C 决议:全 CASCADE):

```
users(id, username UQ, email UQ, password, role, is_public, refresh_token, ...)
  ├─ subscriptions(user_id FK ON DELETE CASCADE, anilist_id, status, current_episode, score, last_watched_at, ...) PK(user_id, anilist_id)
  ├─ follows(follower_id FK ON DELETE CASCADE, followee_id FK ON DELETE CASCADE, ...) PK(follower_id, followee_id)
  ├─ episode_comments(id, anilist_id, episode, user_id FK ON DELETE CASCADE, content, parent_id FK self ON DELETE CASCADE, ...)
  └─ danmakus(id, anilist_id, episode, user_id FK ON DELETE CASCADE, content, live_ends_at, created_at)
       └─ pg_cron: DELETE WHERE created_at < NOW() - INTERVAL '1 year'

anime_cache(anilist_id PK, title_chinese, title_native, title_romaji, title_english,
            search_vec tsvector GENERATED ALWAYS AS (
              to_tsvector('simple',
                coalesce(title_chinese,'') || ' ' ||
                coalesce(title_native,'')  || ' ' ||
                coalesce(title_romaji,'')  || ' ' ||
                coalesce(title_english,'')
              )
            ) STORED,                                  -- 二轮 review 3P generated column
            description, accent_color, season, season_year, ..., start_date DATE)
  ├─ anime_genres(anime_id FK ON DELETE CASCADE, genre) PK(anime_id, genre)
  ├─ anime_studios(anime_id FK ON DELETE CASCADE, studio) PK(anime_id, studio)
  ├─ anime_relations(id, anime_id FK ON DELETE CASCADE, related_anilist_id, relation_type, title, ...)
  ├─ anime_characters(id, anime_id FK ON DELETE CASCADE, display_order, name_en, name_ja, name_cn, ..., voice_actor_*)
  ├─ anime_staff(id, anime_id FK ON DELETE CASCADE, display_order, name_en, name_ja, image_url, role)
  ├─ anime_recommendations(id, anime_id FK ON DELETE CASCADE, rec_anilist_id, title, ...)
  └─ anime_episode_titles(anime_id FK ON DELETE CASCADE, episode, name_cn, name) PK(anime_id, episode)

episode_windows(anilist_id, episode, live_ends_at) PK(anilist_id, episode)

idx:
  anime_cache: GIN(search_vec)                          -- 二轮 review 3P:索引该 generated column 而非 4 列裸 GIN
              ◇ idx(season, season_year)
              ◇ idx(admin_flag)
              ◇ pg_trgm on title_chinese/native/romaji/english (二轮 review 6C: dandanplay AnimeCache regex 替代)
  subscriptions: idx(user_id, status) ◇ idx(anilist_id)
  follows: idx(followee_id)
  episode_comments: idx(anilist_id, episode) ◇ idx(parent_id) ◇ idx(user_id)
  danmakus: idx(anilist_id, episode, created_at)
  anime_*: idx(anime_id) on all child tables

extensions(必须先 CREATE EXTENSION):
  pg_trgm     -- 用于 dandanplay AnimeCache regex 替代
  pg_cron     -- 用于 danmaku TTL 任务
```

---

**Last updated:** 2026-05-12(初版,supersedes v1 plan from 2026-05-10)

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | skipped | 用户明确跳过(本次也跳过) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | **2 (deep re-run 2026-05-12 19:00)** | CLEAR (PLAN) | **2nd run: 19 issues raised, 17 resolved + 2 unresolved-accepted** |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 (stale) | covered | v1 plan §3.7 UI risk audit 平移 |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

### 1st Eng Review 06:45 (commit 89516a1) — 4 critical findings (all resolved earlier today):
- Issue 1 [CRITICAL]: Mongo 30-day retention vs Postgres new writes → **1C**: 24h 真实窗口 + mongodump 仅作灾难恢复
- Issue 2 [CRITICAL]: Big-bang 无 prod 信号 → **2A**: 新增 P8.5 shadow traffic 1 周
- Issue 3 [HIGH]: 测试工时低估 60-80 hr → **3A**: 显式拆 P2.7 testify+testcontainers phase
- Issue 4 [HIGH]: 全 normalize 详情页 N+5 join → **4A**: 接受,P5/P10 benchmark

### 2nd Eng Review 19:00 (commit 7f86e28, deep re-run) — 19 new findings, 17 resolved:

**Section 1 — Architecture (8 issues):**
- 1A [P1] → **B Next.js 14 → 16**(Active LTS,React 19 默认)
- 2A [P1] → B 保留 "37" label,接受 P2.4/P2.5 工时 overrun 风险(unresolved-accepted)
- 3A [P1] → **A NEW P2.8 ws-server split phase**(10-15hr)
- 4A [P1] → **A Go API dual-accept Authorization header + Cookie 7 天**
- 5A [P1] → **A Express image :rollback-T0 tag + registry 30 天**
- 6A [P2] → **A P1 加 field-level parity test 10×1000**
- 7A [P2] → note river vs lean alternative,保留 river(crash recovery for V2/V3)
- 8A [P2] → **A P3 baseline 加 prod Express metrics + socket 连接数**

**Section 2 — Code Quality (8 issues):**
- 1C [P1] → **A anime_* + user_id 全 ON DELETE CASCADE**
- 2C [P1] → **A P0 加 scripts/dev.sh 一键起 6 进程**
- 3C [P2] → note river migration 排在 schema migration 之后
- 4C [P2] → note P2.2 bcrypt fixture 用 mongo dump 真 prod hash
- 5C [P1] → **A 删 Dockerfile.node**(4 → 3 Dockerfile)
- 6C [P1] → **A P2.6 +12hr 写 3 个明确决策**(phase 2 修正/episodeMap/pg_trgm)
- 7C [P2] → note ws-server JWT verify mirror Go <30 行
- 8C [P2] → **C 接受 2-tier cache 主从模糊**(unresolved-accepted,TODO-2 跟到 P2.1)

**Section 3 — Tests (3 issues + diagram):**
- 1T [P1] → **A P8.5 day-6 cutover dress rehearsal**
- 2T [P1] → **A P8.5 day-7 rollback drill <5min**
- 5T [P1] → **A T+0 sequence: stop ws-server before Express**

**Section 4 — Performance (2 issues + 4 notes):**
- 2P [P1] → **A P2.8 弹幕 rate-limit Map → LRU 有界**(silent overflow bug 修)
- 3P [P2] → **A search_vec generated column STORED + GIN 索引**

**TODOs (4 → all answered):**
- TODO-1 → A P3 baseline 加 vnstat + VPS 带宽 plan
- TODO-2 → A 跟到 P2.1 实现时决定
- TODO-3 → A P10 Sentry alert wiring fake error 验证
- TODO-4 → A P10 视觉回归 pixel-diff 0.1% threshold + PR comment trigger

### Cross-Model Tension
No outside voice ran (user explicitly skipped Codex this session as previous).

### UNRESOLVED (accepted by user):
1. **2A 工时 overrun**:plan 总 "37 endpoint" label 不改,实际 48,P2.4/P2.5 实施时若 overrun ~20hr,用户接受
2. **8C 2-tier cache 主从**:推迟到 P2.1 commit 前再决定,plan 写下 TODO

### NEW phases / decisions added
- **P2.8** ws-server split (NEW, 10-15hr)
- **Schema CASCADE 全开**(Appendix D 已改)
- **search_vec generated column**(Appendix D 已改)
- **Day-6 dress rehearsal + Day-7 rollback drill**(P8.5 acceptance)
- **dual-accept header+cookie 7 day**(§ Decision log + P2.2)
- **:rollback-T0 tag retain 30 day**(P8 CI/CD)
- **P5 dual-mode 详情页 query**(P5 + P10)
- **Field-level parity test**(P1)
- **scripts/dev.sh**(P0)
- **R12-R18 新增**(§ 3)
- **Innovation tokens still 7**(版本修正不算新 token)

**VERDICT:** ENG CLEARED (PLAN, 2nd deep run) — ready to implement.
Critical findings all incorporated into plan as new phases (P2.7, P2.8, P8.5),
decision log entries, schema, and acceptance criteria. 2 unresolved are
explicitly user-accepted with mitigation paths.
