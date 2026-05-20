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
| Go 1.23+ | [ ] | go-api 整个 backend |
| sqlc | [ ] | SQL → Go 类型安全 codegen |
| Air | [ ] | Go hot reload,dev.sh `air -c .air.toml` |
| rclone | [ ] | nightly pg_dump → Cloudflare R2 |
| golang-migrate | [ ] | DB schema migration runner |
| Bun 1.3.14 | [ ] | 本地 1.3.11,需 `curl -fsSL https://bun.sh/install \| bash` 升一下(可推到 P3 启动前) |

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

- [ ] `mkdir -p go-api/{cmd/server,cmd/migrate,cmd/seed,cmd/migrate-mongo}`
- [ ] `mkdir -p go-api/internal/{config,db/queries,db/gen,middleware,routes,services}`
- [ ] `mkdir -p go-api/migrations`
- [ ] `mkdir -p ws-server`(P2.8 占位)
- [ ] `mkdir -p scripts`(已存在,加 dev.sh / measure-tthw.sh / backup-pg.sh)
- [ ] 创建 `go-api/.air.toml`(P0 dev.sh 依赖)
- [ ] 创建 `go-api/sqlc.yaml`

---

## 3. Go module + 5 个 deps

- [ ] `cd go-api && go mod init github.com/lawrenceli0228/animego/go-api`
- [ ] `go get github.com/go-chi/chi/v5`
- [ ] `go get github.com/jackc/pgx/v5`
- [ ] `go get github.com/sqlc-dev/sqlc/cmd/sqlc`
- [ ] `go get github.com/golang-jwt/jwt/v5`
- [ ] `go get github.com/riverqueue/river`
- [ ] `go mod tidy` 干净通过

---

## 4. Go HTTP server skeleton

- [ ] `go-api/cmd/server/main.go`:chi router + `:8080/health` → `200 {"ok":true}`
- [ ] `go-api/internal/config/config.go`:env 加载(DATABASE_URL, JWT_SECRET, PORT)
- [ ] `go-api/internal/middleware/recoverer.go`:panic → 500 with request id
- [ ] `go test ./go-api/...` 跑通(空套件 pass 即可)

---

## 5. Docker compose(dev)

- [ ] 创建 `docker-compose.dev.yml`(跟 prod compose 分开)
- [ ] Postgres service:`postgres:16-alpine`,user `animego`,db `animego`,volume `postgres-data`
- [ ] Postgres healthcheck:`pg_isready -U animego`
- [ ] Mongo service(过渡保留,cutover 后 30 天清):`mongo:7`,volume 沿用现有 mongo-data
- [ ] 验证:`docker compose -f docker-compose.dev.yml up -d postgres mongo` + `docker compose -f docker-compose.dev.yml ps` 都 healthy

---

## 6. scripts/dev.sh(Appendix C 完整 spec)

- [ ] 创建 `scripts/dev.sh`(参考 `docs/migration/MIGRATION_PLAN.md` Appendix C)
- [ ] `chmod +x scripts/dev.sh`
- [ ] 创建 `scripts/measure-tthw.sh`(C2 修正,marker 文件计时)
- [ ] 创建 `scripts/backup-pg.sh`(nightly pg_dump → R2)
- [ ] 更新 `scripts/setup.sh`:加 brew install go/sqlc/rclone/golang-migrate + `go install air@latest`(A3 修)
- [ ] 验证 `bash scripts/dev.sh` 起得来(Go 服务 :8080/health 必须 200,其它 endpoint 现在还没,所以 dev.sh 完整跑不通,但 Go 部分要工作)

---

## 7. R2 + crontab nightly backup

- [ ] `scripts/backup-pg.sh` 写完(`docker compose exec postgres pg_dump ... | gzip | rclone rcat r2:animego-backup/pg-$(date +%F).sql.gz`)
- [ ] 本地手跑一次,确认 R2 里有文件
- [ ] R2 web UI 下载这个文件 → 解压 → 喂回 staging Postgres `psql` → SELECT 几行,数据完整
- [ ] VPS 上 crontab 加 `0 3 * * *` nightly backup
- [ ] VPS 上 crontab 加 `0 4 * * *` `rclone delete --min-age 30d r2:animego-backup/` retention cleanup
- [ ] 模拟 31 天老文件:`touch -d "31 days ago" /tmp/old.sql.gz && rclone copy /tmp/old.sql.gz r2:animego-backup/ && rclone delete --min-age 30d r2:animego-backup/` → 确认真删

---

## 8. .env 文件(eng review A1 + DX review 同步)

- [ ] `.env.example` 重写:加 `DATABASE_URL=postgres://animego:dev@localhost:5432/animego`、`JWT_SECRET=`、`RIVER_QUEUE_URL=`、`PORT_GO=8080`、`PORT_WS=3001`、`DANDANPLAY_APP_ID=`、`DANDANPLAY_APP_SECRET=`、保留 `MONGODB_URI=`(cutover 后删)
- [ ] `.env.production.example` mirror 同上,prod 值占位
- [ ] `.gitignore` 确认 `.env` `.env.production` 已在(目前应该有,double-check)

---

## 9. README 顶部 "Active rewrite" banner(DX review 推迟到 P3 收口,但 P0 完成时可以加个轻量提示)

- [ ] README.md 第一段后加一行:
  > ⚠️ **Active rewrite in progress**(Go + PostgreSQL + Next.js 16),详见 [`docs/migration/MIGRATION_PLAN.md`](docs/migration/MIGRATION_PLAN.md)。当前 main 仍跑 v2.0.x stable,`feat/go-backend` 分支是重写工作流。

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
