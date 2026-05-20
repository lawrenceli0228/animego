# Phase 0 Progress — Go 骨架 + Postgres + R2 backup + scripts/dev.sh

**Branch:** `feat/go-backend`
**Started:** 2026-05-20
**Estimated:** 20-35 hr(单人 + Claude Code)
**Plan reference:** `docs/migration/MIGRATION_PLAN.md` § Phase 0 + Appendix C(dev.sh)+ §6(起步动作)

> 本文件用作 P0 执行追踪。每完成一项打勾,把日期 + commit hash 写在右边。
> 全部打勾 + P0 → P1 gate 通过(R2 backup → pg restore 演练 + scripts/dev.sh 一键起)后,关闭并合 main 进 P1。

---

## 0. 本地工具链(prerequisites)

**这一节要先你自己 terminal 跑,我装不了**(brew install 需要你机器密码)。

```bash
# 装 Go + sqlc + rclone + golang-migrate (Homebrew)
brew install go sqlc rclone golang-migrate

# 装 Air (Go hot reload) —— 需 Go 已在 PATH
go install github.com/cosmtrek/air@latest

# 装 Goose 或 sqlc-gen-go(按 plan 决策走 sqlc + golang-migrate;Goose 不需要)

# 验证版本
go version           # 需 1.23+
sqlc version
air -v
rclone version
migrate -version
```

| Tool | 状态 | 用途 |
|------|------|------|
| Go 1.23+ | [x] **1.26.3** 装好(2026-05-20) | go-api 整个 backend |
| sqlc | [x] **v1.31.1** 装好(2026-05-20) | SQL → Go 类型安全 codegen |
| Air | [x] **v1.65.2** 装好(2026-05-20,via `github.com/air-verse/air`) | Go hot reload,dev.sh `air -c .air.toml` |
| rclone | [x] **v1.74.1** 装好(2026-05-20) | nightly pg_dump → Cloudflare R2 |
| golang-migrate | [x] **v4.19.1** 装好(2026-05-20) | DB schema migration runner |
| jq | [x] 已有 | restore-pg-drill.sh 解析 rclone lsjson |
| Bun 1.3.14 | [ ] 本地 1.3.11,需 `bun upgrade`(可推到 P3 启动前) | Next.js + ws-server runtime |

---

## 1. Cloudflare R2 账号 + bucket(用户手动)

- [ ] 注册 / 登录 Cloudflare 账号
- [ ] R2 → Create bucket `animego-backup`(region: APAC 推荐)
- [ ] R2 → Manage API tokens → 生成 `Object Read & Write` token,scope 限定到 `animego-backup`
- [ ] 把 access_key_id + secret_access_key 记在密码管理器,**别 commit**
- [ ] `rclone config` 跑一遍,新建 remote `r2`(provider = Cloudflare R2,endpoint = `https://<account>.r2.cloudflarestorage.com`)
- [ ] 测一行:`rclone lsd r2:animego-backup` 不报错

---

## 2. 目录骨架(claude 代做)

- [x] `mkdir -p go-api/{cmd/server,cmd/migrate,cmd/seed,cmd/migrate-mongo}` (2026-05-20)
- [x] `mkdir -p go-api/internal/{config,db/queries,db/gen,middleware,routes,services}` (2026-05-20)
- [x] `mkdir -p go-api/migrations` + .gitkeep (2026-05-20)
- [x] `mkdir -p ws-server`(P2.8 占位)+ .gitkeep (2026-05-20)
- [x] `mkdir -p scripts`(已存在,加 dev.sh / measure-tthw.sh / backup-pg.sh / restore-pg-drill.sh / p0-bootstrap.sh)(2026-05-20)
- [x] 创建 `go-api/.air.toml`(P0 dev.sh 依赖)(2026-05-20)
- [x] 创建 `go-api/sqlc.yaml`(2026-05-20)

---

## 3. Go module + deps(user 跑 bootstrap)

> Plan §6 原文 `go get github.com/sqlc-dev/sqlc/cmd/sqlc` 是错的 —— sqlc 是 CLI 工具,brew 装,不是 Go runtime 依赖。bootstrap 已修正。

- [x] `bash scripts/p0-bootstrap.sh` 跑过(2026-05-20):go mod init + 8 deps + go mod tidy + go test 全绿
  - deps 实际装到:chi/v5 v5.2.5、pgx/v5 v5.9.2、pgxpool、jwt/v5 v5.3.1、river v0.37.1、riverpgxv5 v0.37.1、google/uuid v1.6.0
- [x] `go mod tidy` 干净(bootstrap 末尾自动跑)

---

## 4. Go HTTP server skeleton

- [x] `go-api/cmd/server/main.go`:chi router + `:8080/health` → `200 {"ok":true,"service":"go-api","stage":"P0"}` + slog JSON + graceful shutdown(2026-05-20)
- [x] `go-api/internal/config/config.go`:env 加载(PORT_GO, DATABASE_URL, JWT_SECRET, CLIENT_ORIGIN);P0 容忍 JWT_SECRET 缺(2026-05-20)
- [x] `go-api/internal/middleware/recoverer.go`:用 chi/middleware.Recoverer 内置,不另起文件;RequestID + RealIP + Timeout 已 wire(2026-05-20)
- [x] `go test ./go-api/...` 跑通(2026-05-20,bootstrap 末尾;cmd/server + internal/config 空套件 pass)

---

## 5. Docker compose(dev)

- [x] 创建 `docker-compose.dev.yml`(跟 prod compose 分开,container_name 带 `-dev` 后缀防冲突)(2026-05-20)
- [x] Postgres service:`postgres:16-alpine`,user `animego`,db `animego`,volume `postgres-dev-data`(2026-05-20)
- [x] Postgres healthcheck:`pg_isready -U animego`,间隔 5s 重试 10 次(2026-05-20)
- [x] Mongo service(过渡保留):`mongo:7`,volume `mongo-dev-data`(2026-05-20)
- [x] 验证:`docker compose -f docker-compose.dev.yml up -d postgres mongo` + ps 都 healthy(2026-05-20)

---

## 6. scripts/

- [x] `scripts/dev.sh`:P0 stage(postgres + mongo + go-api),60s timeout、trap、TTHW marker(2026-05-20)
- [x] `scripts/measure-tthw.sh`:marker 文件计时(eng review C2)(2026-05-20)
- [x] `scripts/backup-pg.sh`:pg_dump | rclone rcat,flock 锁,env=dev/prod(2026-05-20)
- [x] `scripts/restore-pg-drill.sh`:fetch newest from R2,restore 临时 DB,sanity check,cleanup(2026-05-20)
- [x] `scripts/p0-bootstrap.sh`:idempotent go mod init + 7 deps + smoke test(2026-05-20)
- [x] `chmod +x scripts/*.sh`(2026-05-20)
- [ ] **`setup.sh` 不在 P0 改动范围**:setup.sh 是 Debian VPS 用的 apt 脚本,跟 dev mac 的 brew 不同;dev mac 工具链清单在 README.md / go-api/README.md / 本文件 §0;VPS 部分推到 P8 deployment
- [x] 验证 `bash scripts/dev.sh` 起得来:TTHW marker 6 秒出,curl :8080/health 返 `{"ok":true,"service":"go-api","stage":"P0"}` 200 OK(2026-05-20)

---

## 7. R2 + crontab nightly backup

- [x] `scripts/backup-pg.sh` 写完(pg_dump -Fc -Z 6 | rclone rcat,流式不落盘)(2026-05-20)
- [x] `scripts/restore-pg-drill.sh` 写完(P0 → P1 critical gate)(2026-05-20)
- [x] `docs/migration/P0-CRONTAB.md` 写完(VPS crontab + logrotate 参考)(2026-05-20)
- [ ] 本地跑一次 `bash scripts/backup-pg.sh --env=dev`,确认 R2 里有文件 ←需 rclone 配好
- [ ] R2 web UI 看到文件 + `bash scripts/restore-pg-drill.sh` PASS ←**P0 → P1 critical gate**
- [ ] VPS 上 crontab 三行(见 P0-CRONTAB.md):03:00 backup、04:00 30d retention、Sun 05:00 restore drill
- [ ] VPS 上 logrotate 装好(`/etc/logrotate.d/animego`,见 P0-CRONTAB.md)
- [ ] 模拟 31 天老文件 → 触发 retention 真删过(P0 acceptance,详 plan)

---

## 8. .env 文件(eng review A1 + DX review 同步)

- [x] `.env.example` 重写:分 Shared / v2.0.x(Express+Mongo)/ feat/go-backend(Go+PG)/ Next.js 四段,POSTGRES_PASSWORD + DATABASE_URL + PORT_GO + PORT_WS 全加(2026-05-20)
- [x] `.env.production.example` mirror:Go + PG 段先注释,cutover 时启用(2026-05-20)
- [x] `.gitignore` 确认 `.env` `.env.production` 已在(grep 过,都有)(2026-05-20)
- [x] `.env` 本地生成,JWT_SECRET + JWT_REFRESH_SECRET + POSTGRES_PASSWORD 用 openssl rand 填,chmod 600(2026-05-20)

---

## 9. README 顶部 "Active rewrite" banner

- [x] README.md Project Status 段重写:banner + Tech Stack 更新 + 链到 MIGRATION_PLAN.md / .html / P0-PROGRESS.md(2026-05-20)
- [x] `go-api/README.md` 写完(Go 模块 quick reference)(2026-05-20)

---

## 10. Tests + Acceptance(P0 → P1 gate)

- [ ] `go test ./go-api/...` 空套件全绿
- [ ] **R2 backup → restore drill 真跑过**(必须,P0 → P1 critical gate)
- [ ] R2 30-day retention cleanup 真触发过
- [ ] `scripts/dev.sh` 把 postgres + mongo + go-api 三个起来,`:8080/health` 200
- [ ] TTHW 测试:`bash scripts/measure-tthw.sh` 报告 < 5min(M1/M2 Mac warm-cache 基准)
- [ ] **scripts/dev.sh 完整 6 进程跑得起来这个 gate 要到 P3(Next)+ P2.8(ws-server)完成才能验**,P0 阶段只需 go-api 部分工作

---

## 11. Phase 0 退出(close this file 的条件)

- [ ] 上面 10 节全部勾完
- [ ] 至少 1 次成功的 R2 restore drill(写下日期 + R2 文件名)
- [ ] Commit history 在 `feat/go-backend` 分支可查
- [ ] 准备开 P1(migration tool)

---

## Notes / Decisions(随时追加)

- 2026-05-20 18:xx — 开分支,本文件作为 P0 追踪起点。工具链 4 项(go/sqlc/air/rclone/migrate)都未装,优先级最高。
- 2026-05-20 19:xx — claude 代做 §2 / §4 / §5 / §6 / §8 / §9(目录骨架、Go server stub、docker-compose.dev.yml、5 个脚本、.env 双份、README banner)+ `docs/migration/P0-CRONTAB.md`。subagents 协同产出 `.air.toml` + `sqlc.yaml`(google/uuid override + pgx 类型映射)+ `backup-pg.sh` + `restore-pg-drill.sh`(flock 锁 + jq newest pick + cleanup trap)。剩 user 跑:brew 工具链 → rclone R2 config → `bash scripts/p0-bootstrap.sh` → 第一次 backup-pg.sh + restore drill → VPS crontab + logrotate。
- 2026-05-20 22:50 — claude 操作:`brew install go sqlc rclone golang-migrate`(后台 ~5min)+ Docker Desktop 启动 + `docker compose up -d postgres mongo` 拉镜像 + `go install github.com/air-verse/air@latest`(注:`cosmtrek/air` 已迁到 `air-verse/air`,scripts 里 fallback 顺序已对)+ `bash scripts/p0-bootstrap.sh` 一遍过 + `bash scripts/dev.sh` 起来,**TTHW = 6 秒**,curl `:8080/health` → 200 + `{"ok":true,"service":"go-api","stage":"P0"}`。P0 关键链路通过。dev.sh + p0-bootstrap.sh 加了一行 `export PATH="${PATH}:${GOPATH:-$HOME/go}/bin"`,免得 user shell profile 还没 export 时 air 找不到。
- Plan §6 原文写 `go get github.com/sqlc-dev/sqlc/cmd/sqlc` 是错的(sqlc 是 CLI,不是 runtime lib),p0-bootstrap.sh 已修正,本文件 §3 已 flag。
- DX review polish #2(`setup.sh 加 Air 安装`)重新分类:setup.sh 是 VPS Debian apt 脚本,Air 是 dev-only 工具,放进 setup.sh 没意义。dev mac 工具链清单写在 §0 + go-api/README.md。已在 §8 TODO Eng review #2 旁边补一条 clarification。
- **Air repo 迁移**:`github.com/cosmtrek/air` → `github.com/air-verse/air`。p0-bootstrap.sh + 错误消息已优先用 air-verse(cosmtrek fallback)。go-api/README.md 还写 cosmtrek 路径,下一轮顺手改。
