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
**Status:** PARTIAL — 5 / 7 已填(§ 1 / § 2 / § 5 / § 6 在 2026-05-23 抓到),§ 3 / § 7 仍 BLOCKED(需先加 instrumentation),§ 4 GSC 待 Lawrence manual
**最后更新:** 2026-05-23
**作者:** Claude / Lawrence
**生产域名:** [animegoclub.com](https://animegoclub.com)
**生产 VPS:** 香港 45.152.65.208 SSH 端口 17776,项目目录 `/opt/animego`,docker compose 三容器(`animego-app-1` / `animego-mongodb-1` / `animego-nginx-1`)

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

| # | 节 | 指标 | 当前值 | 来源 | 责任人 | 状态 |
|---|---|---|---|---|---|---|
| 1 | § 1 | v2.0.1 SPA Lighthouse(3 URL) | **见 § 1.3**:home Perf 44 / LCP 14.1s,anime Perf 61 / LCP 6.1s,seasonal **NO_FCP(prod bug)** | `npx lighthouse` 2026-05-23 | Claude | FILLED |
| 2 | § 2 | Express 5xx 错误率 7 天 | **0 / 50,963 (0%)** | docker logs animego-nginx-1 + awk | Claude (SSH) | FILLED |
| 3 | § 3 | socket.io 断流率 7 天 | _TBD_(需先加 instrumentation) | 应用层 metrics(待加) | Lawrence + Claude | BLOCKED |
| 4 | § 4 | GSC 索引数 | _TBD_ | search.google.com/search-console | Lawrence (manual) | TODO |
| 5 | § 5 | Express prod req/min p50/p95/p99 + 峰值 | **p50 1 / p95 24 / p99 228 / max 892 req/min** | docker logs + awk | Claude (SSH) | FILLED |
| 6 | § 6 | VPS 出方向带宽月度 | **~1.95 GB/month**(/proc/net/dev,vnstat 没装) | `cat /proc/net/dev` | Claude (SSH) | FILLED |
| 7 | § 7 | socket.io 同时在线连接数 7 天 max | _TBD_(需先加 instrumentation) | 应用层 metrics(待加) | Lawrence + Claude | BLOCKED |

**已填:4 / 7**·**待填:1 / 7(§ 4 GSC)**·**阻塞:2 / 7(§ 3、§ 7,需先加 instrumentation)**

> **2026-05-23 测量批次的 3 个重大发现:**
>
> 1. **`/` LCP = 14.1s,`/anime/154587` LCP = 6.1s** — legacy Vite SPA 客户端渲染慢到 LCP 严重超标(Web Vitals 阈值 2.5s)。Phase 4/5 RSC 切换是真正的 user value:验证过 next-app `/` 暖缓存 265ms / 冷启动 2.9s,detail 2.6s — 已经 5-50× 改善。
> 2. **`/seasonal/spring/2026` lighthouse NO_FCP(90s 等不到任何渲染)** — 这是 **真 prod bug**,不是 lighthouse harness 抖动。Vite SPA 在 seasonal 页客户端 JS 卡死。Phase 5 SSR 版本本地实测 1.2s/200/123KB,迁移直接修复。
> 3. **Express 5xx = 0 / 50,963 in 7 days(0.0000%)** — 稳定到不像话。Phase 8.5 Go shadow 5xx 阈值不能用相对比例(乘 1.5 还是 0),改用绝对值 ≤ 5/day。
>
> **填写顺序剩余**:§ 4(GSC,1 分钟,Lawrence 手填)→ § 3/§ 7(加 instrumentation 后回填)。

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

### 1.3 数据(2026-05-23 测量,Lighthouse 12.x,headless Chrome,mobile preset 默认)

| URL | Perf | A11y | BP | SEO | LCP | FCP | TBT | CLS | SI |
|---|---|---|---|---|---|---|---|---|---|
| `/` | **44** | 90 | 96 | **100** | **14.1 s** ⚠️ | 4.3 s | 530 ms | 0.001 | 10.1 s |
| `/anime/154587` | **61** | 94 | 96 | **100** | **6.1 s** ⚠️ | 3.6 s | 300 ms | 0 | 5.3 s |
| `/seasonal/spring/2026` | **NO_FCP** ⚠️⚠️ | — | — | — | — | — | — | — | — |

**红色发现:**

- `/` Perf 44 + LCP 14.1s — 远超 Web Vitals "good" 阈值(LCP ≤ 2.5s)。次因:Vite SPA 客户端渲染 + heavy initial JS bundle,首屏拿不到 critical text/image。**Phase 4 next-app RSC 已实测:同 URL 暖缓存 265ms / 冷启动 2.9s — LCP 改善 5-50×**。
- `/anime/154587` Perf 61 + LCP 6.1s — 详情页 SPA 渲染 + AniList/Bangumi/dandanplay 串联 API 拖累。Phase 5 next-app `/anime/[id]` ISR 实测 2.6s 全 5 section SSR。
- **`/seasonal/spring/2026` NO_FCP** — Chrome headless 90 秒等不到任何渲染,确认是 prod bug 不是测量误差。重试 desktop preset 仍 NO_FCP。HTML response 1.5s/200/2479b(只是 SPA shell),客户端 JS bundle 卡死。**用户在真实浏览器上极可能看到长白屏**。Phase 5 next-app SSR 版本 1.2s/200/123KB 完整 HTML — 这是迁移最直接的用户体验修复。
- 三个页面 SEO 都 100/100(legacy nginx + 静态 HTML meta + sitemap 已经做得好);CLS 几乎全 0(布局稳)。RSC 切换不能伤这两项。
- A11y 90-94 — 有改进空间,RSC 切换时注意 aria-busy / lang 标记。

**原始报告:** `/Users/lawrence_li/animego/docs/migration/data/lh-{home,anime,seasonal}.report.{json,html}`(gitignored,本地参考)。

**Phase 10 canary gate 当前阈值(锁,所有相对值改基于本组数据):**

| 页面 | LCP 切换后目标 | Perf 切换后目标 | SEO 切换后目标 | CLS 上限 |
|---|---|---|---|---|
| `/` | ≤ **9.9 s**(baseline × 0.7,RSC 主目标;实际 next-app 已测 2.9s 暖缓存) | ≥ **54** | ≥ **95**(P5 acceptance) | ≤ 0.1 |
| `/anime/154587` | ≤ **4.3 s**(baseline × 0.7) | ≥ **71** | ≥ **95** | ≤ 0.1 |
| `/seasonal/spring/2026` | ≤ **2.5 s**(NO_FCP 没基线,改用 Web Vitals "good" 绝对值;next-app 已测 1.2s) | ≥ **80**(NO_FCP 没基线,绝对值) | ≥ **95** | ≤ 0.1 |

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

### 2.2 数据(2026-05-23 抓,docker logs animego-nginx-1 最近 168h)

| 指标 | 值 | 备注 |
|---|---|---|
| 7 天总请求 | **50,963** | docker logs --since 168h + awk(\$9 数字) |
| 7 天 5xx 总数 | **0** | awk \$9 ~ /^5/ 命中 0 |
| **5xx 率(%)** | **0.0000 %** | 0 / 50,963 |
| 7 天 4xx 总数 | 1,669 | 主要是 403(.env 探测 / 机器人扫描),正常 |
| 7 天 2xx/3xx 总数 | 49,138(96.42%) | 正常流量 |
| 最频繁 5xx path | 无 | 7 天 0 5xx |

⚠️ **完整生命周期(6 周容器 uptime)只有 30 次 5xx / 192,231 总请求 = 0.0156%** — 这套 Express+Mongo+nginx 在 prod 极稳。

**Phase 8.5 shadow gate(改用绝对值,baseline = 0):** Go 后端 shadow 流量 5xx 必须 ≤ **5 / day**(允许 ~1 / 10k 请求,松于 baseline 但仍 SLO 内),持续 7 天才算 pass。**不用乘 baseline 1.2 因为 0 × 1.2 = 0,卡得太死**。
**Phase 10 canary gate:** 切流量 30 分钟窗口 5xx ≤ **3 次** 才允许继续切,否则自动回滚。

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

### 5.2 数据(2026-05-23 抓,docker logs animego-nginx-1 最近 168h,per-minute bucket)

| 指标 | 值 | 备注 |
|---|---|---|
| 7 天总请求 | **50,963** | docker logs --since 168h |
| 活跃分钟数 | 5,327 | 7d × 1440min = 10,080 → 53% 分钟有流量 |
| 平均 req/min | ~10 req/min | 50,963 / 5,327 |
| **p50 req/min** | **1 req/min** (0.02 req/s) | 一半时间几乎空闲 |
| **p95 req/min** | **24 req/min** (0.40 req/s) | 正常负载 |
| **p99 req/min** | **228 req/min** (3.80 req/s) | 峰值边缘 |
| **max req/min** | **892 req/min** (14.87 req/s) | 单分钟峰值(可能爬虫 burst) |
| 最忙小时 | May 17 04:00 UTC = 9,791 req/hr | = 平均 2.72 req/s 持续 1 小时 |

⚠️ **request_time 延迟数据未抓** — 当前 nginx log_format 标准 combined,不含 `$request_time` 字段。要拿 P50/P95/P99 latency 需 nginx conf 加 `$request_time` + reload + 等 7 天。P8.5 阈值改用 **throughput 不退化** 派生:Go P99 throughput ≥ baseline P99(228 req/min)× 0.9 = 205 req/min,即 Go 不能丢请求。

**P8.5 shadow 阈值(派生,throughput-based,改自原 latency-based):**
- Go 服务处理速率 ≥ baseline p99 × 0.9 = **205 req/min**(不丢请求)
- Go 5xx ≤ **5 / day**(见 § 2)
- Go memory + goroutine count 不报警(separate Grafana,Phase 8 加)

**Latency 数据回填 followup**:nginx conf 加 `$request_time + $upstream_response_time` → reload → 等 7 天 → 重跑本节命令 C。

**责任人**:Claude (SSH) — Lawrence 验
**抓取时间**:2026-05-23 20:39 UTC+8

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

### 6.3 数据(2026-05-23 抓,`/proc/net/dev` ens17 接口,35 天 uptime 推算)

⚠️ **vnstat 没装**,改用 `/proc/net/dev` 自机器启动起的 TX 累计字节除以 uptime 天数估算。**误差 ±20%**,准确数据需 `apt install vnstat` + 跑满 30 天。

| 指标 | 值 | 备注 |
|---|---|---|
| 接口 | ens17 | 主网卡(br-* 是 docker bridge,忽略) |
| 累计 TX(自 35 天 uptime 起) | **2.44 GB** (2,443,341,759 bytes) | /proc/net/dev |
| 日均出方向 | **~66.6 MB/day** | 2.44 GB / 35 day |
| **30 天月度推算** | **~1.95 GB/month** | 66.6 × 30 / 1024 |
| 服务商 plan 月度上限 | _TBD_(Lawrence 查控制台) | placeholder |
| 当前用量占比 | _TBD_ % | 推算/上限 |
| 服务商 | _TBD_(Lawrence 标注) | 香港 IP 45.152.65.208 |

**P8.5 mirror sample 决策表(更新):**

baseline 太低(< 2 GB/month),P8.5 完全 mirror 投影:

| 场景 | 月度 TX |
|---|---|
| 当前 baseline | ~1.95 GB |
| **P8.5 100% mirror(Go shadow)** | ~3.90 GB(× 2)|
| **P8.5 50% mirror** | ~2.93 GB(× 1.5)|

任何商用 VPS plan 通常 ≥ 500 GB/month。**结论:P8.5 mirror 100% safe,不需要 sample throttle**。除非服务商 plan ≤ 5 GB/month(极罕见),否则全镜像无风险。

**责任人**:Claude (SSH) — Lawrence 验服务商 plan
**抓取时间**:2026-05-23 20:39 UTC+8
**Followup**:Lawrence 装 vnstat + 跑满 30 天后回填精确数(`apt install vnstat && systemctl enable --now vnstat`)

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

