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

## 3. P1.C — 7 collection transforms(10-15 hr)

**[pending]** — 下个 session

每个 transform 一个文件,自注册到 registry 通过 init()。`anime_cache` 是最大的(一个 Mongo doc fan-out 成 1 anime_cache + N genres + M studios + ... 共 7 个子表 rows)。

- [ ] `internal/migrate/transforms/users.go`(_id ObjectId → uuid;timestamps Date → timestamptz)
- [ ] `internal/migrate/transforms/anime_cache.go`(embedded arrays fan-out 7 child tables;`startDate{year,month,day}` → `make_date()`;`is_public` 默认 true)
- [ ] `internal/migrate/transforms/subscriptions.go`(userId ObjectId → uuid FK lookup)
- [ ] `internal/migrate/transforms/follows.go`
- [ ] `internal/migrate/transforms/episode_comments.go`(parentId 自引用 ObjectId → uuid)
- [ ] `internal/migrate/transforms/danmakus.go`(content length 50 check;`liveEndsAt` 必填)
- [ ] `internal/migrate/transforms/episode_windows.go`(无 timestamps)
- [ ] testify 单测每个 transform(ObjectId / Date 时区 / embedded subdoc nil / 边界值)
- [ ] anonymous init() 链 import 到 main.go 让 registry 自动填充

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

