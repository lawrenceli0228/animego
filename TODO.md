# TODO

已知但尚未处理的事项。按"不处理会怎样"排序，不按工作量。

发现于 2026-08-09（v3.9.1 上线后）。

---

## 1. `animegoanime@animegoclub.com` 收不到信 —— 需要人工操作

**状态**：域名 `animegoclub.com` **没有 MX 记录**，该地址不存在，寄过去的邮件全部退回。

```
dig +short MX animegoclub.com     # 空
dig +short TXT animegoclub.com    # 只有 google-site-verification
```

**为什么排第一**：这个地址已经随 v3.9.0 上线，写在三个法律页上——`/privacy`、`/terms`、`/copyright`。其中**版权页那个是 DMCA 下架通知的收件地址**。提供了一个收不到的联系方式，比不提供更糟。

**做法**（Cloudflare Email Routing，免费，DNS 已在 CF 上）：

1. CF 控制台 → `animegoclub.com` → 左侧 **Email** → Email Routing → Get started
2. 让它**自动添加** 3 条 MX + 1 条 SPF TXT（不要手工加，避免与后续冲突）
3. Destination addresses → 添加常用邮箱 → 去那个邮箱点确认链接（**这一步只能人工**，CF 要验证收件方同意）
4. Routing rules → Custom address → `animegoanime` → 转发到该邮箱

**验证**：

```bash
dig +short MX animegoclub.com          # 应出现 route1/2/3.mx.cloudflare.net
dig +short TXT animegoclub.com | grep spf
```

**两个坑**：

- CF Email Routing **只能收不能发**。要以这个地址回信，需在 Gmail 配「Send mail as」走 Gmail SMTP。
- **SPF 只能有一条**。若同时用 CF 收信 + Gmail 发信，必须合并成一条，两条是硬失败、比没有更糟：
  ```
  v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all
  ```

**顺带**：现在 app 发密码重置信是从 gmail.com 直发的（`GMAIL_USER`），而 **79.6% 的用户邮箱是 @qq.com**（638/802，2026-08-09 实测）。gmail→QQ 送达率大概率过不了一半，且裸 `net/smtp` 看不到退信——**很可能已经有一批用户点了「忘记密码」但从没收到过信**。把发信域名一起做了（SPF+DKIM+DMARC，发件人改 `noreply@animegoclub.com`）会一次解决三件事：密码重置真能送达、版权投诉能收到、以及每周更新提醒邮件的前置条件。

---

## 2. CI 不跑 `next build`

**状态**：检查项只有 test + lint。**一个引用不存在模块的分支可以五项全绿走到合并。**

2026-08-09 实际发生过：`feat/activation-funnel` 一度包含 `SeriesDetailSheet.tsx` 引用 `../_services/loadSeriesRows`，而该模块是未跟踪文件、没进分支。CI 全绿，是手动 `git ls-tree` 才发现的。

**做法**：`unit-tests.yml` 加一个 job 跑 `bun run build`。约十几行。

**附带收益**：能顺便断言 `/anime/[id]` 仍是 `●`（SSG 预渲染）——那是 Cloudflare 边缘缓存的前提，而 SEO 是本站唯一的获客来源。这条一旦退化成 `ƒ`，没有任何现有检查会发现。

---

## 3. 部署后旧标签页崩在详情页 → [issue #76](https://github.com/lawrenceli0228/animego/issues/76)

细节见 issue。优先级低（有错误边界兜底，不白屏），但「重试」按钮在这种情况下无效，是骗人的。

---

## 4. 埋点：`user_activity_daily`

**状态**：没有任何办法度量留存。`users` 表无 `last_login`、无事件表，只能靠 `refresh_rotated_at` 这个副作用推断（它在注册/登录/登出时被置 NULL，语义不可靠）。

**为什么现在记**：v3.9.0/3.9.1 刚上线一批以提升留存为目标的改动，而**没有任何办法判断它们是否有效**。

**关键性质**：激活率、注册量、流量都**可回溯**（`subscriptions.created_at` / `users.created_at` 一直在记）；**只有留存不可回溯**——今天不开始记，这段 cohort 就永远算不出来。

**做法**：一张两列主键的表 + 一个 go-api 中间件，约 80 行。设计见 `docs/designs/growth-activation-plan-zh.html` 的 Tier 0。

```sql
CREATE TABLE user_activity_daily (
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day           date NOT NULL,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    hits          integer     NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, day)
);
```

量级：DAU 约 10-15 → 约 400 行/月。十年不到 100 万行。

**同一天顺手**（各 5 分钟）：开启 Cloudflare Web Analytics——实测 beacon **当前不在页面上**（CSP 已放行，是遗留空壳），而它是「注册转化率」唯一缺的那个分母。

---

## 5. 自建弹幕：建议砍掉

**状态**：`danmakus` 表 3 条数据，而它养着一个 7×24 常驻容器（ws-server）+ 约 1600 LOC + 2 张表 + nginx 路由。

**为什么不是"冷启动失败"而是"从来没有入口"**（四条独立证据）：

- `next-app/package.json` **无 `socket.io-client` 依赖**
- `next-app/src` **零处调用** `/api/danmaku`（连读都没接）
- `VideoPlayer.tsx` 显式 `emitter: false`
- `danmakus` 表**无播放时间戳字段** —— 结构上不可能覆盖到视频上；它是"按集的 2 小时聊天室"，和播放器里那个弹幕只是重名

播放器现有的弹幕来自 dandanplay（一集常几千条），那才是真正的卖点，**保留**。

**注意**：这是删代码，不可逆，且会动 `docker-compose.yml` / nginx 配置。做之前单独确认。
