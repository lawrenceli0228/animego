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

## 4. P1.D — testcontainers-go 集成测试(6-8 hr)

**[pending]**

起 mongo + postgres 容器(testcontainers-go),用 fixture 灌 mongo data,跑 migration commit 模式,assert PG rows 等价(行数 + 关键字段值)。

---

## 5. P1.E — Dry-run + field parity(4-6 hr)

**[pending]**

- VPS 拉 prod mongodump → 本地 mongo 容器导入
- `go run ./cmd/migrate-mongo --dry-run --collections all`,row count diff < 0.1%
- 10 个 UI-critical field × 1000 行 random sample,mongo 跟 PG strict equal(null 等价容忍)
  - `titleChinese / characters[0].nameCn / coverImageColor / posterAccent / startDate / averageScore / bangumiScore / episodeTitles[0].nameCn / studios[0] / genres[0]`
- 失败行 JSONL 反查 root cause + fix transform

---

## 6. P1.F — pg_cron danmaku TTL(2-3 hr)

**[pending]** — **先解决 docker image 不带 pg_cron 的问题**

1. 新建 `go-api/docker/postgres/Dockerfile`:`FROM postgres:16-alpine` + `apk add build-base postgresql16-dev` + git clone https://github.com/citusdata/pg_cron + make + make install
2. `docker-compose.dev.yml` 改成 `build: ./go-api/docker/postgres`
3. 新 migration `0003_pg_cron.up.sql`:`CREATE EXTENSION pg_cron;` + `SELECT cron.schedule('danmaku-ttl', '0 4 * * *', $$DELETE FROM danmakus WHERE created_at < NOW() - INTERVAL '1 year'$$);`
4. 18-month 老 danmaku fire test:插入老 row → 触发 cron → SELECT count == 0

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
  - `anime_cache` 子表(genres/studios/relations/...)主键不是基于 anilist_id,orchestrator 当前用同一 ConflictTarget=`(anilist_id)` 套到子表会报 PK 冲突错。子表的 child UUID 是确定性的,但 INSERT 路径无 ON CONFLICT clause 适配。Cutover 一次性 OK,re-run 前 TRUNCATE anime_*。

