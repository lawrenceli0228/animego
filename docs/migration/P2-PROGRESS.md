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

### P2.1.3 — 5 endpoint wire(2026-05-21,2 commit)

**P2.1.3a** — sqlc 扩展(`623f23f` + 補 `66f809f` querier.go):6 个新 query 方法

| Query | Endpoint | 用法 |
|---|---|---|
| `GetYearlyTop` | /yearly-top | year + limit 20 然后 Go slice |
| `GetSeasonalAnime` | /seasonal | season+year+limit+offset 分页 |
| `CountSeasonal` | /seasonal | pagination meta total |
| `GetTrendingWithCounts` | /trending | 单 JOIN 替 Express 两步 aggregate+find |
| `GetWatchers` | /:anilistId/watchers | usernames 数组 |
| `CountWatchers` | /:anilistId/watchers | total meta |

**P2.1.3b** — handlers + 路由(`66f809f`,subagent 单人):5 endpoint

| Endpoint | Envelope shape | 关键决策 |
|---|---|---|
| GET /seasonal | `{data, pagination:{page,perPage,total,totalPages}}` | **不**走 `httpx.Pagination`(那是 hasMore/nextPage 形状)/ `writeMultiKeyEnvelope` helper / errgroup 并发 List+Count / WINTER 等 4 季验证 / perPage 上限 200 |
| GET /yearly-top | `{data:[]}` flat | 总是 query 20 行然后 Go slice 到 limit(byte-parity Express) |
| GET /trending | `{data:[{rank, watcherCount, ...16 anime fields}]}` | longhand `trendingItem` struct 不是 embed(Express rank/watcherCount **在** anime fields **前**)/ 1h cache 延 P2.1.4 |
| GET /:anilistId/watchers | `{data:[{username}], total}` | chi.URLParam + Atoi 校验,bad id → 400 `无效的番剧 ID` byte-exact 中文 / errgroup 并发 List+Count |
| GET /torrents | `{data:[...]}` flat | wraps `internal/torrents.Aggregator`(boot 时 `torrents.New()`)/ q required ≤200 char,验失败 "Missing query" / "Query too long" |

main.go:`torrentsAgg` boot 时构造一次复用 / 5 个新路由注册 / `stage` 由 P2.0 → P2.1 / startup log P2.0.D → P2.1.3。

**handlers.go**:84 → ~530 行,共享 `queryTimeout = 5*time.Second` const + `parseLimit` helper(P2.0 → P2.1 carry-over § 10 第 3 条 query-level timeout 已落)

**handlers_test.go**:184 → ~870 行,34 unit test,hand-rolled `fakeQuerier` 7 function-pointer fields。**Coverage 92.9%**(target ≥80%)。

**Live smoke**(`go run ./cmd/server` + docker compose postgres + curl):
- `/health` 200:`{"data":{"ok":true,"service":"go-api","stage":"P2.1","db":"up"}}`
- `/completed-gems`:limit=2 → 2 anime,真 anilistId=9890
- `/seasonal?season=WINTER&year=2025&perPage=3` → 3 anime + `pagination:{page:1,perPage:3,total:95,totalPages:32}` ✓
- `/yearly-top?year=2025&limit=3` → 3 anime flat array ✓
- `/trending?limit=1` → field 顺序 `[rank, watcherCount, anilistId, titleRomaji, ...]` ✓
- `/42/watchers` → `{"data":[],"total":0}`(无订阅时 empty slice ≠ null)✓
- 验证错误:`/torrents`(no q) → 400 `Missing query` / `/abc/watchers` → 400 `无效的番剧 ID` / `/seasonal?season=invalid` → 400 `invalid season`

Integration 回归:15/15 PASS,13.4s wall(P1.D 7 + P2.0 4 + P2.1 queue 4)

### P2.1.4 — /search + /schedule + 配套基础 ✓(2026-05-21,3 commit)

**P2.1.4a**(`fb07a7c`):3 个新 sqlc method
- `UpsertAnimeCache(17 params struct)` — main row only,ON CONFLICT 保 title_chinese + bgm_* + bangumi_version(enrichment workers 拥有那些列,AniList re-fetch 不能 clobber)
- `GetAnimeByAnilistIDs([]int32)` — /search post-upsert 16-field 重读
- `GetTitleChineseByAnilistIDs([]int32)` — /schedule 3-field 轻量富化查询(anilist_id + title_chinese + bangumi_version)

**P2.1.4b**(`a2f8027`):normalize.go — port Express `normalize()` AniList Media → UpsertAnimeCacheParams
- `NormalizeMainRow(m)` 折叠 `accentFields()` 进 colorx 已实现的 brand fallback
- `coverImage.extraLarge || coverImage.large` 用 JS `||` falsy-skip 语义(空 string 也跳)
- `*int → *int32`(episodes/seasonYear) / `*int → *float64`(averageScore numeric(4,2))
- `title_chinese / bgm_id / bangumi_*` **不**设(enrichment 拥有,upsert 保留 ON CONFLICT)
- `Genres(m)` 也导出(never nil → []string)给 P2.1.5 child-table upsert

**P2.1.4c**(本批最后一个 commit):2 个 endpoint subagent 并行

| Endpoint | Service | Cache | TTL | 文件 | 测试 |
|---|---|---|---|---|---|
| /search | `SearchService` composes anilist + cache + db | `Cache[SearchPage]` | 10min | search.go ~280 行 | 20 case |
| /schedule | `ScheduleService` composes anilist + cache + db | `Cache[ScheduleResponse]` | 30min | schedule.go ~320 行 | 14 case (含 tz 跨日 UTC vs Tokyo 测试) |

**关键决策**:
- `AniListSearcher` / `AniListScheduler` 各定义自己的小 interface(use-site interfaces),concrete `*anilist.Client` 满足两个 → test stub 干净
- /search 错误映射:`*anilist.ErrUpstream` → 502,`anilist.ErrRateLimited` → 502,`context.DeadlineExceeded` → 504(Express 500 — 我们更精确)
- /schedule **不**用 5s queryTimeout 用 20s(分页循环 + AniList HTTP 10s timeout 超 5s)
- /schedule DB 查 titleChinese 失败 → 200 + nil TitleChinese 优雅退化(schedule 无中文 strictly 比 500 好)
- /schedule pagination loop **10 page sanity cap** 防 runaway / AniList weekly 通常 1-2 page
- /search 验证 q AND genre 都空 → 400 byte-exact `请提供搜索关键词或类型`
- /schedule cache key 是 local-tz today YYYY-MM-DD(tz 注入用 `tzOverride` + `nowFn` 给测试确定性)

**Coverage**:`./internal/anime/...` 92.2%(70+ tests across handlers + normalize + search + schedule + 各种 helper)

**main.go wire**(P2.1.4c):新建 `anilist.NewClient()` 单 instance 复用(700ms throttle 全局共享)→ `NewSearchService` + `NewScheduleService` → 注册 `/search` 和 `/schedule` 路由 → stage `P2.1.3 → P2.1.4`

**Live smoke**(docker compose pg + AniList prod + curl):
- `/search?q=naruto&perPage=2` → 真 anilistId=20 NARUTO + pagination `total:5000,totalPages:2500` ✓
- `/search` 无参 → 400 `请提供搜索关键词或类型` byte-exact ✓
- `/search` cache hit → <0.02s(命中本地 ristretto)✓
- `/schedule` → 7 天 groups(2026-05-21 至 5-27),5/21 当天 15 items,16 fields 顺序对 ✓
- `/schedule` cache hit → <0.02s ✓

### 9 endpoint 状态

| Endpoint | 状态 | 备注 |
|---|---|---|
| /completed-gems | ✓ P2.1.0 | — |
| /seasonal | ✓ P2.1.3 | warmed-cache only;冷启 AniList → P2.1.5 |
| /yearly-top | ✓ P2.1.3 | 1h cache 待加 P2.1.5 |
| /trending | ✓ P2.1.3 | 1h cache 待加 |
| /:anilistId/watchers | ✓ P2.1.3 | — |
| /torrents | ✓ P2.1.3 | — |
| /search | ✓ P2.1.4 | 10min cache + 真 AniList + DB upsert + re-read |
| /schedule | ✓ P2.1.4 | 30min cache + paginated AniList + tz-local 分组 |
| /:anilistId | ✗ 待 P2.1.5 | 需 7 个 child table join + stale 检测 + AniList re-fetch |

### P2.1.5 — V1 worker + /:anilistId detail ✓(2026-05-21,3 commit)

**P2.1.5a**(`ef6b737`):10 个新 sqlc method
- V1 worker:`GetAnimeForBangumiSearch` + `UpdateBangumiV1`
- /:anilistId:7 个 GetAnime*ByID(Main + 6 child)+ `GetRelationEnrichmentByIDs`(relations enrichment)

**P2.1.5b**(`994519b`):真 V1 worker 替 stub
- `internal/queue/bangumi_v1.go`:port `fetchBangumiData` 8 步流程,`BangumiSearcher/V1Reader/V1Writer/V1DB` use-site interfaces,exact match 全列表扫描(不只 list[0])然后 `titleChinese = exactMatch && NameCN != "" && NameCN != Name` 决策,**Coverage 100%**
- 错误分类:`ErrNoRows/ErrNotFound/empty list/empty keyword` → return nil(permanent skip);network/5xx/DB → wrapped error river 重试 3 次默认
- `worker.go` edit:删 stubBangumiV1Worker;`Workers()` 只剩 V2/V3 stub;新 `WorkersWithBangumi(client, db)` production 用
- integration smoke 用 noHitBangumi + noRowV1DB stub doubles 保 V1 enqueue test path 走 production wiring(用户原话:验充分)
- main.go 接入:`bangumi.NewClient()` singleton + `queue.Boot` + `riverClient.Start(queueCtx)` 前于 HTTP server + `defer riverClient.Stop(10s)`

**P2.1.5c**(`4aa005c`):/:anilistId detail cache-first 7-query
- `internal/anime/detail.go` 518 行:`AnimeDetail` 32 字段 Express byte-exact JSON 顺序,4 nested types(Relation/Character/Staff/Recommendation),`pgtype.Date` + `pgtype.Timestamptz` 直接 marshal(避 *string 转换噪声)
- `DetailDB` 8-method interface,`DetailService` composes db + cache.Cache[*AnimeDetail](1h TTL)
- Handler 验证 anilistId(chi.URLParam + Atoi,reject 负/0/非数 → 400 `无效的番剧 ID`)
- fetchDetail:cache hit → 立返 / pgx.ErrNoRows on main → 404 `番剧不存在` / errgroup 并发 6 child + 1 enrichment / relations enrichment 合并 titleChinese + coverImageUrl(`r.coverImageUrl || c?.coverImageUrl` 语义)/ 空 children 序列化 `[]` 不 null
- 18 test cases,**全包 anime coverage 92.6%**
- TODO P2.1.6 marker:stale detection + AniList Detail re-fetch + child-table upsert + V1 enqueue

**Live smoke**(docker compose pg + curl):
- `/api/anime/20`(Naruto P2.1.4 upserted)→ 200,1462 bytes,32 keys 顺序对,6 个 child array 全 `[]` ✓
- `/api/anime/999999` → 404 `番剧不存在` byte-exact ✓
- `/api/anime/abc` → 400 `无效的番剧 ID` byte-exact ✓
- 61ms wall for /:anilistId/20 hot path
- river queue 健康(无 V1 job 入队 —— 触发源 P2.1.6)

### 9 endpoint 状态 — **全 done** (cache-only for /:anilistId)

| Endpoint | 状态 | 备注 |
|---|---|---|
| /completed-gems | ✓ P2.1.0 | — |
| /seasonal | ✓ P2.1.3 | warmed-cache;冷启 AniList → P2.1.6 |
| /yearly-top | ✓ P2.1.3 | 1h cache 待加 |
| /trending | ✓ P2.1.3 | 1h cache 待加 |
| /:anilistId/watchers | ✓ P2.1.3 | — |
| /torrents | ✓ P2.1.3 | — |
| /search | ✓ P2.1.4 | enqueue V1 → P2.1.6 |
| /schedule | ✓ P2.1.4 | enqueue V1 → P2.1.6 |
| /:anilistId | ✓ P2.1.5 | cache-only;stale + AniList re-fetch + child upsert → P2.1.6 |

### P2.1.6 — V1 trigger source + /:anilistId stale re-fetch ✓(2026-05-21,3 commit)

**P2.1.6 SQL**(`74c6043`):13 个新 sqlc method
- `ListUnenrichedAnilistIDs(limit, offset)` 给 boot orphan scan
- 12 个 child-table 操作(6 Delete + 6 Insert):genres / studios / relations / characters / staff / recommendations
- DELETE + INSERT 模式而非 UPSERT(child tables UUID PK 无 natural conflict key);service layer 非事务包(partial-update 容忍,下次请求再 re-fetch 一遍)

**P2.1.6a**(实质上同一个 commit hash `74c6043` 包含 SQL,加 `bbca9d3` 之前的 V1 trigger commit):V1 enqueue 触发源
- `internal/queue/enqueue.go`:`Enqueuer` 接口 + `RealEnqueuer`(river `InsertMany` 批量)+ `NoopEnqueuer` 给 nil-safe 默认
- `internal/queue/orphan.go`:`ScanAndEnqueueOrphans` 100-batch 分页扫 bangumi_version=0
- `search.go` + `schedule.go`:第三个参数 `enq queue.Enqueuer`,upsert/lookup 后过滤 bangumi_version=0 调 EnqueueV1Many(非致命错误)
- `main.go`:`queue.NewEnqueuer(riverClient)` + boot goroutine `ScanAndEnqueueOrphans(60s subctx)`

**P2.1.6b**(`bbca9d3`):/:anilistId stale + AniList Detail re-fetch + child upserts
- `normalize.go` +5 函数:`StudiosFromMedia` / `RelationsFromMedia` / `CharactersFromMedia` / `StaffFromMedia` / `RecommendationsFromMedia` + 4 个 Row types
- 关键 byte parity:relations + recommendations 用 `.large` **不**用 `.extraLarge`(Express 特殊决定保留)/ characters first VoiceActor only / recommendations 过滤 mediaRecommendation 为 nil 的节点 / DisplayOrder = slice index
- `detail.go` 重构:`DetailDB` 拆 `DetailReader` + `DetailWriter` composite / 新 `AniListDetailer` 接口 / `NewDetailService(db, anilistClient)` 签名变 / `isStale` helper(cached_at >= 1h OR studios 空 OR characters 空 OR characters[0].Role nil OR relations[0].CoverImageUrl nil)
- fetchDetail 新流:cache hit → 返 / cache miss → main read → ErrNoRows+anilist → re-fetch(支持新番,我们 DB 还没有) / ErrNoRows+nil anilist → 404 / 老数据 stale → re-fetch / re-fetch 失败 → fallback 返 stale(strictly better than 500)
- `refetchFromAniList`:15s subcontext(AniList HTTP timeout + 700ms throttle 超 5s queryTimeout)+ `upsertFromMedia` 主表 + 6 child Delete+Insert 链
- AniList `ErrUpstream{Status:404}` 专门 map 到 404 `番剧不存在`(语义更准 —— AniList 说没有这媒体)
- **Coverage anime 92.2%**(detail.go + normalize.go 合 95.2%)

**main.go wire**:
- `bangumi.NewClient()` + `queue.Boot` + `riverClient.Start` 都之前已有(P2.1.5)
- 新:`enqueuer := queue.NewEnqueuer(riverClient)` 单 instance 共享 search/schedule/orphan
- 新:goroutine 启 60s subctx `queue.ScanAndEnqueueOrphans` 不阻 server
- 新:`NewDetailService(q, anilistClient)` 启 stale re-fetch path
- stage P2.1.5 → P2.1.6

**Live smoke**(docker compose pg + curl):
- Boot:`river queue ready workers=v1(real)+v2(stub)+v3(stub)` + 立即 `orphan scan enqueued V1 jobs count=1`(bangumi_version=0 行 1 个)
- V1 worker dispatched 自动跑:keyword="NARUTO -ナルト-" → Bangumi `no_hit` → return nil 干净完成 ✓
- `/api/anime/20`(Naruto)第一次 read → isStale 触发(characters 是空)→ AniList Detail re-fetch → upsertFromMedia 写 12 relations + 8 chars + 10 staff + 6 recos + 6 genres + 1 studio → response 1462→**12063 bytes** ✓
- cache hit 18ms ✓
- `/api/anime/99999999` → AniList 404 → mapped 到 our 404 `番剧不存在` byte-exact ✓
- `/api/anime/0` `/api/anime/abc` → 400 `无效的番剧 ID` byte-exact ✓

### 9 endpoint 状态 — **9/9 full parity**

| Endpoint | 状态 | 备注 |
|---|---|---|
| 8 endpoints | ✓ P2.1.0-P2.1.4 | — |
| /:anilistId | ✓ P2.1.5 + P2.1.6 | cache → DB → AniList re-fetch on stale → upsert 6 child tables |

### P2.1.7 — 待开

- V2 worker(Bangumi Subject + Characters + Episodes → anime_characters voice_actor_cn / anime_staff / character roles 等中文 enrichment)
- V3 worker(heal-CN 第二轮,跑过 v1 又跑 v3 捡漏)
- /seasonal 冷启 AniList path(cache miss 时 AniList Seasonal,目前空季节返 0 行)
- /trending / /yearly-top / /completed-gems 1h ristretto cache 接入(目前每请求都跑 DB)
- warmCurrentSeason / warmSeasonCache(river periodic 24h cron 启动时 + 隔天 re-warm 当前 + 下一季)
- 9 endpoint byte fixture(从 Express 真 prod 响应回写,Phase 8.5 shadow diff 前置)

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
- 2026-05-21 P2.1.3a - 623f23f / querier.go 補 66f809f:6 个 sqlc query 方法(seasonal/yearly-top/trending/watchers + 2 个 count)
- 2026-05-21 P2.1.3b - 66f809f:5 endpoint handlers + 路由 + 34 unit test cover 92.9% / live smoke 全过(/health → /seasonal pagination → /watchers 空 + 中文 400 → /torrents q 验证 全 byte-correct)
- 2026-05-21 P2.1.4a/b/c - fb07a7c + a2f8027 + (handlers commit):3 sqlc method(Upsert + 2 bulk read)+ normalize.go(AniList→cache row,colorx 折叠 brand fallback)+ /search subagent 20 case 92.2% + /schedule subagent 14 case(含 UTC vs Tokyo tz 跨日)+ main.go wire,live smoke /search 真 anilistId=20 NARUTO / /schedule 真 7-day groups / cache hit <0.02s
- **教训:Express envelope shape 不能套 httpx.Pagination**(再次):/search 用 `{data, pagination: {page, perPage, total, totalPages}}` 跟 /seasonal 同形 但跟 /follow 的 `httpx.Pagination`(hasMore/nextPage)**不**同形。第二个 endpoint 重蹈 P2.1.3b 同坑 → 私有 `writeSearchEnvelope` 复刻 `writeMultiKeyEnvelope` 模式。建议下次抽公共 helper `writeAnimePagination` 到 `internal/anime/` 内部,或在 P2.1.5 detail 之前抽掉这个 duplication。
- **教训:/schedule 不能用 5s queryTimeout**:AniList weekly 分页 + HTTP 10s timeout 实际能跑 8-15s(2 页 × 700ms throttle + 10s per page 防呆)。每个 endpoint 都套同 const 5s 会触发 504 false-positive。**建议**:P2.1.5 抽 per-endpoint timeout config(seasonal 10s / schedule 20s / detail 15s),不要 const 一刀切。
- 2026-05-21 P2.1.5a/b/c - ef6b737 + 994519b + 4aa005c:10 sqlc method(V1 update + 7 detail + relations enrichment)+ 真 V1 worker(`internal/queue/bangumi_v1.go` 100% cov / fetchBangumiData 8 步 / WorkersWithBangumi 取代 stub registration)+ /:anilistId detail(518 行,18 test,Express byte-exact 32 字段顺序,pgtype.Date 直接 marshal)+ main.go river boot(`riverClient.Start(queueCtx)` 前于 HTTP / defer Stop 10s)。**9/9 endpoint 全 landed**(/:anilistId 还是 cache-only,AniList re-fetch + child upsert + V1 enqueue 触发源都待 P2.1.6)。
- **教训:integration smoke 跟 stub registration 强耦合**:V1 stub 删 → integration test `c.Insert(BangumiV1Args{})` 找不到 worker 直接 fail。subagent 选 "用 WorkersWithBangumi 配 stub bangumi+stub db doubles" 而非 "切到 V2Args" 是对的 —— 跟 production wiring 路径走 / 不偏离测试意图。**教训普适化**:删任何 Workers() 里的 worker 之前 grep `BangumiV*Args` 看 integration test 有没有插同 kind 的 job。
- 2026-05-21 P2.1.6 - 74c6043 + bbca9d3:13 sqlc method(V1 trigger + child upserts)+ V1 enqueue 触发源(internal/queue/enqueue.go + orphan.go,search/schedule 加 Enqueuer 参数,main.go boot goroutine 60s subctx 跑 orphan scan)+ /:anilistId stale 检测 + AniList Detail re-fetch(15s subctx)+ 6 child-table upsert chain。9/9 endpoint full parity。Live smoke:orphan 1 V1 job dispatched + V1 no_hit clean / /:anilistId/20 stale fired re-fetch 写 12 relations + 8 chars + 10 staff + 6 recos / response 1462 → 12063 bytes byte-exact 32 字段 ✓
- **教训:subagent prompt 写 "DO NOT touch main.go" 不够 —— 改了 constructor 签名 build 就会断**。Subagent A 必须改 main.go 加 nil 参数才能 `go build ./...` 过,即使我说过 "我来 wire"。**教训普适化**:任何改 exported 函数/构造器签名的 subagent prompt 都得显式说 "main.go 必须同步更新 nil 占位 + TODO 注释 + 测试 build green",或者让 subagent 不变签名(用 functional options 等)。这次接受 subagent 选择是对的(否则 build 就断)。
- **教训:isStale 用 1h 不是 24h**:Express 用 24h CACHE_TTL_MS 算 staleness;我们用 1h(跟 ristretto eviction TTL 对齐)。结果是 ristretto 1h 之内的 cache hit 短路 isStale 检查,1h 过期后 re-fetch 触发。Express 24h 之内 stale 不触发 re-fetch 是 Mongo 慢查询的妥协;Postgres 加 ristretto 我们能 1h 频更新且 RT 不退化。**取舍**:多一些 AniList API 调用换 fresher 数据 / 用户始终看到最近 1h 内的状态。Acceptable。
- **教训:Express 多 envelope 形状不止一种**:`/follow` 用 `{data,total,page,hasMore,nextPage}`(httpx.Pagination 走这套),但 `/seasonal` 用 `{data,pagination:{page,perPage,total,totalPages}}`,`/watchers` 用 `{data,total}`(单 sibling),`/trending` 用 flat `{data:[]}`。每个 endpoint 写之前先 `grep ctrl.*\$res.json` Express,确认 envelope 形状再选 helper(httpx.Data / httpx.Page / 私有 writeMultiKeyEnvelope)。盲套 httpx.Data 会双重 wrap。
- **教训:struct embed 不能强制 JSON 字段顺序**:`dbgen.GetTrendingWithCountsRow` `WatcherCount` 是最后字段;Express 要 `rank, watcherCount` 在 anime fields **前**。embed 顺序由 Go 决定,与 Express 不匹配 → 必须手写 longhand struct 复制字段顺序。每加一个 endpoint,先看 Express ctrl 的 `data` 字段顺序,确认 dbgen row 顺序匹配,**不匹配就手写 struct,不要 embed**。
- **教训:byte-level envelope 测试在 Phase 2 早期是 boil-the-lake 例子**。Unit logic test 验"NotFound 码=NOT_FOUND"是不够的,真要捕捉 shadow traffic 阶段会 fail 的差异(key 顺序 / null vs 缺失字段 / HTML escape),必须从 Express 真实输出回写字节做 `bytes.Equal`。`httpx/express_fixture_test.go` 6 case 是模板,P2.x 每加 endpoint 写一组同模板的 byte fixture。
- **教训:Go internal 包名跟 third-party 撞**:`internal/middleware/` 跟 `github.com/go-chi/chi/v5/middleware` 冲突,任何同时用本地中间件 + chi 自带 RequestID 的文件都要 alias 一个。改 `internal/httpmw/`(或 `httpx/` 也行)完全没这问题。Go 惯例:`internal/<short-prefix>` 优先,不重 stdlib / popular-third-party 包名。
- **教训:docker healthcheck 日志洪水**:Docker `start_period: 30s` 每 30s 探一次 /health,prod 一个 pod 一天 2880 条 log。RequestLog 必须 verbatim skip `/health` 路径(`if req.URL.Path == "/health" { next.ServeHTTP(w, req); return }`)。如果只走 Debug level skip 会丢 5xx healthcheck 报警 —— P2.0.D 选了 verbatim skip + 业务 endpoint 全级别 log。
