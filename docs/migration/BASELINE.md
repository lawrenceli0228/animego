---
title: AnimeGo — BASELINE
toc: true
toc-depth: 3
lang: zh-CN
document-css: false
---

# BASELINE — Phase 8.5 / Phase 10 阈值参照源

**Phase:** Phase 3 sub-milestone 1(P3.0 骨架交付后并行 dispatch subagent A)
**Branch:** `feat/go-backend`
**Status:** SKELETON — 数据待填,见各节"责任人"
**作者:** Claude / Lawrence
**生产域名:** [animegoclub.com](https://animegoclub.com)
**生产 VPS:** 香港 45.152.65.208 SSH 端口 17776,项目目录 `/opt/animego`,docker compose 三容器(`server` / `mongo` / `nginx`)

> **用法**:这份文档是 **Phase 8.5 shadow + Phase 10 canary** 的阈值参照源。所有数字必须在 **P9 cutover 前补齐**,否则 P8.5 shadow 没有对比基准、P10 canary 没有回滚判据。
>
> **数据填写约定**:
>
> - **能自己跑(本地 lighthouse)**:在 owner 列标 `Claude / Lawrence`,数据落原文。
> - **VPS 相关(nginx log / vnstat / docker stats)**:placeholder + 写明 SSH 命令,owner 标 `Lawrence (VPS)`。
> - **GSC / 第三方控制台**:owner 标 `Lawrence (manual)`,跟到对应控制台手填。
>
> **测量窗口**:统一 **7 天滚动**(GSC 28 天默认 + VPS 带宽 30 天月度,见各节)。

---

## 0. 数据状态汇总(填表前先看这张表)

| # | 节 | 指标 | 期望/Placeholder | 来源 | 责任人 | 状态 |
|---|---|---|---|---|---|---|
| 1 | § 1 | v2.0.1 SPA Lighthouse(3 URL) | placeholder | 本地 `npx lighthouse` | Claude / Lawrence | TODO |
| 2 | § 2 | Express 5xx 错误率 7 天 | placeholder | nginx access.log | Lawrence (VPS) | TODO |
| 3 | § 3 | socket.io 断流率 7 天 | placeholder + 加 instrumentation | 应用层 metrics(待加) | Lawrence + Claude | BLOCKED(待加) |
| 4 | § 4 | GSC 索引数 | placeholder | search.google.com/search-console | Lawrence (manual) | TODO |
| 5 | § 5 | Express prod req/s p50/p95/p99 + 日峰值 | placeholder | nginx access.log + awk | Lawrence (VPS) | TODO |
| 6 | § 6 | VPS 出方向带宽 30 天 | placeholder | `vnstat -m` | Lawrence (VPS) | TODO |
| 7 | § 7 | socket.io 同时在线连接数 7 天 max | placeholder + 加 instrumentation | 应用层 metrics(待加) | Lawrence + Claude | BLOCKED(待加) |

**已填:0 / 7**·**待填:7 / 7**·**阻塞(需先加 instrumentation):2 / 7(§ 3、§ 7)**

> **填写顺序建议**:§ 4(GSC,1 分钟)→ § 1(lighthouse,15 分钟)→ § 2/§ 5/§ 6(VPS,30 分钟)→ § 3/§ 7(加 instrumentation 后回填,~2 hr)。

---

## 1. v2.0.1 SPA 当前 Lighthouse(M2/M3 + Phase 10 canary 对照)

**目标**:固定 v2.0.1 Vite SPA 在三个核心页面的 Lighthouse 分数,用作 Next.js 16 RSC 切换后的对比基准。P4(Landing RSC)+ P5(SEO ISR)+ P10(canary 真实流量切换)都会拿这组数据做 gate。

### 1.1 测量目标 URL

| # | URL | 页面类型 | 关注分数 |
|---|---|---|---|
| 1 | `https://animegoclub.com/` | Landing(SPA index) | Performance / LCP / FCP / TBT |
| 2 | `https://animegoclub.com/anime/154587` | Detail(SPA 客户端渲染) | SEO / Performance / LCP |
| 3 | `https://animegoclub.com/seasonal/spring/2026` | Seasonal list | SEO / Performance / CLS |

> URL #2 用 `154587`(《孤独摇滚!》)作为代表性热门番;P5 ISR 验证时同 URL 复跑对照。

### 1.2 本地跑 Lighthouse 命令(三连)

```bash
# 装一次:
npm i -g lighthouse  # 或 npx -y lighthouse

# 跑三个 URL,落 /tmp:
npx -y lighthouse https://animegoclub.com/ \
  --output=json --output=html \
  --output-path=/tmp/lh-home \
  --chrome-flags='--headless=new' \
  --only-categories=performance,accessibility,best-practices,seo \
  --quiet

npx -y lighthouse https://animegoclub.com/anime/154587 \
  --output=json --output=html \
  --output-path=/tmp/lh-anime \
  --chrome-flags='--headless=new' \
  --only-categories=performance,accessibility,best-practices,seo \
  --quiet

npx -y lighthouse https://animegoclub.com/seasonal/spring/2026 \
  --output=json --output=html \
  --output-path=/tmp/lh-seasonal \
  --chrome-flags='--headless=new' \
  --only-categories=performance,accessibility,best-practices,seo \
  --quiet

# 提关键分数:
for f in /tmp/lh-home.report.json /tmp/lh-anime.report.json /tmp/lh-seasonal.report.json; do
  echo "=== $f ==="
  jq '{
    perf:  .categories.performance.score,
    a11y:  .categories.accessibility.score,
    bp:    .categories["best-practices"].score,
    seo:   .categories.seo.score,
    LCP:   .audits["largest-contentful-paint"].displayValue,
    FCP:   .audits["first-contentful-paint"].displayValue,
    TBT:   .audits["total-blocking-time"].displayValue,
    CLS:   .audits["cumulative-layout-shift"].displayValue
  }' "$f"
done
```

> **注**:跑之前先做一次"暖站"请求,避免 cold-start 把 LCP 拉高;每个 URL 跑 3 次取中位数(Lighthouse 单次方差大)。

### 1.3 数据填这里(待填)

| URL | Perf | A11y | BP | SEO | LCP | FCP | TBT | CLS |
|---|---|---|---|---|---|---|---|---|
| `/` | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ s | _TBD_ s | _TBD_ ms | _TBD_ |
| `/anime/154587` | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ s | _TBD_ s | _TBD_ ms | _TBD_ |
| `/seasonal/spring/2026` | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ s | _TBD_ s | _TBD_ ms | _TBD_ |

**Phase 10 canary gate(切 RSC 后必须达到)**:

- **Perf 分数** ≥ baseline + 0.10(至少涨 10 分)
- **LCP** ≤ baseline × 0.7(降至少 30%,RSC 主目标)
- **SEO** ≥ 95(P5 acceptance 已强制)
- **CLS** ≤ max(baseline, 0.1)(不能变差)

**责任人**:Claude / Lawrence(本地能跑)
**填写截止**:P3.1 结束(本任务窗口内)

---

## 2. 当前 Express+Mongo 错误率 7 天 baseline(M8 canary + Phase 8.5 shadow 对照)

**目标**:固定 v2.0.1 生产 7 天 5xx 错误率,作为 P8.5 shadow(Go 后端跑影子流量)的 **绝对 SLO 下限** —— Go 后端 5xx 率必须 ≤ Express baseline,否则 P10 拒绝切量。

### 2.1 SSH 命令(VPS 上跑)

> ⚠️ subagent 没有 SSH 凭据,以下命令需要 **Lawrence 手动 SSH 上去跑**,把结果填到 § 2.2。

```bash
# SSH 上 VPS:
ssh -p 17776 root@45.152.65.208

# 进项目目录(docker compose context):
cd /opt/animego

# nginx access.log 位置(确认):
docker compose exec nginx ls -la /var/log/nginx/
# 期望看到 access.log + error.log,如果是 bind mount 落主机,直接 ls /opt/animego/logs/nginx/

# === 命令 A:7 天 5xx 总数 ===
# 假设 nginx access.log 是 combined format,status code 在 $9 位置
docker compose exec nginx sh -c '
  awk -v cutoff="$(date -d "7 days ago" +"%d/%b/%Y")" '\''
    { split($4, a, ":"); d = substr(a[1], 2);
      if (d >= cutoff && $9 ~ /^5[0-9][0-9]$/) c++ }
    END { print "5xx in last 7 days:", c+0 }
  '\'' /var/log/nginx/access.log
'

# === 命令 B:7 天总请求数(算分母) ===
docker compose exec nginx sh -c '
  awk -v cutoff="$(date -d "7 days ago" +"%d/%b/%Y")" '\''
    { split($4, a, ":"); d = substr(a[1], 2);
      if (d >= cutoff) total++ }
    END { print "total req in last 7 days:", total+0 }
  '\'' /var/log/nginx/access.log
'

# === 命令 C:5xx 按 status code 拆分(看是不是某个 endpoint 集中爆) ===
docker compose exec nginx sh -c '
  awk -v cutoff="$(date -d "7 days ago" +"%d/%b/%Y")" '\''
    { split($4, a, ":"); d = substr(a[1], 2);
      if (d >= cutoff && $9 ~ /^5[0-9][0-9]$/) bucket[$9]++ }
    END { for (k in bucket) print k, bucket[k] }
  '\'' /var/log/nginx/access.log | sort
'

# === 命令 D:5xx 按 path 集中度(top 10) ===
docker compose exec nginx sh -c '
  awk -v cutoff="$(date -d "7 days ago" +"%d/%b/%Y")" '\''
    { split($4, a, ":"); d = substr(a[1], 2);
      if (d >= cutoff && $9 ~ /^5[0-9][0-9]$/) path[$7]++ }
    END { for (k in path) print path[k], k }
  '\'' /var/log/nginx/access.log | sort -rn | head -10
'
```

> **注**:VPS 是 Alpine `docker compose exec nginx sh`,如果 `date -d` 不支持,改 BusyBox 写法:`date -D "%s" -d "@$(( $(date +%s) - 604800 ))" +"%d/%b/%Y"`。

### 2.2 数据填这里(待填)

| 指标 | 值 | 备注 |
|---|---|---|
| 7 天总请求 | _TBD_ | 命令 B 输出 |
| 7 天 5xx 总数 | _TBD_ | 命令 A 输出 |
| **5xx 率(%)** | _TBD_ % | A / B × 100 |
| 502 数 | _TBD_ | 命令 C — 上游(Express)挂的信号 |
| 503 数 | _TBD_ | 命令 C — 限流 / 过载 |
| 504 数 | _TBD_ | 命令 C — 上游超时 |
| 最频繁 5xx path | _TBD_ | 命令 D top 1 |

**Phase 8.5 shadow gate**:Go 后端 shadow 流量 5xx 率必须 ≤ baseline × 1.2(允许 20% margin)。
**Phase 10 canary gate**:切流量到 Go 后端的 30 分钟窗口 5xx 率必须 ≤ baseline × 1.5,否则自动回滚。

**责任人**:Lawrence (VPS)
**填写截止**:P9 cutover 前 ≥ 7 天(确保 baseline 数据点充分)

---

## 3. socket.io 7 天断流率(M8 canary 对照)

**目标**:固定当前 v2.0.1 socket.io(server/socket/ + Express)的 7 天 **意外断流率**(非用户主动关闭页面),作为 P2.8 ws-server 独立微服务上线 + P10 切流量后的对照。

### 3.1 当前状态:**没有应用层 instrumentation**

读过 `/Users/lawrence_li/animego/server/socket/index.js`(31 行)+ `/Users/lawrence_li/animego/server/socket/danmaku.handler.js` + `/Users/lawrence_li/animego/ws-server/src/index.js`(159 行):

- ❌ 无 `/metrics` 端点
- ❌ 无 disconnect counter / gauge
- ❌ 无 connection lifetime histogram
- ✅ 只有 `auth:expired` 显式断流(JWT 过期)和 `socket.disconnect(true)` 主动关连接 — 这两个不算"异常断流"
- ✅ ws-server 有 `/health` 但只返 `ok`,不返 metrics

**结论**:**P9 cutover 前必须先加 instrumentation**,否则 § 3.2 全是空气数。

### 3.2 加 instrumentation 的最小改动(建议)

在 `ws-server/src/index.js` `attachSocketIo()` 内加(P3.2 或 P2.8 followup):

```javascript
// 进程内计数器(prom-client 或手撸,先手撸够用)
const stats = {
  connectsTotal: 0,
  disconnectsByReason: {},   // {reason: count}
  currentConnections: 0,
  maxConnections: 0,
}

io.on('connection', (socket) => {
  stats.connectsTotal++
  stats.currentConnections++
  if (stats.currentConnections > stats.maxConnections) {
    stats.maxConnections = stats.currentConnections
  }

  socket.on('disconnect', (reason) => {
    stats.currentConnections--
    stats.disconnectsByReason[reason] = (stats.disconnectsByReason[reason] || 0) + 1
  })

  // ... existing handlers
})

// /health handler 扩展为 /metrics(或新端点)
function createHealthHandler() {
  return (req, res) => {
    if (req.url === '/health' || req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
      return
    }
    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(stats))
      return
    }
    res.writeHead(404); res.end('not found')
  }
}
```

> **注**:`disconnect` reason 的语义(socket.io v4):`transport close`(客户端正常关) / `transport error`(网络断) / `ping timeout`(心跳超时) / `server namespace disconnect`(服务端主动) / `client namespace disconnect`(客户端主动) / `forced close`。"异常断流"= `transport error` + `ping timeout` 之和。

### 3.3 数据填这里(待填)

| 指标 | 值 | 备注 |
|---|---|---|
| 7 天总连接数 | _TBD_ | `connectsTotal` 在 7 天窗口的增量 |
| 7 天 `transport error` 数 | _TBD_ | disconnectsByReason["transport error"] |
| 7 天 `ping timeout` 数 | _TBD_ | disconnectsByReason["ping timeout"] |
| **异常断流率(%)** | _TBD_ % | (transport error + ping timeout) / connectsTotal × 100 |
| 平均连接时长(中位) | _TBD_ s | 需额外加 histogram(可选) |

**Phase 10 canary gate**:ws-server 独立微服务的异常断流率 ≤ baseline × 1.3。

**责任人**:Lawrence(SSH 部署后 curl 抓 metrics)+ Claude(写 instrumentation patch)
**填写截止**:P9 cutover 前 ≥ 7 天(instrumentation 上线后等满 7 天数据)
**状态**:**BLOCKED — 需先在 P2.8 followup 或 P3.2 把 instrumentation 加上**

---

## 4. GSC 索引数(M2/M3 acceptance 对照)

**目标**:固定当前 Google Search Console 已索引页面数,作为 P5 SEO ISR(`/anime/[id]` + `/seasonal/[season]/[year]` 改 RSC + ISR 后)是否伤到 SEO 的 gate。

### 4.1 手动步骤(只有 Lawrence 能跑)

1. 打开 [Google Search Console](https://search.google.com/search-console)
2. 选属性:`animegoclub.com`(或 `https://animegoclub.com/`,看注册时是哪种)
3. 左侧菜单 → **索引 → 网页**(Pages)
4. 看顶部"**已编入索引**"那一栏的数字 — 这是 baseline 总索引数
5. 按 URL 模式拆分(填到 § 4.2):
   - `/anime/*` 已索引数
   - `/seasonal/*` 已索引数
   - `/`(首页)是否已索引
6. **导出 CSV**:点右上角 ⬇️ → "导出已索引网页",落 `~/Downloads/Coverage-...csv`,改名为 `docs/migration/data/gsc-baseline-YYYY-MM-DD.csv`(P3.1 内 commit;路径加到 .gitignore data/* 例外白名单或直接 commit,看 PII)。

### 4.2 数据填这里(待填)

| 指标 | 值 | 备注 |
|---|---|---|
| 总已索引页面 | _TBD_ | GSC "已编入索引" |
| `/` 是否索引 | _TBD_ | Yes / No |
| `/anime/*` 已索引数 | _TBD_ | URL 模式过滤 |
| `/seasonal/*` 已索引数 | _TBD_ | URL 模式过滤 |
| 测量日期 | _TBD_ | YYYY-MM-DD(GSC 数据 T-3 天延迟,注意标日期) |

**Phase 5 acceptance(P5 完成验收)**:
- `/anime/*` 已索引数在 P5 上线 28 天内 ≥ baseline × 1.0(不能掉)
- 30 天内 ≥ baseline × 1.2(ISR + sitemap 应能涨 20%)

**Phase 10 acceptance**:总已索引数 14 天内不能跌 > 10%(否则可能是 cutover 把 SEO 搞坏)。

**责任人**:Lawrence (manual)
**填写截止**:P3.1 结束(15 分钟搞定,先做)

---

## 5. Express prod metrics 7 day(二轮 review 8A — P8.5 shadow 阈值源)

**目标**:固定 v2.0.1 Express 在 nginx 前的 req/s + p50/p95/p99 延迟 + 日峰值,作为 **P8.5 shadow 阈值"P99 < baseline P99 × 1.5"** 的源数据(原 plan 想 hardcode 200ms,二轮 review 8A 改成相对阈值)。

### 5.1 SSH 命令(VPS 上跑)

> ⚠️ 需 Lawrence 手动 SSH;假设 nginx log format 含 `$request_time`(秒,浮点),如果当前 format 没有,需先在 nginx conf 加。

```bash
ssh -p 17776 root@45.152.65.208
cd /opt/animego

# === 命令 A:确认 nginx log format 有 request_time ===
docker compose exec nginx cat /etc/nginx/nginx.conf | grep -A 3 log_format
# 期望看到类似:
# log_format combined_rt '$remote_addr - $remote_user [$time_local] '
#                       '"$request" $status $body_bytes_sent '
#                       '"$http_referer" "$http_user_agent" $request_time';
# 如果没有 $request_time,先加上 + nginx -s reload + 等 7 天再来跑(或直接用 access.log 现有 status code 算 throughput,延迟数据放空)

# === 命令 B:7 天总 req/s(平均) ===
docker compose exec nginx sh -c '
  awk -v cutoff="$(date -d "7 days ago" +"%s")" '\''
    {
      # 解析 [DD/Mon/YYYY:HH:MM:SS +0000] 到 epoch
      ts = $4 substr($5, 1, 5);
      gsub(/[\[\]]/, "", ts);
      # ... (BusyBox awk 没法直接 mktime,简单用 wc -l / 7天秒数代替)
    }
    { c++ }
    END { print "total req in 7d:", c; print "avg req/s:", c/(7*86400) }
  '\'' /var/log/nginx/access.log
'

# === 命令 C:p50 / p95 / p99 延迟($request_time 在 last field) ===
docker compose exec nginx sh -c '
  awk '\''
    { print $NF }   # $request_time(秒)
  '\'' /var/log/nginx/access.log | sort -n > /tmp/rt.txt
  total=$(wc -l < /tmp/rt.txt)
  p50_line=$(( total / 2 ))
  p95_line=$(( total * 95 / 100 ))
  p99_line=$(( total * 99 / 100 ))
  echo "p50: $(sed -n "${p50_line}p" /tmp/rt.txt) s"
  echo "p95: $(sed -n "${p95_line}p" /tmp/rt.txt) s"
  echo "p99: $(sed -n "${p99_line}p" /tmp/rt.txt) s"
'

# === 命令 D:日峰值 req/s(每小时 bucket) ===
docker compose exec nginx sh -c '
  awk '\''
    { split($4, a, ":"); hour = substr(a[1], 2) ":" a[2] ":" a[3];
      bucket[hour]++ }
    END {
      for (h in bucket) print h, bucket[h]/3600
    }
  '\'' /var/log/nginx/access.log | sort -k2 -rn | head -5
'
# 取 top 1 行的 req/s 作为日峰值,top 5 看高峰窗口的稳定性
```

### 5.2 数据填这里(待填)

| 指标 | 值 | 备注 |
|---|---|---|
| 7 天总请求 | _TBD_ | 命令 B |
| 平均 req/s | _TBD_ | 命令 B |
| **日峰值 req/s** | _TBD_ | 命令 D top 1 — P8.5 shadow 流量 sample 率参考 |
| **p50 延迟** | _TBD_ s | 命令 C |
| **p95 延迟** | _TBD_ s | 命令 C |
| **p99 延迟** | _TBD_ s | 命令 C — **P8.5 阈值源:Go P99 ≤ baseline P99 × 1.5** |

**P8.5 shadow 阈值(派生)**:
- Go P99 ≤ baseline P99 × 1.5
- Go P95 ≤ baseline P95 × 1.3
- Go P50 ≤ baseline P50 × 1.2

**责任人**:Lawrence (VPS)
**填写截止**:P9 cutover 前 ≥ 7 天

---

## 6. VPS 出方向带宽 30 day baseline(二轮 review Pf4/TODO-1)

**目标**:固定 VPS 月度出方向带宽 + 服务商 plan threshold,**P8.5 shadow 决定 mirror sample 比率**(plan 原文 §3.7 Pf4:若 `baseline × 2 > threshold` 则 mirror 50% throttle,避免 shadow 流量把月度配额烧爆)。

### 6.1 SSH 命令(VPS 上跑)

```bash
ssh -p 17776 root@45.152.65.208

# === 命令 A:装 vnstat(如果还没装) ===
which vnstat || apt-get install -y vnstat
# 如果是 Alpine:apk add vnstat
systemctl enable --now vnstat   # 或 rc-service vnstat start

# 注:vnstat 需要采样一段时间才有数据,如果新装的至少等 24h 再看月度

# === 命令 B:30 天月度出方向 ===
vnstat -m
# 输出示例:
# eth0  /  monthly
#         month        rx      |     tx      |    total    |   avg. rate
#      ------------------------+-------------+-------------+---------------
#       2026-04        50 GiB  |   200 GiB   |   250 GiB   |   0.79 Mbit/s
#       2026-05        60 GiB  |   240 GiB   |   300 GiB   |   0.95 Mbit/s

# === 命令 C:看 7 天 + 24h 短窗 ===
vnstat -d   # daily
vnstat -h   # hourly,看流量在一天内的分布(找峰值时段,P8.5 mirror 窗口避开)

# === 命令 D(没 vnstat 时备选):iftop 5 分钟采样 ===
iftop -t -s 300 -B   # 5min 平均 byte/s,需要 -B 改单位
```

### 6.2 VPS 服务商 plan threshold(手动查)

**Lawrence 手动**:登录 VPS 服务商控制台(从 README / 之前部署记录找供应商),找当月带宽 plan:

- 月度出方向流量额度(GiB / TiB)
- 超额计费方式(按 GB 加钱 / 限速 / 断网)
- 当前已用百分比

### 6.3 数据填这里(待填)

| 指标 | 值 | 备注 |
|---|---|---|
| 上月出方向总流量(GiB) | _TBD_ | 命令 B 上一月 tx 列 |
| 当月出方向总流量(GiB,截至今日) | _TBD_ | 命令 B 当月 tx 列 |
| 30 天移动平均 tx 速率(Mbit/s) | _TBD_ | 命令 B avg. rate 列 |
| 日峰值 tx(Mbit/s) | _TBD_ | 命令 C(`vnstat -h` 看 hourly 高峰) |
| **服务商 plan 月度上限(GiB)** | _TBD_ | 控制台查 |
| **当前用量占比(%)** | _TBD_ % | 当月 tx / plan 上限 |
| 服务商 | _TBD_ | placeholder |

**P8.5 mirror sample 决策表**:

| 条件 | mirror 比率 |
|---|---|
| baseline × 2 ≤ threshold × 0.7 | 100%(全镜像) |
| baseline × 2 ≤ threshold × 0.9 | 50%(50% sample) |
| baseline × 2 > threshold × 0.9 | 10%(10% sample,避免烧爆) |

**责任人**:Lawrence (VPS) + Lawrence (manual,服务商控制台)
**填写截止**:P8.5 启动前(P8 完成时点)

---

## 7. socket.io 同时在线连接数 7-day max(二轮 review 8A — 容量规划)

**目标**:固定 v2.0.1 socket.io 7 天 **峰值并发连接数**,P2.8 ws-server 独立微服务 + P10 切流量后用作容量 SLO(ws-server 必须能撑 baseline × 2)。

### 7.1 当前状态:**没有应用层 instrumentation**

同 § 3,没有 `currentConnections` / `maxConnections` 计数器。**先加 instrumentation 再回填**(参考 § 3.2 的 patch,`maxConnections` 字段就是这个指标)。

### 7.2 数据填这里(待填)

| 指标 | 值 | 备注 |
|---|---|---|
| 7 天峰值并发连接数 | _TBD_ | `maxConnections` 在 7 天窗口的最大值 |
| 中位并发连接数 | _TBD_ | 需 histogram(可选) |
| 日峰值时段 | _TBD_ | 例如 "20:00-22:00 UTC+8" |

**Phase 2.8 / Phase 10 acceptance**:
- ws-server 单实例必须能撑 baseline × 2 并发(load test 验证)
- 真实 cutover 后 30 分钟内 currentConnections 不能 < baseline × 0.5(掉一半说明客户端没连上来)

**责任人**:Lawrence(metrics 抓取)+ Claude(instrumentation patch)
**填写截止**:P9 cutover 前 ≥ 7 天
**状态**:**BLOCKED — 与 § 3 共用同一个 instrumentation patch**

---

## 8. 阈值汇总(Phase 8.5 + Phase 10 gate 一览)

填完上面 7 节后,本节做"算好的"阈值表 — Phase 8.5 / Phase 10 acceptance 直接查这里:

| Phase / 检查 | 指标 | baseline 引用 | 派生阈值 | 行动 |
|---|---|---|---|---|
| **P8.5 shadow** | Go P99 延迟 | § 5 p99 | ≤ baseline × 1.5 | 超阈值停 shadow,调 Go |
| **P8.5 shadow** | Go P95 延迟 | § 5 p95 | ≤ baseline × 1.3 | 同上 |
| **P8.5 shadow** | Go 5xx 率 | § 2 5xx 率 | ≤ baseline × 1.2 | 同上 |
| **P8.5 mirror** | mirror sample 比率 | § 6 带宽用量 | 见 § 6.3 决策表 | 调 nginx mirror % |
| **P10 canary 30min** | 5xx 率 | § 2 | ≤ baseline × 1.5 | 自动回滚 |
| **P10 canary 30min** | socket 并发 | § 7 max | ≥ baseline × 0.5 | 自动回滚 |
| **P10 canary 30min** | socket 异常断流率 | § 3 | ≤ baseline × 1.3 | warn,人工判断 |
| **P10 acceptance** | Lighthouse Perf | § 1 perf | ≥ baseline + 0.10 | gate 不通过 = reject |
| **P10 acceptance** | LCP(/, /anime, /seasonal) | § 1 LCP | ≤ baseline × 0.7 | 同上 |
| **P10 acceptance** | GSC 索引数 14 天 | § 4 | ≥ baseline × 0.9 | 跌 10%+ rollback SEO |

---

## 9. 修订记录

| 日期 | 修订 | 作者 |
|---|---|---|
| 2026-05-23 | 初版骨架(P3.1 subagent A 产出),7 节 placeholder + 命令 | Claude |
| _TBD_ | § 4 GSC 数据填入 | Lawrence |
| _TBD_ | § 1 lighthouse 数据填入 | Claude / Lawrence |
| _TBD_ | § 2 / § 5 / § 6 VPS 数据填入 | Lawrence |
| _TBD_ | § 3 / § 7 instrumentation 上线 + 数据回填 | Claude + Lawrence |
| _TBD_ | § 8 阈值汇总核对(P8.5 启动前 review) | Lawrence |

---

## 附录 A:命令一键复制(给 VPS 上跑的人)

把这一段直接 paste 到 VPS,跑完一并贴回:

```bash
# === BASELINE.md § 2 + § 5 + § 6 一键脚本 ===
set -e
cd /opt/animego

echo "=== § 2 / § 5 nginx access log 指标 ==="
docker compose exec -T nginx sh -c '
  echo "--- 7d total req ---"
  awk -v cutoff="$(date -d "7 days ago" +"%d/%b/%Y" 2>/dev/null || date -D "%s" -d "@$(( $(date +%s) - 604800 ))" +"%d/%b/%Y")" '\''
    { split($4, a, ":"); d = substr(a[1], 2); if (d >= cutoff) c++ }
    END { print c+0 }
  '\'' /var/log/nginx/access.log

  echo "--- 7d 5xx count ---"
  awk -v cutoff="$(date -d "7 days ago" +"%d/%b/%Y" 2>/dev/null || date -D "%s" -d "@$(( $(date +%s) - 604800 ))" +"%d/%b/%Y")" '\''
    { split($4, a, ":"); d = substr(a[1], 2); if (d >= cutoff && $9 ~ /^5[0-9][0-9]$/) c++ }
    END { print c+0 }
  '\'' /var/log/nginx/access.log

  echo "--- p50/p95/p99 request_time (assumes $request_time at last field) ---"
  awk "{ print \$NF }" /var/log/nginx/access.log | sort -n > /tmp/rt.txt
  total=$(wc -l < /tmp/rt.txt)
  [ "$total" -gt 0 ] && {
    echo "p50: $(sed -n "$((total/2))p" /tmp/rt.txt) s"
    echo "p95: $(sed -n "$((total*95/100))p" /tmp/rt.txt) s"
    echo "p99: $(sed -n "$((total*99/100))p" /tmp/rt.txt) s"
  }
'

echo "=== § 6 vnstat ==="
which vnstat && vnstat -m || echo "vnstat not installed (run: apt-get install -y vnstat)"
```

---

## 附录 B:已确认的事实(填表前的 ground truth)

| 事实 | 来源 | 备注 |
|---|---|---|
| 生产域名 | README.md L7 | `animegoclub.com`(不是 `animego.io`) |
| VPS IP / 端口 | MEMORY.md project_deployment_status | 45.152.65.208 / SSH 17776 |
| docker compose 服务 | MEMORY.md | server / mongo / nginx 三容器 |
| ws-server 已分离 | 8bea942 commit (P2.8) | 独立 Node 微服务,端口 3001 |
| socket.io 无 metrics | server/socket/index.js + ws-server/src/index.js 已读 | 必须先加 instrumentation 才能填 § 3 / § 7 |
| ws-server `/health` | ws-server/src/index.js L53-63 | 只返 `ok`,没有 metrics 端点 |
| GSC 属性 | 推测 | Lawrence 在 search.google.com/search-console 确认 |
| VPS 服务商 | 待确认 | Lawrence 填 § 6.3 |

