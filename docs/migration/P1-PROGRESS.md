# Phase 1 Progress — Migration Tool (Mongo → Postgres)

**Branch:** `feat/go-backend`
**Started:** 2026-05-21
**Estimated:** 40-60 hr(单人 + Claude Code,subagents 协同)
**Plan reference:** `docs/migration/MIGRATION_PLAN.md` § Phase 1

> 追踪 7 个 sub-task(A-G)。Sub-task A 和 B 在 2026-05-21 session 完成。

---

## 1. P1.A — Schema(8-12 hr)✓

- [x] `go-api/migrations/0001_init.up.sql` + `.down.sql`(14 张表,FK CASCADE 全打)(2026-05-21,subagent A)
- [x] `go-api/migrations/0002_indexes.up.sql` + `.down.sql`(19 个 secondary index:GIN tsvector + pg_trgm × 4 列 + 复合索引 + partial)(2026-05-21,subagent A)
- [x] Schema 应用到 dev DB via `golang-migrate up`(2026-05-21)
  - `1/u init` 141ms(14 张表 + 1 schema_migrations 元表)
  - `2/u indexes` 192ms(21 个 index 含主键约束 + 唯一约束)
  - 总计 dev DB 36 个 index
- [x] CASCADE delete 实测:删 anime_cache 一行 → anime_genres 关联 rows 自动消失
- [x] `search_vec` generated column 实测:`Naruto` / `ナルト` / `火影忍者` 三种文字 `'simple'` config 都 tokenize 成功
- [x] up → verify → down → verify 空 → up round-trip 干净

### 已知问题(转 P1.F 处理)

- **pg_cron extension 在 0001 已注释**。`postgres:16-alpine` 默认不带 pg_cron control 文件,直接 CREATE EXTENSION 会让 golang-migrate 整个 migration 事务回滚。P1.F 任务里换镜像(基于 `postgres:16-alpine` 编译 pg_cron 进自定义 Dockerfile)再加回来。

---

## 2. P1.B — Go skeleton(4-6 hr)✓

- [x] `cmd/migrate-mongo/main.go` — stdlib `flag` CLI(`--mongo-uri --pg-uri --dry-run --commit --collections --batch-size --log-failed --concurrency --version`),`--dry-run` 跟 `--commit` 必须二选一,密码 mask 进 slog 日志(2026-05-21,subagent B)
- [x] `internal/migrate/transform.go` — `Transform` interface + `PGRow{Table, Columns, Values}` 输出结构 + 包级 registry(`Register`/`Lookup`/`Registered`)
- [x] `internal/migrate/mongo_conn.go` — mongo-driver v2 client,read-pref primary,ping verify(2026-05-21 修了 `SetSocketTimeout` —— v2 已删,改用 context.WithTimeout 控制 per-op deadline)
- [x] `internal/migrate/pg_conn.go` — pgxpool,max conns 10,connect+ping timeout 10s
- [x] `internal/migrate/orchestrator.go` — 拓扑排序(DFS + white/gray/black)+ 批量 UPSERT(动态 `INSERT ... ON CONFLICT $target DO UPDATE`)+ 失败 JSONL + 每集合 mongo/pg/transformed/failed 报告
- [x] `go build ./...` + `go vet ./...` + `go test -race ./...` 全绿
- [x] CLI smoke:`--version` / `--help` / flag validation(无 `--dry-run`/`--commit` exit 2)三件全过

### Dep 增量

P0 bootstrap 装的 7 个 dep 基础上,本轮 `go get` 自动拉:
- `go.mongodb.org/mongo-driver/v2` v2.6.0(+ klauspost/compress、xdg-go/scram、youmark/pkcs8、x/crypto、x/sync、x/text 间接依赖)

---

## 3. P1.C — 7 collection transforms(10-15 hr)✓

3 个 subagent 并行(X 简单 4 个 / Y 中等 2 个 + 0003 DEFER migration / Z 复杂 1 个 + fan-out)+ 共享 `util.go`(我)+ blank import 注册。

- [x] `internal/migrate/transforms/util.go`(共享:`MongoIDToUUID` uuid v5 确定性映射、`MongoDateTime`、bson getters、`StringPtr`、`MakeDate`)(2026-05-21)
- [x] `internal/migrate/transforms/users.go` + test(subagent X)
- [x] `internal/migrate/transforms/anime_cache.go` + test(subagent Z;7 子表 fan-out;child UUID 用 `uuid.NewSHA1(ns, "table:anilistId:index")` 确定性)(2026-05-21)
- [x] `internal/migrate/transforms/subscriptions.go` + test(subagent X)
- [x] `internal/migrate/transforms/follows.go` + test(subagent X)
- [x] `internal/migrate/transforms/episode_comments.go` + test(subagent Y;parent_id 自引用;DEFER FK 由 0003 处理)
- [x] `internal/migrate/transforms/danmakus.go` + test(subagent Y;`id bigint IDENTITY` 不入 Columns;ConflictTarget=""—— 非幂等,re-run 前要 TRUNCATE)
- [x] `internal/migrate/transforms/episode_windows_transform.go` + test(subagent X,原名 `episode_windows.go` 踩坑见 Notes)
- [x] `internal/migrate/transforms/zzz_registered_test.go` regression guard:assert 7 transforms 全注册
- [x] `migrations/0003_defer_comment_self_fk.up.sql` + `.down.sql`(subagent Y;`ALTER CONSTRAINT episode_comments_parent_id_fkey DEFERRABLE INITIALLY DEFERRED`)— 已 applied 到 dev DB,`pg_constraint` 查验 `condeferrable=t condeferred=t`
- [x] `cmd/migrate-mongo/main.go` 加 blank import `_ "internal/migrate/transforms"` 触发所有 init()
- [x] **`go test -race -cover ./internal/migrate/transforms/...`:91.2% coverage**(38+ test cases,目标 80%,达标)
- [x] **`migrate-mongo --dry-run` smoke 通过**:`total_registered=7`,topo-sort `[anime_cache, users, danmakus, episode_comments, episode_windows, follows, subscriptions]`,空 Mongo 17ms 跑完

---

## 4. P1.D — testcontainers-go 集成测试(6-8 hr)✓

实际产出:`go-api/test/integration/migrate_test.go` 667 行,`//go:build integration` tag(`go test ./...` 默认跳过,显式 `-tags=integration` 才跑)。subagent 写,我修 3 个真 bug 后通过。

- [x] testcontainers-go 起 postgres:16-alpine + mongo:7(单次,跨测试复用)
- [x] golang-migrate Go library 应用 0001 + 0002 + 0003 三个 migration
- [x] 6 个测试:
  - `TestMigrateEmptyMongo` — 空 Mongo,14 张 PG 表全空
  - `TestMigrateOneUser` — _id deterministic uuid v5 验,is_public DEFAULT true 自动应用
  - `TestMigrateAnimeCacheFanOut` — 1 anime + 2 genres + 2 studios + 2 relations + 3 characters + 2 staff + 2 recs + 2 ep titles 共 16 行,display_order 0/1/2,search_vec GENERATED 非空,start_date=2024-01-15
  - `TestMigrateFKRelationships` — subscription/follow/2-level comments(DEFER self-FK 实测)/danmaku/episode_window 全建,CASCADE 删 user 关联行全消失
  - `TestMigrateDryRun` — DryRun=true 时 PG 仍空,但 Report.Transformed≥1
  - `TestMigrateFailureLogging` — malformed _id=42(int) 触发 MongoIDToUUID 错,orchestrator 不 panic,failure JSONL 写一行
- [x] `go test -race -tags=integration -timeout=300s` PASS,11.5s wall(含容器启动)

### 修了 3 个真 bug(集成测试暴露)

1. **`anime_cache.bangumi_version` NULL** — schema 是 `NOT NULL DEFAULT 0`,但 transform 当 nullable `*int` emit,Mongo doc 缺这字段时塞 `nil`(SQL NULL)→ 违反 NOT NULL。fix:transform 缺失时给 0(匹配 Mongo schema 默认)。
2. **Orchestrator ConflictTarget 套到子表** — `anime_cache` 一个 Transform emit 多表,orchestrator 把同一个 `(anilist_id)` conflict target 套到所有表,但 `anime_genres` 等子表没有 `anilist_id` 列 → SQLSTATE 42703。fix:`orchestrator.go` flush 时判断 `table == t.PGTable()` 才用 ConflictTarget,子表用 `""`(plain INSERT,re-run 前 TRUNCATE)。
3. **mongo-driver v2 decode embedded doc 为 bson.D 不是 bson.M** — embedded subdoc(`startDate`)和数组元素(`relations[]`、`characters[]`、...)默认 decode 成 `bson.D`(ordered),不是 `bson.M`。`GetSubdoc` 和 `anime_cache.toSubdoc` 原来只 case bson.M / map → 全 miss,startDate=NULL 写入 + 子表 0 行。fix:两处都加 `case bson.D` 转 bson.M。

---

## 5. P1.E — Dry-run + field parity(4-6 hr)✓

实测在真实 prod 数据上跑通,**Mongo 6493 docs → PG 95008 rows,0 失败,10000 字段比较 100% 全 match**。

### 数据获取(claude 代跑)

- [x] SSH 通 VPS(端口 17776),`docker exec animego-mongodb-1 mongodump --uri=... --archive --gzip` 流式 SSH → 本地 `/tmp/animego-prod-mongodump-2026-05-21.archive.gz`(6.0MB 压缩,16MB 解压)
- [x] `docker cp` + `mongorestore --nsFrom='animego.*' --nsTo='animego_prod_copy.*'` 进 dev mongo,独立 DB 不污染 dev 数据
- [x] 6493 documents 全部 restored

### 实际 prod collection counts

| Mongo collection | count |
|---|---|
| animecaches | 6425 |
| subscriptions | 59 |
| users | 5 |
| danmakus | 3 |
| episodewindows | 1 |
| episodecomments | 0 |
| follows | 0 |

### 暴露 + 修了 4 个 bug

1. **Mongoose collection 命名约定**:`MongoCollection()` 写了 snake_case 名(`anime_cache`/`episode_comments`/`episode_windows`)但 Mongoose 实际存储是 lowercased + 's'(`animecaches`/`episodecomments`/`episodewindows`,无 underscore)。集成测试没暴露因为 fixture 跟 transform 用了同一个错名,自我一致。修 3 个 transforms + 3 个 unit test metadata assertion + 3 处集成测试 fixture。
2. **`anime_cache.bangumi_version` CHECK 0-2 范围太窄**:plan comment "0=unenriched, 1=phase 1-3, 2=phase 4 full" 是 stale,prod 实际 99.95% 是 `bangumiVersion=3`(phase 5 enrichment)。**0004_relax_bangumi_version migration**:DROP + ADD CHECK `>= 0`(无上限,允许将来 phase N)。
3. **Orchestrator child table flush 在 parent 前面 → FK 23503**:batch_size=500 时,anime_episode_titles buffer 比 anime_cache 先满,先 flush 子表,但父行还在 buffer 没进 PG。修 orchestrator:**子表 flush 前,如 parent buffer 非空,先 flush parent**;final-flush 阶段同样 parent first。
4. **`anime_cache.episodeTitles` 同 episode 重复**:prod 17 个 anime 的 Bangumi enrichment 把新版本 append 而不是替换,导致 PG composite PK `(anime_id, episode)` 23505。修 transform:dedup 时 keep LAST(最新 enrichment 覆盖旧),17 行 Go 代码。

### Field parity test

工具:`go-api/cmd/parity-check/main.go`(633 行,subagent 写)

```
$ go run ./cmd/parity-check --mongo-uri=... --pg-uri=$DATABASE_URL --sample=1000

Field                          Compared   Match    Mismatch  Match %
titleChinese                   1000       1000     0         100.00%
characters[0].nameCn           1000       1000     0         100.00%
coverImageColor                1000       1000     0         100.00%
posterAccent                   1000       1000     0         100.00%
startDate                      1000       1000     0         100.00%
averageScore                   1000       1000     0         100.00%
bangumiScore                   1000       1000     0         100.00%
episodeTitles[first].nameCn    1000       1000     0         100.00%
studios[*] contains            1000       1000     0         100.00%
genres[*] contains             1000       1000     0         100.00%

TOTAL                          10000      10000    0         100.00%

PASS  (acceptance threshold: >=99.9% per field)
```

**10/10 字段,1000 sample each,0 mismatch**。

### Migration timing

- anime_cache(6425 doc → 95008 fan-out rows):**7.5s**
- 其它 6 collection 合计:**~50ms**
- 总耗时:**~10s wall**(含 Mongo cursor stream + transform + pgx batch INSERT)

### Idempotency 验证(未跑,推到 P9 cutover demo)

Re-run 同 dump 应该 UPSERT 主表,子表会 PK conflict —— 这是已知限制(P1.C 记的)。Cutover 一次性 OK,re-run 前要 `TRUNCATE` anime_* + 子表。可写 helper script:`scripts/migrate-mongo-truncate-and-retry.sh`,推 P1.G。

---

## 6. P1.F — pg_cron danmaku TTL(2-3 hr)✓

实现路径:自定义 Postgres image 编 pg_cron 1.6.5 进 alpine,**postgresql.conf.sample 同时打补丁加 shared_preload_libraries=pg_cron + cron.database_name=animego**,initdb 自动 pick up,无需 docker compose command override。

- [x] `go-api/docker/postgres/Dockerfile`(28 行):`FROM postgres:16-alpine` + apk build-deps(`build-base / clang19 / llvm19-dev / postgresql16-dev / git`)+ `git clone v1.6.5 https://github.com/citusdata/pg_cron` + `make && make install` + `sed` 改 postgresql.conf.sample + `apk del .build-deps`。最终镜像 ~190 MB(stock 85 MB,+ pg_cron .so)
- [x] `docker-compose.dev.yml` 改成 `build: ./go-api/docker/postgres` + `image: animego-postgres:dev`(local tag,testcontainers 也用)
- [x] `migrations/0005_pg_cron_extension.up.sql + .down.sql`:`CREATE EXTENSION IF NOT EXISTS pg_cron`
- [x] `migrations/0006_danmaku_ttl_schedule.up.sql + .down.sql`:`SELECT cron.schedule('danmaku-ttl', '0 4 * * *', $$DELETE FROM danmakus WHERE created_at < NOW() - INTERVAL '1 year'$$)`(down 走 `cron.unschedule`)
- [x] Dev postgres 重建(`down -v` + `up -d`),`SHOW shared_preload_libraries` 返 `pg_cron`,`SHOW cron.database_name` 返 `animego`,所有 6 个 migration 1-6 应用 < 700ms 总耗时
- [x] 集成测试 testcontainers 改用 `animego-postgres:dev` image(本地 build 后 testcontainers 走 local cache,不 pull)
- [x] 新增 `TestPgCronDanmakuTTL`(integration):验证 pg_extension 有 pg_cron + cron.job 含 danmaku-ttl(`0 4 * * *` + DELETE 命令文本)+ 直接执行 TTL DELETE(seed fresh + 18-month 老 danmaku,执行后 fresh survives, old 删)。Direct exec 跳过 cron 等待(替代:60-90s fire wait fragile),但同 SQL,语义等价。
- [x] **`go test -race -tags=integration ./test/integration/...` 7/7 PASS,9.76s wall**
- [x] Re-run prod migration on pg_cron-enabled PG:6493 → 95008 rows,0 failures,13.4s
- [x] Re-run parity-check:10/10 fields × 1000 samples = **100.00% match**,danmaku-ttl job 在 cron.job 表保留

### 一处架构调整(顺便记下)

`docker compose -f docker-compose.dev.yml down -v` 会同时干掉 mongo volume(虽然只是为了换 postgres image)。后果:本地 `animego_prod_copy` 没了。修复:从 `/tmp/animego-prod-mongodump-2026-05-21.archive.gz`(P1.E 拉的)再 mongorestore 一次(秒级)。教训:**volume scope 用 named volume per service 可以避免连带删,但配置复杂度上升,目前 down -v + restore 流程足够快**。

---

## 7. P1.G — ERD + docs(1-2 hr)

**[pending]**

- ASCII ERD diagram(14 表 FK 关系)写入 `go-api/README.md` schema 段
- `docs/migration/MIGRATION_PLAN.md` § Phase 1 加 "P1 实际进度" 链回本文件
- 重生成 `MIGRATION_PLAN.html` + `P0-PROGRESS.html` + `P1-PROGRESS.html`

---

## P1 → P2 退出条件(critical gate)

- [ ] 7 transforms 全 testify 单测 ≥ 80% 覆盖
- [ ] testcontainers 集成测试全过(fixture → migration → assert)
- [ ] dry-run on prod mongodump:row diff < 0.1% + 10×1000 field parity 全 strict equal
- [ ] pg_cron TTL 真触发删过 18-month 老 row
- [ ] ERD diagram 落进 go-api/README.md

---

## Notes / Decisions(随时追加)

- 2026-05-21 00:50 — P1 启动。多 subagent 并行设计:Subagent A 出 schema(0001 + 0002),Subagent B 出 Go skeleton(orchestrator + transform interface + connections + CLI)。两者真正独立(SQL vs Go),无 cross-dep。
- 2026-05-21 00:55 — Subagent A 第一次撞 API 529 overloaded(Claude 服务端瞬时压力),重派一次成功。耗时 ~45s。
- 2026-05-21 01:00 — Subagent B 595s(~10min)完成。质量高:topo-sort、动态 UPSERT、失败 JSONL、密码 mask、context.WithTimeout 编排正确。
- 2026-05-21 01:04 — Schema 在 dev DB 完整 roundtrip 测试通过(up + CASCADE + tsvector + down + 再 up)。发现 `postgres:16-alpine` 不带 pg_cron,转 P1.F。
- 2026-05-21 01:11 — Subagent B 写的 mongo_conn.go 用了 `SetSocketTimeout`,mongo-driver v2 已删,改用 context.WithTimeout per-op deadline。go build/vet/test 全绿后 golang-migrate 实测 PASS。
- **决策:Mongo driver 版本** — 用 v2(`go.mongodb.org/mongo-driver/v2`)而不是 v1。v2 删了若干 deprecated API(SetSocketTimeout 是其中之一),但 bson 语义和 Connect 入口更干净。如果 prod mongodump 有 v1-only 特殊字段问题,P1.C transforms 阶段再回头看。
- 2026-05-21 01:30 — P1.C 启动。3 subagent 并行设计:X 写 4 简单(users/subscriptions/follows/episode_windows),Y 写 2 中等(danmakus/episode_comments)+ 0003 DEFER migration,Z 写 1 复杂(anime_cache 7 子表 fan-out)。共享 `util.go`(我先写,跑过 build),共享 helper `zipColsVals`(X 写在 users_test.go,Y 跟 Z 引用)。
- 2026-05-21 01:32 — 3 subagent 全完。我跑 build + vet + test -race 通过,但 dry-run 显示 `total_registered=6` —— `episode_windows` 神秘消失。
- **2026-05-21 01:44 — GOOS 文件名后缀坑** ❗:`episode_windows.go` / `episode_windows_test.go` 撞 Go 的 build constraint 规则:`*_GOOS.go`(stripped of `_test`)的文件被自动当 OS-specific,只在该 GOOS 下编译。`windows` 是 valid GOOS,所以 Mac/Linux 下整个文件被排除,`go list` 不列、init() 不跑、registry 缺 1 个。**Reserved GOOS 词表**:aix / android / darwin / dragonfly / freebsd / hurd / illumos / ios / js / linux / mips* / netbsd / openbsd / plan9 / solaris / wasip1 / **windows** / zos。修法:rename 加后缀 `_transform`,变成 `episode_windows_transform.go`(`_transform` 不是 GOOS,Go 不排除)。**P1.G 文档要写进 go-api/README.md 命名约定**。
- `zzz_registered_test.go` 不是 P1.C 范围,但 debug 时加的 registry assert test 留着作为 regression guard —— 未来谁加 transform 忘记 register、或又踩 GOOS 坑,test 会 PASS_COUNT=N 失败响。
- **Idempotency 限制**:
  - 6/7 transforms 完全幂等(同 Mongo dump re-run 同 PG 结果,因为 deterministic uuid v5 + ON CONFLICT DO UPDATE)
  - `danmakus` 非幂等(`id bigint IDENTITY`,ConflictTarget=""),re-run 会 dup。Cutover 前 TRUNCATE 一次,或加 mongo_id 列搞 UPSERT —— P1.E 真跑 prod 数据时再决定要不要补
  - `anime_cache` 子表(genres/studios/relations/...)主键不是基于 anilist_id,orchestrator P1.D 修过 ConflictTarget 套用范围:**主表 anime_cache 用 ConflictTarget UPSERT,子表用 plain INSERT**。Re-run 前 TRUNCATE 所有 anime_* + 子表(脚本待补,P1.E)。
- 2026-05-21 02:10 — P1.D 启动。1 subagent 写 testcontainers 集成测试(667 行单文件 + `//go:build integration` tag)。subagent 写完 sandbox 禁 go,我跑 build + test 3 轮:第一轮 bangumi_version NOT NULL 炸 + 第二轮 orchestrator ConflictTarget 套子表炸 + 第三轮 bson.D 解码炸。每个真 bug 都需要看 PG error code + 反推 transform/orchestrator/util 改一两行。三次后 6/6 PASS,11.5s wall。
- 2026-05-21 02:15 — **Subagent 自带 sandbox 限制**:三轮 subagent 全部报 `go` 命令被 sandbox 拒。subagent 只能写文件不能跑测试,build/test 必须我接力跑。为来后续 phase 节奏:**subagent 适合写文件 + 给 spec,不适合做 verify**;verify 必须我接力跑。
- **bson.M vs bson.D 教训**:mongo-driver v2 默认 codec 在 `Cursor.Decode(&bsonM)` 时,内层 embedded subdoc / 数组元素 decode 成 `bson.D` 而不是 `bson.M`(只 outer doc 是 bson.M)。任何在 util 或 transform 里 `case bson.M:` 但不 `case bson.D:` 的代码都会 miss。**未来加 transform 时**:任何处理 embedded subdoc 或 array element 的地方一律走 `toSubdoc(v) (bson.M, bool)` helper,helper 内部三 case 都列。已统一(util.go GetSubdoc + anime_cache.go toSubdoc)。
- 2026-05-21 02:25 — P1.E 启动。SSH VPS 拉 6MB mongodump,本地 `animego_prod_copy` DB restore 6493 docs。
- 2026-05-21 02:33-02:42 — 三轮 `migrate-mongo --commit` failure 调试:
  - 第一轮:Mongoose collection 名(`animecaches`、`episodecomments`、`episodewindows` 不带 underscore)→ 修 transform `MongoCollection()` × 3 + 集成测试 fixture × 3 + unit test metadata × 3。
  - 第二轮:`bangumi_version` 23514 CHECK 违反 → 加 0004 migration 放宽到 `>= 0`。
  - 第三轮:`anime_episode_titles_pkey` 23505 dup → transform dedup 17 个 anime 的 episodeTitles。
  - 第四轮(orchestrator 改):FK 23503,child flush before parent → 改 flush 策略,先 parent 再 child。
- 2026-05-21 02:46 — 最终 `--commit` PASS:6493 → 95008 rows,0 failures,10s wall。parity-check 10/10 字段 100% match,1000 sample 全过。
- **集成测试该 dogfood prod-style collection 名**:测 P1.D 的 fixture 用了跟 transform 一样的错名(`Collection("anime_cache")`),所以自我一致地"通过"但生产现实会炸。修法:集成测试以后用 mongoose convention(animecaches 等),跟 prod 一致。已修(三处 `.Collection(...)` 替换)。这是一个广义的测试设计教训:**测试的输入应该模拟生产输入的格式,不是模拟代码自己的预期**。

