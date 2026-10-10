# go-api 代码地图

这份文档回答一个问题：**"我要改 X，该打开哪个文件？"** 它不解释为什么这样设计（为什么写在代码注释里），只告诉你东西在哪、谁调用谁。

- 覆盖范围：`go-api/` 下每一个目录、每一个包、每一个 SQL 文件、每一个迁移、每一种后台任务、每一个 `/api/*` 路由前缀。
- 防过期：`test/archdoc/archdoc_test.go` 会在 `go test ./...` 里检查这份文档。新增包、SQL 文件、迁移、任务种类、队列、开关或路由前缀却没写进来，CI 会红；文档里用反引号写的路径如果已经不存在，CI 也会红。
- 不在这里的东西：表结构看 `migrations/`；每个任务的节奏和取舍看 `internal/queue/registry_default.go` 的注释；前端看仓库根目录下的 `next-app/`。

目录：

1. [两条主线](#1-两条主线)
2. [顶层目录](#2-顶层目录)
3. [包按层分组](#3-包按层分组)
4. [HTTP 路由 → 包](#4-http-路由--包)
5. [中间件链](#5-中间件链)
6. [后台任务（river）](#6-后台任务river)
7. [SQL 文件 → 调用方](#7-sql-文件--调用方)
8. [迁移](#8-迁移)
9. [命令行工具](#9-命令行工具)
10. [测试](#10-测试)
11. [环境变量（只列名字）](#11-环境变量只列名字)
12. [想改 X 看哪里](#12-想改-x-看哪里)
13. [已知的遗留和过期内容](#13-已知的遗留和过期内容)

---

## 1. 两条主线

整个服务只有两种代码路径。认清它们，`internal/` 下的每个包就能各归其位。

**请求路径**（用户在等）：

```
浏览器 / next-app
   │
   ▼
cmd/server/main.go  ── 中间件链（§5）── chi 路由（§4）
   │
   ▼
internal/<业务包>/handlers.go 等     例：anime、auth、community、admin
   │            │
   │            └─► 上游客户端（cache miss 时）  anilist / bangumi / dandanplay / torrents
   ▼
internal/db/gen （sqlc 生成）  ◄── internal/db/queries/*.sql（手写 SQL）
   │
   ▼
Postgres（表结构 = migrations/*.up.sql）
```

**后台路径**（没人在等，river 调度）：

```
internal/queue/registry_default.go   声明：每个任务在哪个队列、多久跑一次
   │
cmd/server/main.go: buildWorkers()   注册：每个任务由哪个 worker 执行
   │
   ▼
internal/queue/<任务>.go             执行：向上游取数据
   │
   ├─► internal/anilist / bangumi / dandanplay / deepseek   上游客户端
   ├─► internal/credits / profiles / episodetitles / hant   把上游数据转成行并写库
   ▼
internal/db/gen → Postgres
```

两条路径相交的地方：

- `anime` 的 search、schedule 在 cache miss 时投递 V1 富化任务（`queue.Enqueuer`）。
- `admin` 的富化、预热、繁中回填和队列暂停按钮直接操作 `queue`。
- 服务启动时，`main.go` 自己投递当季和下季的 `warm_season` 任务，并跑一次孤儿扫描（`queue.ScanAndEnqueueOrphans`）。

---

## 2. 顶层目录

| 路径 | 是什么 |
|---|---|
| `cmd/` | 可执行程序。`server` 是线上服务，其余是一次性或运维用 CLI（§9） |
| `internal/` | 所有业务代码，按包组织（§3） |
| `internal/db/queries/` | 手写 SQL，sqlc 的输入（§7） |
| `internal/db/gen/` | sqlc 生成的 Go 代码，**不要手改**，用 `make sqlc-generate` 重新生成 |
| `migrations/` | golang-migrate 迁移，同时是 sqlc 的 schema 来源（§8） |
| `data/hant/` | 繁中数据集，由 `internal/hant` 读取：`anilist-chinese.json`、`cgroup-hk.json`、`opencc-s2twp.txt`，以及各自的 LICENSE 和 `README.md` |
| `docker/postgres/Dockerfile` | 开发和测试用的 Postgres 镜像，带 pg_cron；测试容器镜像名 `animego-postgres:dev` |
| `test/integration/` | testcontainers 集成测试，需要 `-tags=integration`（§10） |
| `test/byteparity/` | 与旧 Express 输出逐字节对比的回归夹具，需要 `-tags=byteparity`（§10） |
| `test/archdoc/` | 检查本文档是否漏写的测试（§10） |
| `Dockerfile` | 线上镜像 |
| `Makefile` | 常用命令，`make help` 查看 |
| `sqlc.yaml` | sqlc 配置：queries 来自 `internal/db/queries`，schema 来自 `migrations`，输出到 `internal/db/gen`（包名 `dbgen`） |
| `README.md` | 快速上手；部分内容已过期（§13） |

---

## 3. 包按层分组

`internal/` 现在是平铺的 42 个包（另有两个空占位目录），以下按职责分层。"依赖"一列只列 `internal/` 内的包，不列 `internal/db/gen` 和 `internal/httpx`（几乎人人都用）。

### 3.1 入口

| 包 | 做什么 | 主要文件 |
|---|---|---|
| `cmd/server` | 线上 HTTP 服务。按顺序：读配置 → 连库 → 建上游客户端 → `buildWorkers` → 启动 river → 启动预热和孤儿扫描 → 建各 service → 中间件和路由 → 监听 → 优雅退出 | `main.go`（所有路由和 worker 都在这里接线） |

### 3.2 HTTP 基础设施（所有请求都会经过）

| 包 | 做什么 | 主要文件 | 依赖 | 被谁用 |
|---|---|---|---|---|
| `internal/httpx` | 统一响应信封、`APIError`、错误码、出站 HTTP transport | `envelope.go`、`error.go`、`codes.go`、`transport.go` | — | 几乎所有 HTTP 包和上游客户端 |
| `internal/httpmw` | 中间件：CORS、请求日志、panic 恢复、请求体上限、`/api/*` 全局按 IP 限流、404/405 | `cors.go`、`logger.go`、`recoverer.go`、`body_limit.go`、`api_ratelimit.go`、`notfound.go` | — | server |
| `internal/jwtx` | JWT 签发校验（HS256）、bcrypt；`RequireAuth` / `OptionalAuth` / `RequireAdmin` 中间件；同时接受 Bearer 头和 cookie | `jwt.go`、`middleware.go`、`optional.go`、`admin.go`、`context.go`、`bcrypt.go` | — | server 和所有需要登录的包 |
| `internal/activity` | 记录用户活跃（DAU/WAU/MAU 的来源）。中间件只打标，`recorder` 缓冲后批量写库 | `middleware.go`、`recorder.go`、`activity.go` | jwtx | server、admin |
| `internal/obs` | 把 slog 的 ERROR 转发到 Sentry（river 的后台失败只打一行 ERROR 日志，靠它才能被看见） | `sentryslog.go` | — | server |
| `internal/config` | 读环境变量（端口、数据库、JWT、SMTP、CORS） | `config.go` | — | server、cmd/bgmbackfill、cmd/bgmnames、cmd/hantbackfill |
| `internal/db` | 线上 pgxpool | `pool.go` | — | server、cmd/bgmbackfill、cmd/bgmnames、cmd/hantbackfill、testutil |
| `internal/cache` | ristretto 的带类型 TTL 封装 | `cache.go` | — | anime、dandanplay、torrents |

### 3.3 HTTP 业务域（每个包对应一组 `/api/*` 路由）

| 包 | 路由 | 做什么 | 主要文件 | 依赖（除 httpx、db/gen） | 被谁用 |
|---|---|---|---|---|---|
| `internal/anime` | `/api/anime/*` | 番剧详情、搜索、季度、排期、浏览和 hub、热门、种子、角色和制作 tab、集数偏移、sitemap；把 AniList 返回规范化成 `anime_cache` 行 | `detail.go`、`handlers.go`、`search.go`、`seasonal.go`、`schedule.go`、`browse.go`、`credit_lists.go`、`credit_lists_view.go`、`normalize.go`、`ensure_cached.go`、`episode_offset.go`、`sitemap.go`、`trailer.go` | anilist、bgmnames、cache、colorx、credits、pii、queue、torrents | server、subscriptions |
| `internal/community` | `/api/anime/{id}/community/*`，管理员删除挂在 `/api/admin/community/*` | 番剧页社区 tab：评测和"有帮助"投票、讨论串、回复、动态点赞、在看的人（迁移 0046） | `community.go`（路由）、`reviews.go`、`threads.go`、`activity.go`、`summary.go`、`admin.go`、`dto.go`、`limits.go`、`validate.go` | auth、jwtx、pii | server |
| `internal/people` | `/api/people/*`、`/api/characters/*` | 人物页和角色页、它们的 sitemap；叠加读者编辑后的结果 | `handlers.go`、`person.go`、`character.go`、`work.go`、`overlays.go`、`sitemap.go`、`dto.go` | overlay | server、edits |
| `internal/edits` | `POST /api/edits`、`/api/edit-images/*`，审核挂在 `/api/admin/edits*` | 读者对人物和角色页的编辑提交，以及管理员审核（迁移 0047） | `routes.go`、`submit.go`、`changes.go`、`review.go`、`stale.go`、`images.go`、`fetch.go`、`attempts.go`、`doc.go` | avatars、jwtx、overlay、people、pii | server |
| `internal/auth` | `/api/auth/*` | 注册、登录、刷新、登出、找回和重置密码、`/me`；登录类接口的内存限流 | `handlers.go`、`account.go`、`cookies.go`、`ratelimit.go`、`types.go` | avatars、email、jwtx、pii | server、community |
| `internal/avatars` | `/api/avatars/{name}` | 头像存成卷上的文件 | `store.go` | — | server、auth、edits |
| `internal/subscriptions` | `/api/subscriptions/*` | 追番 CRUD 和按集标记已看 | `handlers.go`、`types.go`、`validate.go` | anime（`EnsureCached`）、jwtx | server |
| `internal/social` | `/api/users/{username}`、follow、关注列表、`/api/feed` | 公开主页、关注、动态流 | `profile.go`、`follow.go`、`followers.go`、`feed.go`、`handlers.go`、`types.go` | jwtx、pii | server |
| `internal/safety` | `/api/users/{username}/block`、`/api/blocks`、`/api/reports`、`/api/admin/reports*` | 拉黑和举报 | `handlers.go` | jwtx | server |
| `internal/comments` | `/api/comments/*`、`/api/community/discussions/trending`、`/api/community/engagement`、`/api/admin/community-metrics` | 每集讨论（扁平列表）、表情回应、热门讨论、社区曝光统计 | `handlers.go`、`community.go`、`validate.go` | jwtx、pii | server |
| `internal/notifications` | `/api/notifications/*` | 站内通知收件箱 | `handlers.go` | jwtx、pii | server |
| `internal/danmaku` | `/api/danmaku/{id}/{ep}` | 只读弹幕 | `handlers.go` | pii | server |
| `internal/dandanplay` | `/api/dandanplay/*` | **两种身份**：dandanplay 的 HTTP 客户端，以及 match、search、comments、episodes 四个接口；还负责季度和分部感知的番剧匹配 | `client.go`、`handlers.go`、`match.go`、`site_anime.go`、`seasonmatch.go`、`episode_map.go`、`episode_title_text.go`、`normalize.go`、`envelope.go` | bangumi、cache、titlematch | server、queue、episodetitles、cmd/bgmbackfill |
| `internal/admin` | `/api/admin/*` | 后台：统计、富化列表和操作、用户 CRUD、活跃面板、队列暂停和恢复、繁中统计和回填、全量预热 | `enrichment.go`、`users.go`、`read.go`、`activity.go`、`hant.go`、`list_enrichment.go`、`list_users.go`、`warm_all.go`、`handlers.go`、`envelope.go`、`types.go` | activity、jwtx、queue | server |

### 3.4 上游客户端（只负责"问别人"，不写库）

| 包 | 上游 | 主要文件 | 被谁用 |
|---|---|---|---|
| `internal/anilist` | AniList GraphQL（共享一个限流器） | `client.go`、`queries.go`、`types.go`、`profiles.go` | server、anime、credits、profiles、queue |
| `internal/bangumi` | api.bgm.tv（共享 800ms 令牌桶） | `client.go`、`match.go`、`summary.go`、`unescape.go` | server、queue、dandanplay、titlematch、cmd/bgmbackfill |
| `internal/dandanplay` | dandanplay.net（见 §3.3，同一个包） | `client.go` | 同上 |
| `internal/deepseek` | DeepSeek 对话接口，用于简介翻译 | `client.go` | server |
| `internal/torrents` | BT 资源聚合：acg.rip、animetosho、dmhy、萌番组（garden）、mikan、nyaa，外加 RSS 解析、排序、按源限速；结果用 cache 包缓存 | `aggregator.go`、`registry.go`、`source.go`；各源 `acgrip.go`、`animetosho.go`、`dmhy.go`、`garden.go`、`mikan.go`、`nyaa.go`；`rss.go`、`rank.go`、`infohash.go`、`throttle.go`、`types.go` | server、anime |
| `internal/email` | SMTP（找回密码邮件） | `email.go`、`reset_template.go` | server、auth |

### 3.5 领域转换和写入（不碰 HTTP，被 queue、anime 和 CLI 调用）

| 包 | 做什么 | 主要文件 | 依赖 | 被谁用 |
|---|---|---|---|---|
| `internal/credits` | 把 AniList 的角色和 staff 连接转成 `anime_characters` / `anime_character_voices` / `anime_staff` 行并写入 | `credits.go`、`write.go` | anilist | anime、queue |
| `internal/profiles` | 把 AniList 的人物和角色资料转成 `people` / `characters` 行并写入（迁移 0044） | `rows.go`、`write.go` | anilist | queue |
| `internal/episodetitles` | 把 dandanplay 的分集列表写成 `anime_episode_titles`（一个四条语句的事务） | `apply.go` | dandanplay | queue、cmd/bgmbackfill |
| `internal/hant` | 繁中标题和简介：数据集加载、优先级阶梯、质量门、OpenCC s2twp、批量写入、报告 | `load.go`、`datasets.go`、`resolve.go`、`gate.go`、`opencc.go`、`classify.go`、`apply.go`、`dbrows.go`、`report.go` | — | server、queue、cmd/hantbackfill |
| `internal/bgmnames` | 从 Bangumi Archive 转储给人物和角色配简中名，并记录 AniList id ↔ Bangumi id | `names.go`、`archive.go`、`match.go`、`run.go`、`write.go`、`summary.go` | — | anime、cmd/bgmnames |
| `internal/bgmidmap` | 内嵌 AniList→Bangumi、AniList→AniDB 映射，启动时写入 `bgm_id_map` / `anidb_id_map` | `loader.go`、`anilist_bgm_map.json`、`anilist_anidb_map.json` | — | server |
| `internal/titlematch` | 判断两个番剧标题是否是同一部（含季度和分部识别） | `titlematch.go`、`normalize.go`、`season.go` | bangumi | dandanplay、queue |
| `internal/overlay` | 读者编辑的叠加层：读页面时按它覆盖原值 | `doc.go` | — | edits、people |
| `internal/colorx` | 海报主色的 OKLab/OKLCH 规范化（移植自 Express） | `accent.go` | — | anime |
| `internal/pii` | 遮蔽用户误填进用户名等字段的个人信息 | `username.go` | — | anime、auth、comments、community、danmaku、edits、notifications、social |

### 3.6 后台任务

| 包 | 做什么 | 被谁用 |
|---|---|---|
| `internal/queue` | 所有 river 任务、队列声明、投递接口、管理员暂停和恢复，详见 §6 | server、admin、anime |

依赖：anilist、bangumi、credits、dandanplay、episodetitles、hant、profiles、titlematch。

### 3.7 数据层

| 路径 | 做什么 |
|---|---|
| `internal/db/queries/` | 手写 SQL（§7）。还有一个 `.gitkeep`，是建目录时的遗留 |
| `internal/db/gen/` | sqlc 输出：每个 SQL 文件对应一个 `*.sql.go`，另有 `models.go`、`querier.go`、`db.go`、`copyfrom.go`。还有一个 `.gitkeep`，是建目录时的遗留 |
| `migrations/` | 迁移（§8） |

### 3.8 测试辅助和一次性迁移遗留

| 包 | 做什么 | 主要文件 | 被谁用 |
|---|---|---|---|
| `internal/testutil` | 起 testcontainers Postgres 并跑迁移（依赖 db）；共享的同义词脚本用例表 | `pg.go`、`synonym_cases.go` | `test/integration` 和各包的 `*_pg_test.go` |
| `internal/migrate` | P1 阶段 MongoDB → Postgres 一次性迁移的编排器（拓扑排序、批量 upsert、失败日志）。**没有 cmd 入口**（§13） | `orchestrator.go`、`transform.go`、`mongo_conn.go`、`pg_conn.go` | `internal/migrate/transforms`、`test/integration/migrate_test.go` |
| `internal/migrate/transforms` | 每个 Mongo 集合一个转换，实现 migrate 包的 Transform 接口；anime_cache 会拆出 7 张子表 | `anime_cache.go`、`danmakus.go`、`episode_comments.go`、`episode_windows_transform.go`、`follows.go`、`subscriptions.go`、`users.go`、`util.go` | 仅测试 |

### 3.9 空占位目录（只有 `.gitkeep`）

| 路径 | 说明 |
|---|---|
| `internal/routes/` | 早期规划的路由层，从未使用；路由都在 `cmd/server/main.go` |
| `internal/services/` | 早期规划的 service 层，从未使用；service 都在各业务包里 |
| `cmd/migrate/` | 规划中的 golang-migrate 包装，从未实现；实际用 `make migrate-up`，即 migrate CLI |
| `cmd/seed/` | 规划中的开发数据加载器，从未实现 |

---

## 4. HTTP 路由 → 包

所有路由都在 `cmd/server/main.go` 里注册；少数由包内的 `Mount` 函数注册，下表已标出。鉴权一列：**登录** = `jwtx.RequireAuth`，**可选** = `jwtx.OptionalAuth`，**管理员** = `RequireAuth` 加 `RequireAdmin`。

| 前缀 | 路由 | 包 | 鉴权 |
|---|---|---|---|
| `/health`、`/api/health` | GET（会 ping 数据库） | `cmd/server`（`healthHandler`） | — |
| `/api/avatars` | `GET /{name}` | avatars | — |
| `/api/auth` | `POST /register` `/login` `/refresh` `/forgot-password` `/reset-password/{token}` `/logout`；`GET`、`PATCH /me` | auth | 前 6 个有 auth 限流；`/me` 需登录 |
| `/api/anime` | `GET /completed-gems` `/seasonal` `/yearly-top` `/browse` `/hubs` `/trending` `/torrents` `/search` `/schedule` `/episodes` `/episode-offsets` `/sitemap` | anime（`/torrents` 经 torrents 包） | — |
| `/api/anime` | `GET /{anilistId}` `/{anilistId}/watchers` `/{anilistId}/episode-offset` `/{anilistId}/characters` `/{anilistId}/staff` `/{anilistId}/credit-counts` | anime | — |
| `/api/anime/{anilistId}/community` | `GET /` `/count` `/reviews` `/reviews/mine` `/reviews/{reviewId}` `/threads` `/threads/{threadId}` `/activity` `/activity/{eventId}` `/watchers`；评测的增删改和"有帮助"投票、发串、删串、回复、动态点赞、删回复 | community（`community.go` 的 `Mount`） | 读为可选，写需登录 |
| `/api/people`、`/api/characters` | `GET /sitemap` `/{id}` | people（`MountPeople` / `MountCharacters`） | — |
| `/api/edits` | `POST /api/edits` | edits（`routes.go` 的 `Mount`） | 登录 |
| `/api/edit-images` | `GET /{name}` | edits | — |
| `/api/subscriptions` | `GET`、`POST /`；`GET`、`PATCH`、`DELETE /{anilistId}`；`PUT /{anilistId}/episodes`；`PUT`、`DELETE /{anilistId}/episodes/{episode}` | subscriptions | 登录 |
| `/api/users` | `GET /{username}`（可选）；`POST`、`DELETE /{username}/follow`；`GET /{username}/followers` `/following` | social | 见括号 |
| `/api/users` | `PUT`、`DELETE /{username}/block` | safety | 登录 |
| `/api/feed` | GET | social | 登录 |
| `/api/comments` | `GET /summary/{anilistId}` `/{anilistId}/{episode}`（可选）；`POST /{anilistId}/{episode}`；`DELETE /{id}`；`PUT`、`DELETE /{id}/reaction` | comments | 写需登录 |
| `/api/community` | `GET /discussions/trending`；`POST /engagement` | comments | 可选 |
| `/api/notifications` | `GET /` `/unread-count`；`POST /read-all`；`PATCH /{id}/read` | notifications | 登录 |
| `/api/blocks`、`/api/reports` | `GET /api/blocks`；`POST /api/reports` | safety | 登录 |
| `/api/danmaku` | `GET /{anilistId}/{episode}` | danmaku | — |
| `/api/dandanplay` | `POST /match`；`GET /search` `/comments/{episodeId}` `/episodes/{animeId}` | dandanplay | — |
| `/api/admin` | `GET /stats` `/enrichment` `/users` | admin（`read.go`） | 管理员 |
| `/api/admin` | `GET /reports`；`PATCH /reports/{id}` | safety | 管理员 |
| `/api/admin` | `DELETE /community/reviews/{reviewId}` `/community/threads/{threadId}` `/community/replies/{replyId}` | community（`MountAdmin`） | 管理员 |
| `/api/admin` | `GET /community-metrics` | comments | 管理员 |
| `/api/admin` | `GET /activity` | admin（`activity.go`） | 管理员 |
| `/api/admin` | `POST /enrichment/re-enrich` `/enrichment/re-enrich-ids` `/enrichment/heal-cn` `/enrichment/heal-cn/pause` `/enrichment/heal-cn/resume` `/enrichment/{anilistId}/reset` `/enrichment/{anilistId}/flag`；`PATCH /enrichment/{anilistId}` | admin（`enrichment.go`） | 管理员 |
| `/api/admin` | `GET /queues`；`POST /queues/{name}/pause` `/queues/{name}/resume` | admin（`enrichment.go`）→ queue | 管理员 |
| `/api/admin` | `GET /hant/stats`；`POST /hant/backfill` | admin（`hant.go`） | 管理员 |
| `/api/admin` | `GET /edits` `/edits/{id}` `/edits/images/{name}`；`POST /edits/{id}/review` | edits（`MountAdmin`） | 管理员 |
| `/api/admin` | `POST /warm-all` `/users` `/users/{userId}/password`；`PATCH`、`DELETE /users/{userId}` | admin（`users.go`、`warm_all.go`） | 管理员 |

未匹配的路由由 `httpmw.NotFound` 和 `httpmw.MethodNotAllowed` 返回统一信封。

---

## 5. 中间件链

在 `cmd/server/main.go` 里按以下顺序 `r.Use`（外层在前）：

1. `httpmw.CORS`：允许的来源来自 `CLIENT_ORIGIN`
2. chi `middleware.RequestID`
3. chi `middleware.RealIP`
4. `httpmw.RequestLog`：跳过 `/health`
5. `httpmw.Recoverer`：panic 时返回信封格式的 500
6. `sentryhttp`：`Repanic: true`，让 Recoverer 仍能接住
7. chi `middleware.Timeout(60s)`
8. `httpmw.MaxBodyBytes`
9. `httpmw` 全局按 IP 限流（`api_ratelimit.go`，只作用于 `/api/*`）
10. `activity.Middleware`：记录活跃用户

路由级的中间件（`RequireAuth`、`OptionalAuth`、`RequireAdmin`，以及 auth 的登录、刷新、登出三个限流器）在 §4 的鉴权列里。

---

## 6. 后台任务（river）

**加一个后台任务要动三个地方：**

1. 在 `internal/queue/args.go`（或任务自己的文件）定义 Args 和 `Kind()`。
2. 在 `internal/queue/registry_default.go` 声明队列和周期。
3. 在 `cmd/server/main.go` 的 `buildWorkers` 注册 worker。

`cmd/server/workers_test.go` 会检查注册表里的每种任务都有 worker。

### 6.1 队列（`registry_default.go` 的 `productionQueues`）

| 队列 | 并发 | 跑什么 | 为什么是这个数 |
|---|---|---|---|
| `default` | 1 | V1、V2、warm_season、orphan_scan | V1 和 V2 共用 Bangumi 令牌桶。管理员暂停功能**拒绝**暂停这个队列 |
| `bangumi_v3` | 1 | V3（heal-CN） | 同一个 Bangumi 令牌桶；单独成队列是为了能单独暂停 |
| `description_backfill` | 1 | 简中简介回填 | 受令牌桶限制，加并发没用 |
| `description_llm` | 4（可调） | LLM 翻译 | DeepSeek 往返是唯一成本，可以并行 |
| `hant_backfill` | 1 | 繁中全表扫描 | 一个任务就是整张表 |
| `episodes_bgm` | 1 | 推断集数 | 每行两次 Bangumi 请求 |
| `episode_titles` | 1 | 在播番分集标题 | dandanplay 令牌桶和用户的 `/match` 共用 |
| `bgm_bind` | 1 | id 映射绑定 | **防并发竞态**，单槽是承重设计 |
| `ratings` | 1 | 两种评分刷新、facts、credits、profiles | 让所有 AniList 扫描一次只有一个在用共享限流器 |
| `image_warm` | 1 | 图片原图预热 | 一次扫描自己控制节奏 |

### 6.2 任务种类（`productionEntries`）

| kind | Args 类型 | worker 所在文件 | 队列 | 周期 | 启动即跑 | 开关（默认关） |
|---|---|---|---|---|---|---|
| `bangumi_v1` | `BangumiV1Args` | `bangumi_v1.go` | default | 不定期，由 anime（search、schedule）、orphan、warm_season、admin 投递 | — | — |
| `bangumi_v2` | `BangumiV2Args` | `bangumi_v2.go` | default | 不定期，由 V1、bgm_bind_idmap、admin 投递 | — | — |
| `bangumi_v3` | `BangumiV3Args` | `bangumi_v3.go` | bangumi_v3 | 不定期，由 V2、admin（heal-CN）投递 | — | — |
| `warm_season` | `WarmSeasonArgs` | `warm_season.go` | default | 24h | 否；`cmd/server/main.go` 启动时手动投递当季和下季 | — |
| `orphan_scan` | `OrphanScanArgs` | `orphan_scan_job.go`（扫描逻辑在 `orphan.go`） | default | 1h | 否；`cmd/server/main.go` 启动时直接跑一次 | — |
| `description_backfill_scan` | `DescriptionBackfillScanArgs` | `description_backfill.go` | description_backfill | 1h | 是 | — |
| `description_backfill` | `DescriptionBackfillArgs` | `description_backfill.go` | description_backfill | 由 scan 分发 | — | — |
| `description_llm_backfill_scan` | `DescriptionLlmBackfillScanArgs` | `description_llm_backfill.go` | description_llm | 1h | 是 | `DEEPSEEK_API_KEY` 为空时 scan 是空操作 |
| `description_llm_backfill` | `DescriptionLlmBackfillArgs` | `description_llm_backfill.go` | description_llm | 由 scan 分发 | — | 同上 |
| `episodes_bgm_scan` | `EpisodesBgmScanArgs` | `bangumi_episodes.go` | episodes_bgm | 1h | 是 | — |
| `episodes_bgm` | `EpisodesBgmArgs` | `bangumi_episodes.go` | episodes_bgm | 由 scan 分发 | — | — |
| `episode_titles_releasing` | `EpisodeTitlesArgs` | `episode_titles_releasing.go`（写入 `episode_titles_write.go`，撤回 `episode_titles_retract.go`） | episode_titles | 6h | 是 | `EPISODE_TITLES_SWEEP_ENABLED` |
| `bgm_bind_idmap` | `BindIdMapArgs` | `bgm_bind_idmap.go` | bgm_bind | 6h | 是 | `BGM_BIND_IDMAP_SWEEP_ENABLED` |
| `hant_backfill` | `HantBackfillArgs` | `hant_backfill.go` | hant_backfill | 90 天 | 否；管理员按钮手动触发 | 数据目录 `HANT_DATA_DIR` |
| `anilist_ratings` | `AnilistRatingsArgs` | `ratings_refresh.go` | ratings | 1h | 是 | — |
| `bangumi_ratings` | `BangumiRatingsArgs` | `ratings_refresh.go` | ratings | 1h | 是 | — |
| `anime_facts` | `AnimeFactsArgs` | `anime_facts.go` | ratings | 1h | 是 | — |
| `anime_credits` | `AnimeCreditsArgs` | `anime_credits.go` | ratings | 5min | 是 | `ANIME_CREDITS_SWEEP_ENABLED` |
| `profiles` | `ProfilesArgs` | `profiles.go` | ratings | 5min | 是 | `PROFILES_SWEEP_ENABLED` |
| `image_warm` | `ImageWarmArgs` | `image_warm.go`（磁盘余量检查在 `image_warm_disk.go` / `image_warm_disk_other.go`） | image_warm | 1h | 是 | `IMAGE_WARM_BASE_URL` 为空 = 空操作 |

"开关"一列的 `*_ENABLED` 变量都在任务执行时读取：只有 `strconv.ParseBool` 认作 true 的值才开启，空值或拼错都视为关闭。

### 6.3 `internal/queue` 里不是任务的文件

| 文件 | 做什么 |
|---|---|
| `registry.go` | `Registry` 类型：校验、导出 `QueueConfigs` 和 `PeriodicJobs`、列出可暂停的队列 |
| `registry_default.go` | 生产环境的队列和任务声明（§6.1、§6.2 的来源） |
| `args.go` | 大部分 Args 类型和 `Kind()`，以及 worker bundle 的构建（`WorkersWithBangumiAndNormalizer`） |
| `worker.go` | river client 启动（`Boot`）和关闭（`Shutdown`） |
| `enqueue.go` | 投递接口：`Enqueuer`、`LateBoundEnqueuer`、`NoopEnqueuer` |
| `control.go` | 队列名常量、管理员暂停、恢复和状态查询 |
| `orphan.go` | `ScanAndEnqueueOrphans`：给还没富化的行投递 V1 |
| `legacy_binding.go` | 老 Bangumi 绑定的身份校验 |
| `v3batch.go` | V3 批次进度（进程内内存） |
| `warm_all.go` | `/api/admin/warm-all` 的批量季度预热分发 |

---

## 7. SQL 文件 → 调用方

sqlc 为每个 `internal/db/queries/<name>.sql` 生成 `internal/db/gen/<name>.sql.go`。查询数按 `-- name:` 统计，`test/archdoc` 会核对。

| SQL 文件 | 查询数 | 主要表 | 调用方 |
|---|---|---|---|
| `anime_cache.sql` | 108 | `anime_cache` 及其子表 | queue、anime、credits、episodetitles、dandanplay、subscriptions、admin、cmd/bgmbackfill、cmd/hantbackfill |
| `anime_community.sql` | 31 | `anime_reviews`、`anime_review_votes`、`anime_threads`、`community_replies`、`activity_likes`（0046） | community、safety |
| `admin.sql` | 22 | `anime_cache` 富化状态、`users` | admin |
| `edits.sql` | 22 | `edit_submissions`、`edit_items`、`entity_overlays`（0047） | edits、people、notifications |
| `users.sql` | 17 | `users` | auth、admin |
| `social.sql` | 15 | `follows`、动态流 | social、safety |
| `community.sql` | 14 | 评论表情回应、通知（0018） | notifications、comments |
| `subscriptions.sql` | 11 | `subscriptions`、`episode_watches` | subscriptions |
| `bgm_name_maps.sql` | 10 | Bangumi 人物和角色映射（0045） | bgmnames |
| `comments.sql` | 8 | `episode_comments` | comments、safety |
| `people_pages.sql` | 8 | `people`、`characters`、`anime_characters`、`anime_character_voices` | people |
| `safety.sql` | 8 | `user_blocks`、`reports`（0019） | safety、social、comments、community |
| `backfill.sql` | 6 | `anime_cache` 的绑定回填 | cmd/bgmbackfill |
| `image_mirror.sql` | 6 | `image_manager`（0049） | queue（image_warm） |
| `profiles.sql` | 6 | `people`、`characters`（0044） | profiles、queue |
| `activity.sql` | 5 | `user_activity_daily`（0025） | admin |
| `credit_lists.sql` | 5 | `anime_characters`、`anime_staff`、`entity_overlays`、`bgm_person_map` | anime |
| `ddp.sql` | 4 | `anime_cache`、`bgm_id_map`（dandanplay 交叉探测） | cmd/bgmbackfill |
| `anidb_id_map.sql` | 3 | `anidb_id_map`（0041） | bgmidmap |
| `bgm_id_map.sql` | 3 | `bgm_id_map` | bgmidmap |
| `dandanplay.sql` | 3 | `anime_cache`（dandanplay 匹配用） | dandanplay |
| `danmakus.sql` | 2 | `danmakus` | danmaku |

**不经过 sqlc 的手写 SQL**（改表结构时也要搜这些地方）：

- `cmd/server/main.go`：后台的队列和 LLM 统计查询
- `internal/activity/recorder.go`：活跃记录的批量写入
- `internal/admin/list_enrichment.go`、`internal/admin/list_users.go`：动态拼接的列表查询
- `internal/admin/users.go`
- `internal/migrate/orchestrator.go`：一次性迁移

---

## 8. 迁移

每个迁移都有 `.up.sql` 和 `.down.sql`。迁移文件同时是 sqlc 的 schema 来源，所以加列以后要 `make sqlc-generate`。

| 编号 | 名称 | 内容 |
|---|---|---|
| 0001 | `init` | 初始表结构（从 MongoDB 迁来） |
| 0002 | `indexes` | 二级索引 |
| 0003 | `defer_comment_self_fk` | 评论自引用外键改为延迟检查 |
| 0004 | `relax_bangumi_version` | 放宽 `bangumi_version` 的 CHECK |
| 0005 | `pg_cron_extension` | 启用 pg_cron |
| 0006 | `danmaku_ttl_schedule` | 弹幕一年 TTL 定时任务 |
| 0007 | `river_initial` | river 内部表 |
| 0008 | `river_pending_use` | river 后续内部迁移 |
| 0009 | `users_email_lowercase` | 邮箱强制小写 |
| 0010 | `refresh_token_grace` | refresh token 轮换宽限窗口 |
| 0011 | `match_accuracy` | 富化匹配准确度 |
| 0012 | `user_personalization` | 头像、自选背景番剧 |
| 0013 | `bgm_id_map_anidb` | `bgm_id_map` 加 `anidb_id` |
| 0014 | `description_cn` | 简中简介列 |
| 0015 | `description_cn_attempted` | 简介尝试时间戳 |
| 0016 | `description_cn_eligible` | 绑定可信度的统一定义 |
| 0017 | `description_cn_llm` | LLM 翻译尝试时间戳 |
| 0018 | `community_events` | 社区事件、站内通知、评论点赞 |
| 0019 | `community_safety` | 拉黑和举报 |
| 0020 | `community_discovery` | 社区发现信号、曝光统计 |
| 0021 | `activity_events_prune` | `activity_events` 保留 90 天 |
| 0022 | `title_hant` | 繁中标题和简介 |
| 0023 | `episodes_bgm` | 推断集数 |
| 0024 | `episode_watches` | 按集已看 |
| 0025 | `user_activity` | 用户活跃记录 |
| 0026 | `user_activity_backfill` | 活跃数据回填 |
| 0027 | `title_hant_search_index` | 繁中标题进入搜索 |
| 0028 | `welcome_card_engagement` | /welcome 卡片曝光统计 |
| 0029 | `episode_title_source` | 分集标题按字段记录来源 |
| 0030 | `repair_episode_title_provenance` | 修复标题和来源不一致的行 |
| 0031 | `bangumi_subject_unreadable` | 记录"Bangumi 条目不可读" |
| 0032 | `anime_trailer` | 预告片元数据 |
| 0033 | `anime_rating_counts` | 评分人数和刷新时间戳 |
| 0034 | `anime_facts` | 开播、完结日期等 facts |
| 0035 | `anime_facts_checked` | facts 扫描时间戳 |
| 0036 | `anime_scalars` | AniList 的其余标量字段 |
| 0037 | `character_staff_ids` | 角色和 staff 的 AniList id |
| 0038 | `tags_links_studio_ids` | 标签、外链、制作公司 id |
| 0039 | `hub_indexes` | hub 页的反查索引 |
| 0040 | `synonym_scripts` | 同义词的文字系统分类 |
| 0041 | `anidb_id_map` | AniList → AniDB 映射 |
| 0042 | `credits_completeness` | 角色的全部声优、演职员行可寻址 |
| 0043 | `credits_sweep_stamps` | credits 扫描时间戳 |
| 0044 | `profiles` | 人物和角色资料 |
| 0045 | `bgm_name_maps` | Bangumi 人物和角色映射 |
| 0046 | `anime_community` | 番剧页社区 tab |
| 0047 | `entity_edits` | 读者编辑和审核 |
| 0048 | `bgm_character_summary` | Bangumi 角色简介 |
| 0049 | `image_mirror` | 图片预热状态表（`image_manager`） |

---

## 9. 命令行工具

| 命令 | 做什么 | 文件 | 依赖 |
|---|---|---|---|
| `cmd/server` | 线上服务（§3.1） | `main.go` | 几乎所有包 |
| `cmd/bgmbackfill` | 重新校验已有 Bangumi 绑定，回填分集标题；含只读审计、dandanplay 交叉探测、id-map 绑定预览（**刻意不带 `--apply`**） | `main.go`、`classify.go`、`audit_binding.go`、`ddp_crosslink_probe.go`、`episode_titles.go`、`id_map_binds.go` | bangumi、config、dandanplay、db、episodetitles |
| `cmd/bgmmap` | 用 Fribb 和 BangumiExtLinker 两份社区数据，生成 `internal/bgmidmap/*.json`；由 `.github/workflows/refresh-bgm-map.yml` 定期运行 | `main.go`、`join.go`、`overrides.go`、`overrides.json`、`report.go` | 无内部依赖 |
| `cmd/bgmnames` | 从 Bangumi Archive 导入人物和角色的简中名 | `main.go` | bgmnames、config、db |
| `cmd/hantbackfill` | 用繁中数据集回填 `title_hant` 和 `description_hant`（和 `hant_backfill` 任务是同一套逻辑的进程外版本） | `main.go` | config、db、hant |
| `cmd/migrate`、`cmd/seed` | 空目录（§3.9） | — | — |

---

## 10. 测试

| 类型 | 位置 | 怎么跑 | CI |
|---|---|---|---|
| 单元测试 | 各包的 `*_test.go` | `go test ./...` 或 `make test` | `.github/workflows/unit-tests.yml` |
| 需要 Postgres 的包内测试 | 各包的 `*_pg_test.go` 等，通过 `internal/testutil` 起容器 | 同上；需要 Docker 和 `animego-postgres:dev` 镜像（`docker/postgres/Dockerfile`） | 同上 |
| 集成测试 | `test/integration/` | `go test -tags=integration ./test/integration/...` 或 `make test-integration` | `unit-tests.yml` 先 `go vet -tags=integration ./...` 再跑这些测试 |
| 字节一致性 | `test/byteparity/`（`harness.go`、`byteparity_test.go`、`test/byteparity/testdata/`） | `make byteparity`，需要先起一个服务 | 手动 |
| 文档覆盖 | `test/archdoc/archdoc_test.go` | `go test ./test/archdoc/` | 随 `go test ./...` 运行 |
| 接线测试 | `cmd/server/workers_test.go`、`main_wiring_test.go`、`main_test.go` | `go test ./cmd/server/` | 随 `go test ./...` 运行 |

---

## 11. 环境变量（只列名字）

值和密钥都不在仓库里。

| 变量 | 谁读 | 作用 |
|---|---|---|
| `PORT_GO`、`DATABASE_URL`、`CLIENT_ORIGIN` | `internal/config` | 端口、数据库、CORS |
| `JWT_SECRET`、`JWT_REFRESH_SECRET`、`JWT_EXPIRES_IN`、`JWT_REFRESH_EXPIRES_IN` | `internal/config` | JWT |
| `SMTP_HOST`、`SMTP_USER`、`SMTP_PASSWORD`、`MAIL_FROM`、`GMAIL_USER`、`GMAIL_APP_PASSWORD` | `internal/config` | 找回密码邮件；全空则不发 |
| `GO_ENV` | `cmd/server` | 等于 `production` 时 refresh cookie 用 `SameSite=None; Secure`（传给 `internal/auth/cookies.go`） |
| `SENTRY_DSN`、`GIT_SHA`、`APP_ENV` | `cmd/server` | Sentry |
| `AVATAR_DIR`、`EDIT_IMAGE_DIR` | `cmd/server` | 头像和编辑图片的存储卷 |
| `AUTH_RATELIMIT_MAX`、`AUTH_REFRESH_RATELIMIT_MAX`、`API_RATELIMIT_BURST` | `cmd/server` | 限流参数 |
| `DEEPSEEK_API_KEY` | `cmd/server` | LLM 翻译；为空则该任务关闭 |
| `DANDANPLAY_APP_ID`、`DANDANPLAY_APP_SECRET` | `cmd/server` | dandanplay 凭证 |
| `HANT_DATA_DIR` | `internal/hant/load.go` | 繁中数据集目录，默认 `data/hant` |
| `EPISODE_TITLES_SWEEP_ENABLED`、`BGM_BIND_IDMAP_SWEEP_ENABLED`、`ANIME_CREDITS_SWEEP_ENABLED`、`PROFILES_SWEEP_ENABLED` | `internal/queue` | 后台任务开关（§6.2） |
| `IMAGE_WARM_BASE_URL` | `internal/queue/image_warm.go` | 图片预热的 nginx 端点；为空则不预热 |

---

## 12. 想改 X 看哪里

| 想改 | 先看 |
|---|---|
| 番剧详情页返回的字段 | `internal/anime/detail.go`；从 AniList 怎么转成行看 `internal/anime/normalize.go` |
| 搜索 | `internal/anime/search.go`，SQL 在 `internal/db/queries/anime_cache.sql` |
| 季度、排期、热门、hub | `internal/anime/seasonal.go`、`schedule.go`、`handlers.go`、`browse.go` |
| 角色和制作 tab | `internal/anime/credit_lists.go`、`credit_lists_view.go`；写入看 `internal/credits` |
| 人物和角色页 | `internal/people`；读者编辑看 `internal/edits` 和 `internal/overlay` |
| 番剧页社区 tab | `internal/community` |
| 每集评论 | `internal/comments` |
| 登录、注册、cookie | `internal/auth`、`internal/jwtx` |
| 后台的某个按钮 | `internal/admin`（路由见 §4 `/api/admin` 各行） |
| 加一个后台任务 | §6 开头的三步 |
| 某个任务的频率和并发 | `internal/queue/registry_default.go` |
| 某个任务的逻辑 | §6.2 表里的 worker 所在文件 |
| AniList 的 GraphQL 查询 | `internal/anilist/queries.go`、`types.go` |
| Bangumi 匹配 | `internal/bangumi/match.go`、`internal/titlematch` |
| dandanplay 匹配 | `internal/dandanplay/match.go`、`seasonmatch.go` |
| BT 种子源 | `internal/torrents/registry.go` 和各源文件 |
| 繁中 | `internal/hant`；运行入口有 `cmd/hantbackfill` 和 `hant_backfill` 任务 |
| 加一列 | 新迁移放 `migrations/`，改 `internal/db/queries/*.sql`，然后 `make sqlc-generate`，再搜 §7 的手写 SQL 位置 |
| 加一个路由 | `cmd/server/main.go` 对应的 `r.Route` 块，handler 写在 §3.3 对应包里 |
| 中间件 | `internal/httpmw`，顺序在 `cmd/server/main.go`（§5） |
| 统一错误码和响应格式 | `internal/httpx` |
| 限流 | 全局看 `internal/httpmw/api_ratelimit.go`，登录类看 `internal/auth/ratelimit.go`，社区写入看 `internal/community/limits.go` |

---

## 13. 已知的遗留和过期内容

这些内容写这份文档时发现，本次没有改动，记在这里免得误导人：

- **`README.md` 过期。** 状态还停在 "P2.0"；它的 Layout 一节已换成指向本文的链接，但 Quick Start、Test commands 两节仍引用不存在的 `cmd/migrate-mongo` 和 `cmd/parity-check`。
- **`Makefile` 过期。** `migrate-mongo-dryrun`、`migrate-mongo-commit`、`parity-check` 三个目标指向同样不存在的命令。
- **`internal/migrate` 和 `internal/migrate/transforms` 没有入口。** 它们是 P1 一次性 Mongo 迁移的遗留，只有 `test/integration/migrate_test.go` 还在用。
- **四个空占位目录**：`internal/routes`、`internal/services`、`cmd/migrate`、`cmd/seed`（§3.9）。
- **两个遗留 `.gitkeep`**：`internal/db/queries/.gitkeep`、`internal/db/gen/.gitkeep`，所在目录早已不空。
- **`internal/dandanplay` 一包两用**：既是上游客户端又是 HTTP handler，跟其他上游客户端的分法不一致。
- **`internal/anime` 和 `internal/queue` 是最大的两个包**，`internal/db/queries/anime_cache.sql` 是查询最多的 SQL 文件（§7）。拆分是后续步骤，不在本次范围。
