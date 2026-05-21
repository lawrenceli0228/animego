---
title: AnimeGo — P2-PROGRESS
toc: true
toc-depth: 3
lang: zh-CN
document-css: false
---

# Phase 2 Progress — Go API Rewrite

**Branch:** `feat/go-backend`
**Started:** 2026-05-21
**Estimated total:** 100-160 hr,6 个 sub-milestone(P2.1 - P2.6) + P2.0 骨架
**Plan reference:** [`MIGRATION_PLAN.md`](MIGRATION_PLAN.md) § Phase 2

> P2.0 (chi 骨架) 不在原 plan 单列,P1 → P2 gate 之后追加的,设计经
> `/plan-eng-review` 跑过(8 个决策记录在 [`P2.0-DESIGN.md`](P2.0-DESIGN.md) § 9)。

---

## P2.0 — chi 骨架(7-10 hr)✓

实际耗时 ~6 hr(2026-05-21 同一天打完,A+C+D 多 subagent 协作 + 我手动 review/wire)。

### 完成的 5 commit

| Commit | Subject | 文件 / 行数 |
|---|---|---|
| `0b62ae5` | docs(migration): P2.0 design v2 — eng-review decisions baked in | 2 文件 / +1561 |
| `f12ab85` | feat(go-api): P2.0.A — pgxpool + /health Ping | 3 文件 / +240 |
| `03683cf` | feat(go-api): P2.0.C — httpx envelope + APIError + 6 byte fixture | 7 文件 / +950 |
| `8b666aa` | feat(go-api): P2.0.D — httpmw (logger /health skip / cors / recoverer) | 9 文件 / +632 |
| `f431f65` | test(go-api): P2.0 health smoke integration — 4/4 PASS, byte-exact envelope | 1 文件 / +194 |

合 22 文件,**+3577 行**(代码 + 测试 + docs)。

### 5 sub-task 结果

- [x] **A** — `internal/db/pool.go`(76 行)+ `pool_test.go`(97 行,**7 case PASS**)。web-tier pgxpool:MaxConns=20 / HealthCheckPeriod=30s / MaxConnLifetime=1h / MaxConnIdleTime=30min / ConnectTimeout=10s / PingTimeout=2s。`cmd/server/main.go` 接 pool + 改 `/health` 走 envelope。
- [x] **C** — `internal/httpx/` 4 .go 文件(codes / error / envelope + 共 ~280 行)+ 3 测试文件(error_test 16+ case / envelope_test 15 case / express_fixture_test **6 byte-exact case**)。**coverage 97.9%**。
- [x] **D** — `internal/httpmw/` 3 .go 文件(logger 100 行 / cors 30 行 / recoverer 70 行)+ 3 测试文件(共 14+ case)。**coverage 97.4%**。包名 `httpmw` 而非 `middleware` 避开跟 `github.com/go-chi/chi/v5/middleware` 包名冲突。
- [x] **smoke** — `test/integration/health_smoke_test.go`(194 行,`//go:build integration`,4 case 跨 DB up/down + CORS preflight + Recoverer panic)。复用 P1.D TestMain 的共享 PG container。`go test -race -tags=integration` **11/11 PASS,8.6s wall**(7 P1.D + 4 P2.0)。
- [x] **F** — 本文档 + `go-api/README.md` 加 P2.0 速查 + [`MIGRATION_PLAN.md`](MIGRATION_PLAN.md) § 7 状态表加 P2.0 行。

### 退出条件(P2.0 → P2.1 gate)— 全部 ✓

- [x] `go build ./...` + `go vet ./...` + `go test -race ./...` 全绿
- [x] `go test -race -tags=integration -timeout=300s ./test/integration/...` **11/11 PASS,8.6s**(7 P1.D + 4 P2.0 smoke)
- [x] **Live `curl http://localhost:8080/health`** 返 `{"data":{"ok":true,"service":"go-api","stage":"P2.0","db":"up"}}` HTTP 200,64 字节,`Content-Type: application/json; charset=utf-8`,**byte-exact 验证通过**(hex dump 确认无 BOM、无尾换行)
- [x] **Live OPTIONS preflight** 验 CORS:`Origin: http://localhost:3000` → 200 + `Access-Control-Allow-Origin` + `Access-Control-Allow-Credentials: true` + `Access-Control-Max-Age: 300`
- [x] **Live /health log 静默** 验 RequestLog skip:404 路径有 WARN log,/health 路径无 log(2880 条/天/pod noise 已消除)
- [x] `internal/httpx/` 单测覆盖率 97.9%(目标 ≥90%)
- [x] `internal/httpmw/` 单测覆盖率 97.4%
- [x] PR 合到 `feat/go-backend` 分支(单 PR 5 commit)

### 关键设计取舍(已锁,P2.x 不允许偏)

1. **envelope 字节级 Express 兼容** — `httpx.Data` / `Page[T]` / `Fail` 通过 `json.Encoder` + `SetEscapeHTML(false)` + 剥尾换行,跟 Express `JSON.stringify` 输出字节一致。
2. **`Pagination.NextPage` 是 `*int` 不带 omitempty** — nil → JSON `null`,跟 `follow.controller.js:59` `nextPage: hasMore ? page+1 : null` 字节匹配。
3. **`Page[T any]` 是泛型** — 编译期保证 items 是 slice,非 `any`(YAGNI/explicit 偏好)。
4. **`Fail` 三态 fallback** — APIError → 走自带 status/code;非 APIError → 500 + SERVER_ERROR(cause 进 slog);nil → 500 SERVER_ERROR(防御性)。
5. **`NewError(..., WithCause(err) Option)`** — 函数式 options 模式,跟 Go patterns rule 对齐。
6. **`internal/httpmw/` 而不是 `internal/middleware/`** — 避开 chi.middleware 包名冲突,所有文件无需 alias import。
7. **中间件链顺序锁定:**`CORS → RequestID → RealIP → RequestLog → Recoverer → Timeout`。
8. **`/health` 在 RequestLog 内 skip** — verbatim 字符串匹配(`req.URL.Path == "/health"`),省 2880 条/天/pod docker probe 日志。

### 实际 commit timeline

```
13:01  docker compose up postgres  (dev env restart from session pause)
13:01  go test -tags=integration   11/11 PASS in 8.6s
13:05  live server + curl smoke    /health 200 + envelope byte-exact
~6 hr total wall (across multiple Claude Code sessions)
```

---

## P2.1 — `/api/anime/*` + 富化 queue(进行中,35-55 hr 估时)

[`MIGRATION_PLAN.md`](MIGRATION_PLAN.md) § Phase 2 详细规划。

### P2.1.0 — pre-work ✓(2026-05-21,3 commit)

- [x] river migration `0007_river_initial` + `0008_river_pending_use`(P2 design § 10 ENUM split)
- [x] `make sqlc-generate` 第一次跑通,`/completed-gems` endpoint 用 dbgen.Querier 接入
- [x] `internal/testutil/` 提取,P1.D `migrate_test.go` 同期 refactor 复用(Rule of three)

### P2.1.1 — leaf packages 第一批 ✓(2026-05-21,1 commit:`20a341e`)

3 个 subagent 并行(用户:"继续可以用多subagents协助"),全独立无相互依赖:

| Package | 行 | Coverage | 关键决策 |
|---|---|---|---|
| `internal/anilist/` | client + types + queries 4 文件 | **91.5%** | rate.NewLimiter(rate.Every(700ms), 1) 单 token / 429 retry 3 次读 Retry-After / *ErrUpstream 包 5xx + GraphQL errors[0] / 内部 wire struct + json.RawMessage 绕开锁定的 types.go `Variables map[string]any` |
| `internal/cache/` | 2 文件 | **100.0%** | ristretto/v2 泛型 `Cache[V any]` Wait() 必调 / Defaults: NumCounters=1e7 MaxCost=1e8 BufferItems=64 |
| `internal/colorx/` | 2 文件 stdlib only | **96.8%** | OKLab/OKLCH port `server/utils/normalizeAccent.js` / 5 fixture 通过 `node -e ...` 实跑 JS 锁定字节 parity / brand fallback `#8B5CF6` |

合 8 文件 / +2486 行。

### P2.1.2 — leaf packages 第二批 ✓(2026-05-21,1 commit:`4903b64`)

3 个 subagent 并行,基础设施层:

| Package | 行 | Coverage | 关键决策 |
|---|---|---|---|
| `internal/torrents/` | 9 文件(types + 3 源 + aggregator + 4 test) | **91.9%** | errgroup.WithContext 并发 / 8s per-source timeout(`http.RoundTripper` rewrite injection)/ partial-tolerance 失败源返空 slice / ristretto 1h TTL 500 entry / `parseIntJSLike` 匹配 JS `parseInt("1234abc") → 1234` 字节 parity / Go encoding/xml namespace 用 URI 不是 `nyaa:` alias |
| `internal/queue/` | 3 文件 + 1 integration | **100.0%** unit | river `Boot(pool, Config) (*river.Client[pgx.Tx], error)` ErrMissingPool / 3 stub workers BangumiV1/2/3 待 P2.1.3 填实 / Subscribe channel 必须 Boot 前订阅否则 events drop / 不调 `river-migrate` —— 0007+0008 已 schema-applied |
| `internal/bangumi/` | 2 文件 | **98.1%** | rate.NewLimiter 800ms burst=1 / User-Agent `AnimGo/1.0` typo 保留 byte-exact(Bangumi rate-limit allowlist 可能 hash UA)/ 4 endpoint:Search + Subject + Characters + Episodes(用 OLD v1 `/subject/{id}/ep` 不是 v0)/ ErrNotFound 区分 404 vs *ErrUpstream / Episode.Sort `float64`(Bangumi 给 1.5 表示 SP) |

合 17 文件 / +4173 行。

### P2.1.3 — 待开:handler + service + 富化 worker

启动前必须做的事(来自 P2.0 → P2.1 handoff,见 [`P2.0-DESIGN.md`](P2.0-DESIGN.md) § 10):

- [ ] **每个 handler 第一行加 query-level timeout** — `ctx, cancel := context.WithTimeout(req.Context(), 5*time.Second); defer cancel()`,堵 P2.0 design § 5 风险表里 pgxpool 连接耗尽 / 用户挂 60s 问题
- [ ] **endpoint shape diff harness** — Phase 8.5 shadow traffic 前需要 diff 工具。P2.1 写第一个 endpoint 时**同步**写 `test/shadow/diff_anime_detail_test.go`,跟 Express 真 prod 响应做 byte 比对。P2.0 byte fixture 是 envelope 层,这是 endpoint 层。

### 8 endpoint 待 wire(已有 `/completed-gems`)

- GET `/seasonal` — anilist client + cache + db re-read(titleChinese 拼入)
- GET `/search` — anilist client + 10min cache
- GET `/schedule` — anilist client + 30min cache + groups by 'YYYY-MM-DD'
- GET `/torrents` — `internal/torrents/aggregator.go` 现成
- GET `/trending` — subscriptions aggregate join anime_cache + 1h cache
- GET `/yearly-top` — anime_cache filter by seasonYear/format/score + 1h cache
- GET `/:anilistId/watchers` — subscriptions populate user.username
- GET `/:anilistId` — anime_cache cache-first(stale 检测复杂)+ trigger v0 enrichment

外加:替换 `internal/queue/` stub workers 为真 Bangumi 富化(用 `internal/bangumi/` client)+ warmCurrentSeason / warmSeasonCache(river periodic)。

---

## P2.2 - P2.6 待开

| Sub-milestone | 范围 | endpoint 数 | 估时 |
|---|---|---|---|
| P2.2 | `/api/auth/*` + JWT + bcrypt + Gmail SMTP + dual-accept 7-day cutover | 7 | 18-28 hr |
| P2.3 | `/api/admin/*` + adminAuth + warm-all + 级联删除 | 14 | 15-22 hr |
| P2.4 | `/api/subscriptions/*` + `/api/users/*` + `/api/feed` | 11 | 12-18 hr |
| P2.5 | `/api/comments/*` + `/api/danmaku/*` HTTP(读) | 4 | 8-12 hr |
| P2.6 | `/api/dandanplay/*` + 3-phase match + 6 regex + 限流共享 | 4 | 24-37 hr |

每个独立 PR,部署 staging 跟 Express 跑 shape diff。完成后进 Phase 3 (Next.js + Bun)。

---

## Notes / Decisions(随时追加)

- 2026-05-21 12:30 — P2.0 设计文档 v1 出(22 文件 / 6 子任务 / 10-15 hr)。`/plan-eng-review` 跑 8 个 AskUserQuestion,削掉 B+E 到 P2.1,锁 CORS 顺序 / nextPage null / Page 泛型 / Data 无 error 返回 / NewError WithCause / /health skip log / inline smoke / 6 byte fixture。
- 2026-05-21 13:00 — P2.0.A/C/D/smoke/F 全过。整 phase 单一 PR,5 commit。
- 2026-05-21 P2.1.0 - dbbd780/601d6ad/e287472 pre-work(river migration + sqlc + testutil)
- 2026-05-21 P2.1.1 - 20a341e:anilist + cache + colorx 3 包 subagent 并行,unit + race + cover ≥91% 全过
- 2026-05-21 P2.1.2 - 4903b64:torrents + queue + bangumi 3 包 subagent 并行,unit + race + cover ≥91% 全过;integration 15/15(7 P1.D + 4 P2.0 + 4 P2.1 queue smoke)12.1s wall
- **教训:byte-level envelope 测试在 Phase 2 早期是 boil-the-lake 例子**。Unit logic test 验"NotFound 码=NOT_FOUND"是不够的,真要捕捉 shadow traffic 阶段会 fail 的差异(key 顺序 / null vs 缺失字段 / HTML escape),必须从 Express 真实输出回写字节做 `bytes.Equal`。`httpx/express_fixture_test.go` 6 case 是模板,P2.x 每加 endpoint 写一组同模板的 byte fixture。
- **教训:Go internal 包名跟 third-party 撞**:`internal/middleware/` 跟 `github.com/go-chi/chi/v5/middleware` 冲突,任何同时用本地中间件 + chi 自带 RequestID 的文件都要 alias 一个。改 `internal/httpmw/`(或 `httpx/` 也行)完全没这问题。Go 惯例:`internal/<short-prefix>` 优先,不重 stdlib / popular-third-party 包名。
- **教训:docker healthcheck 日志洪水**:Docker `start_period: 30s` 每 30s 探一次 /health,prod 一个 pod 一天 2880 条 log。RequestLog 必须 verbatim skip `/health` 路径(`if req.URL.Path == "/health" { next.ServeHTTP(w, req); return }`)。如果只走 Debug level skip 会丢 5xx healthcheck 报警 —— P2.0.D 选了 verbatim skip + 业务 endpoint 全级别 log。
