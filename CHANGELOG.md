# AnimeGo 开发日志

---

## [1.0.10] - 2026-04-20

### 续作季节弹幕映射修复 — loose-title gate + 三级 fallback 提取 shared

**背景：**
- 用户报告 `[LoliHouse] Oshi no Ko S3 - 11.mkv` 在 dandanplay 里**没有弹幕，手动选择也没有**
- 实测发现是两个耦合的静默失败：
  1. **服务端 Phase 1 闸门过严** — 字幕组新番 raw 未入 dandanplay hash 索引时，API 返回 `isMatched:false` 但候选 `animeTitle: "【我推的孩子】 第三季"` 其实宽松匹配用户 keyword。旧闸门 `if (combined?.isMatched)` 直接丢弃，`/match` 响应 `matched:false`，客户端跳转"手动选择"
  2. **客户端 `selectManual` 只做纯 number 匹配** — 续作季 dandanplay 把 raw number 编成 `25..35` + `C1/C2/C3` OP/ED specials。用户文件名解析出 `epNum=11`，level-1 的 `episodes.find(e => e.number === 11)` 永远返回 undefined，手动选完 episodeMap 空 → 无弹幕
- 这个 bug 对所有 S2/S3 续作（芙莉蓮 第二季 raw 29..38、DanDaDan 第二季 raw 13..24 等）都潜在，只是 Oshi no Ko S3 因为 C1/C2/C3 specials 打乱数组下标让 Naive index fallback 也失效，才暴露得最彻底

**改动（commit `197a332`）：**

*新增 `shared/episodeMap.cjs` — 三级 fallback util，客户端 + 服务端共用：*
```js
// level 1: number === epNum
// level 2: rawEpisodeNumber 匹配 /^[OS](\d+)$/  (OVA/Special)
// level 3: pool[epNum - 1]，pool = 只含 /^\d+$/ 的 raw 过滤后数组
```
- level-3 关键细节：过滤到纯数字 `rawEpisodeNumber` 的池子里回退，C1/C2/C3 specials 不进池，避免 E12 落到 C1 Opening
- `.cjs` 扩展名同时兼容服务端 CJS `require` 与 Vite 客户端 ESM `import`

*`server/services/dandanplay.service.js`：*
- 原 46 行内联 `buildEpisodeMap` 删除，改从 `../../shared/episodeMap.cjs` 引入
- `module.exports` 继续 re-export，服务端下游代码零改动

*`server/controllers/dandanplay.controller.js`：*
- 新增 `normalizeTitle(s)` — 小写化 + 剥掉 `[] 【】 ()《》「」『』 空格 标点`
- 新增 `titleLooselyMatchesKeyword(animeTitle, keyword)` — 归一化后双向 `includes`
- Phase 1 闸门放宽：
  ```js
  const accept = combined && (
    combined.isMatched ||
    (combined.animeId && titleLooselyMatchesKeyword(combined.animeTitle, keyword))
  );
  if (accept) { ... }
  ```
- 对新番 fansub（hash 没入索引但候选标题对）的场景首次可用

*`client/src/hooks/useDandanMatch.js`：*
- `selectManual` 里内联的 `epData.episodes.forEach(ep => { if (requested.includes(ep.number)) map[...] })` 替换为 `buildEpisodeMap(epData.episodes, episodes)`
- 手动选择路径首次获得 OVA 前缀 + index fallback 能力

**覆盖：**

*`server/__tests__/episodeMap.test.js`（新）：*
- level 1 纯 number / level 2 OVA 前缀 / level 3 index fallback 单元测试
- **Oshi no Ko S3 fixture**（raw `25..35` + `C1/C2/C3`）：
  - E11 → `9035` 第35话 ✓
  - E12 → 不能落到 `8001/8002/8003`（C-specials）✓
  - 批量 `[1..11]` 全部映射 ✓
- 混合 level-1 + level-3 partial hit 测试

*`server/__tests__/dandanplay.controller.test.js`（扩展）：*
- Phase 1 闸门 4 个 regression：isMatched:false + 标题匹配 → 接受；不匹配 → 拒绝；bracket/space 归一化；isMatched:true 依然生效

*`client/src/__tests__/useDandanMatch.test.jsx`（扩展）：*
- `selectManual` Oshi no Ko S3 E11 → `9035`（不是 `8001` C1 Opening）

**E2E 真实文件验证（`scripts/test-real-files.js`）：**
- 8 个真实 fansub 文件（Enen S3 / Kakkou S2 / Yofukashi S2 / Frieren 第二季 [29-38] / DanDaDan S2 / Sono Bisque S2 / Kaoru Hana / Oshi no Ko S3）计算首 16MB MD5，打 `/api/v2/match`，应用闸门 + `buildEpisodeMap` → 8/8 管道全过
- Oshi no Ko S3 manual pick（animeId=18901，raw `25..C3`）：
  ```
  ep  1 → 189010001  第25话 投入
  ep  2 → 189010002  第26话 盘算
  ...
  ep 11 → 189010011  第35话 那就是一切的开端   ← 原 bug 正确映射
  ```

**验证：**
- 服务端 `jest` — 32 suites, **286/286**
- 客户端 `vitest` — 71 files, **594/594**
- Oshi no Ko S3 E11 手动选择端到端可用

**关键点 / 附带发现：**
- dandanplay 对 Oshi no Ko S3 E11 的 hash 索引**错挂到第二季**（id=18086）—— 自动匹配返回 isMatched:true 但 animeTitle 是"我推的孩子 第二季"。这是 dandanplay 数据问题，不是我们的 bug；用户看到的"有弹幕但是上一季第22话"就是这个原因。手动重选 S3（id=18901）走修好的 `selectManual` 路径现在能映射正确
- 三级 fallback 是保守设计：只在纯 number raw 池里做 index 回退，绝不会把特别篇/OP/ED 当正片。宁可映射失败也不乱映射
- 抽 shared util 不只是 DRY — 旧客户端 `selectManual` 里的是 **degraded 版** 逻辑（只做 level 1），服务端是完整三级。统一到一处后两边行为对齐，以后只有一处要改

---

## [1.0.9] - 2026-04-19

### SEO 品牌统一 — AnimeGo → AnimeGoClub + Organization schema

**背景：**
- Google 搜 `animegoclub`、`animego`、`animegoclub 番剧` 主页都排不到前几，搜索结果还出现 "Did you mean: animego club" 的拆词提示
- 根因：站内从 `<title>` / `<h1>` / `og:site_name` 到 JSON-LD 一律自称 `AnimeGo`，域名 `animegoclub.com` 的品牌信号从未在正文落地
- `AnimeGoClub` 只在 `WebSite` schema 的 `alternateName` 出现过一次，权重不足以让 Google 把它固化成独占 token
- 搜 `animego` 时前两位是 animego.com.au（Adelaide 线下节）和 animego.net（老牌流媒体），这条战场短期内抢不下来；唯一可独占的品牌词只有 `animegoclub`

**改动（commit `738b91e`）：**

*`server/middleware/ogTags.js`：*
- `SITE_NAME`: `'AnimeGo'` → `'AnimeGoClub'`
- 新增模块级 `ORG_JSON_LD` 常量：`Organization` schema，logo 指向 `/favicon-192.png`
- 主页 title：`AnimeGoClub · 番剧追番 · 动漫发现 · 新番评分`
- 主页 H1：`AnimeGoClub · 番剧追番与动漫发现平台`
- 主页新增 `<meta name="keywords">`：`AnimeGoClub,animegoclub,番剧,追番,新番,动漫,二次元,弹幕,动画评分`
- 主页正文扩写一段业务描述，让品牌词在可见内容中反复出现（最终 HTML 里 `AnimeGoClub` 字符串出现 14 次）
- 主页 `WebSite` JSON-LD 的 `alternateName` 从单值改为数组 `["AnimeGo", "animegoclub"]`，再独立挂一份 Organization JSON-LD
- 详情页 fallback 描述文案里的 `AnimeGo` 也统一到 `AnimeGoClub`
- 搜索关键词里的"动画" → "番剧"（和 Google 中文用户搜索习惯对齐）

*`client/index.html`（SPA shell 同步）：*
- title / description / keywords 跟服务端保持一致
- JSON-LD `WebSite.name` → `AnimeGoClub`，`alternateName` 改数组
- 额外挂 Organization schema

*`server/__tests__/ogTags.test.js`：*
- 详情页 fallback 断言字符串 `"<title>动画 #99999 - AnimeGo</title>"` → `"...- AnimeGoClub</title>"`

**验证：**
- `npx jest ogTags.test.js sitemap.test.js` — 17 cases 全绿
- 线上部署后 `curl -A "Googlebot" https://animegoclub.com/` 返回新 HTML：title / og:site_name / WebSite+Organization schema 均为 AnimeGoClub
- Google Search Console 已重新提交 sitemap.xml（5003 URLs 已发现）+ 主页请求编入索引

**关键点：**
- 这不是为了抢 `animego` 关键词（对手太强），而是让 Google 把 `animegoclub` 这个**域名专属 token** 完整识别成一个词、并绑定到本站主页
- `AnimeGo` 作为 `alternateName` 保留，不是弃用，而是告诉 Google "两个名字指同一实体"
- Sitelinks（Bilibili 那种"下载"/"GIF 教程"子链接）是 Google 自动生成的，不能通过代码强制触发，只能靠品牌搜索量 + 清晰导航慢慢积累

**预期时间线：**
- 几小时~1 天：sitemap 重新抓取，"上次读取时间"更新
- 2-3 天：主页索引状态刷新
- 1-2 周：搜 `animegoclub` 主页进前几位
- 2-4 周：搜 `animegoclub` 主页稳定第一，`animegoclub 番剧` 等长尾品牌词也指向主页

---

## [1.0.8] - 2026-04-19

### PlayerPage 状态机收敛 — 拆出 usePlaybackSession + resolveSubtitle，补全 DanmakuPicker 测试

**背景：**
- `PlayerPage.jsx` 419 行,7 块职责耦合在一个组件里:文件投递、dandanplay 三段匹配、弹幕加载、**播放会话(playingFile/Ep/videoUrl/subtitleUrl 等 6 个 useState)**、**字幕来源仲裁(外挂 vs MKV embedded worker)**、**MKV blob 生命周期**、DanmakuPicker 模态触发
- 4/5/6 块是同一个会话生命周期的三个面向,散在 6 个 useState + 1 个 ref + 3 个 effect 里。每次切集都要手动同步,漏一个就泄漏 blob 或残留旧字幕
- 隐藏 race:切集时旧 mkv.worker 只在自己回包/onerror 时才 terminate,30s timeout 也只 terminate 不 cancel onmessage —— 用户连续切集,前一集的 worker 5s 后回包污染当前集字幕

**重构(commit `f0e04db`):**

*Step 1 — 抽 `client/src/hooks/usePlaybackSession.js` (118 行):*
- 内部收敛 6 个 useState (playingFile/Ep/videoUrl/subtitleUrl/subtitleType/subtitleContent) + mkvBlobUrlRef + subtitleTaskRef
- 暴露 `play(fileItem, episodeMap)` / `back()`,对 `useDandanMatch` 只读 (读 episodeMap,不回调改 MM.phase)
- **stale-task guard**:`subtitleTaskRef !== sub.task` 时直接 revoke late blob,不污染当前集状态
- unmount cleanup 收敛到一处 useEffect

*Step 2 — 抽 `client/src/utils/resolveSubtitle.js` (81 行):*
- 纯函数返回 `{ kind: 'sync' | 'none' | 'mkv', state? | task? }`
- mkv 路径返回 `{ promise, cancel }` task 对象,30s timeout 由 utility 自管
- **defensive nullify**:`finish()` 内部先 `worker.onmessage = null; worker.onerror = null` 再 terminate,关掉 worker.terminate 自身的 race window
- 字幕仲裁逻辑从 PlayerPage 内联 worker 启动剥离,可独立单元测试

*PlayerPage 收尾:*
- 419 → 354 行,删 6 个 useState + 1 个 ref + 1 个 cleanup effect
- `handlePlay` 缩成 `startPlayback(fileItem, matchResult?.episodeMap)`
- `handleBackToList` 缩成 `stopPlayback()`
- `uiPhase = playbackPhase === 'playing' ? 'playing' : phase` 派生公式不变,UI 渲染零回归

**测试(7 + 8 = 15 cases,全绿):**
- `usePlaybackSession.test.jsx` — phase 初始态、play/back blob 回收、切集 terminate 旧 worker + 忽略 late 响应、unmount cleanup、external subtitle 短路、null episodeMap 边界
- `resolveSubtitle.test.jsx` — sync/none/mkv 三路分支、worker error → null、no result → null、cancel terminate + nullify、30s timeout via `vi.useFakeTimers`
- 调测过程中发现并修了一处真实 bug:test 的 `__respond` 在 cancel 之后还能触发原 onmessage,因为 MockWorker.terminate 不会 nullify handler。defensive nullify 同时解决了真实代码的同名 race

**DanmakuPicker 测试补全(commit `8cb2033`):**

`DanmakuPicker.jsx` (359 行) 此前 0 测试,补 `DanmakuPicker.test.jsx` 32 cases / 7 组:
- closed state — `isOpen=false` 不挂载、不发请求
- header & dismiss — ✕ / overlay / ESC / 关闭后 listener 不残留(防内存泄漏)
- tabs — current 与 search 切换,无 currentAnime 时 current tab 隐藏
- auto-load — 打开时自动 loadEpisodes、defaultKeyword → titleNative → titleRomaji → titleChinese 回退链、重开时 selected/pickedAnime 全部 reset
- current anime episode list — EP 补零、rawEpisodeNumber 回退、currentMatch 标记、loading/empty/error 三态
- search 流 — 按钮 + Enter 触发、whitespace-only 不发请求、结果渲染、无结果空态、API 抛错回退空数组
- pick → load picked anime episodes → ← 返回搜索
- onConfirm — current 路径回 `null` anime,search 路径回 picked anime 对象

**测试模式备忘:**
- Worker 测试用 `class MockWorker` 收所有 instance,`__respond({data})` 手动驱动 onmessage,`await act(async () => ...)` 刷 Promise.then 微任务
- Cancellable Promise pattern (`{ promise, cancel }`) 比直接传 `AbortSignal` 更适合 worker 场景:cancel 是同步的,可以原地 settle
- defensive handler nullify 是 worker 重构的标配 —— 不能信任 `terminate()` 单独完成清理

**结果:**
- 客户端:`npx vitest run` 全绿 — **71 files / 593 tests** (相比 v1.0.7 +3 文件 / +47 cases)
- 服务端:`npx jest` 全绿 — **31 files / 273 tests** (无变更)
- 合计:**102 文件 / 866 tests**
- PlayerPage 状态机 churn 来源消除 —— 切集 race + blob 泄漏 + 字幕残留三个面向收敛到 `usePlaybackSession` 一个所有者

**为什么值得记一笔:**
- 真实 race bug 修了:之前用户连切两集,前集 mkv.worker 5s 后回包能污染当前集字幕,这是 production 行为不是 refactor 引入的,借抽 hook 顺手治
- 字幕仲裁纯函数化是 `mkvSubtitle.worker.js` (263 行 0 测试) 后续补覆盖率的入口
- DanmakuPicker 357 行 0 测试 → 32 测试,UI 文案/交互改动现在会被立刻 fail 捕到
- PlayerPage churn 在 v1.0.6 retro 里被点名:本周 7 次改 EpisodeFileList + 10 次改 PlayerPage 大半都是手动同步 6 个 useState。这次重构后,后续切集相关 bug 应该收敛到 `usePlaybackSession` 单点

### 提交记录

- `f0e04db` refactor(player): extract usePlaybackSession + resolveSubtitle from PlayerPage
- `8cb2033` test(player): cover DanmakuPicker — 32 tests across 7 behavioral groups
- 设计文档:`docs/designs/playerPage-state-machine.md` (含 mermaid as-is/to-be 状态机图、不变量清单、YAGNI 边界)

---

## [1.0.7] - 2026-04-18

### 测试覆盖扩张 — 从关键路径走向全栈覆盖

**背景：**
- 此前测试集中在核心 hooks、AuthContext、关键 controller/service/model，大量 UI 组件、pages、schema-only 模型、socket 入口未触达
- 客户端缺少对 home/detail 页次级 section 的渲染断言，dandanplay/播放链路上的小组件（`EpisodeNav`/`MatchProgress`）无 spec
- 服务端 socket.io 的引导路径（cors、auth、每包 token 过期中间件）完全未测

**新增测试文件（20 个）：**

*客户端 `client/src/__tests__/`（19 个，逐个验证通过）：*
- `ContinueWatching.test.jsx` — 登录门、loading/空态、`/anime/:id` 链接、进度条裁剪
- `HeroCarousel.test.jsx` — 空列表、indicator、自动轮播 + 暂停、prev/next 按钮
- `WeeklySchedule.test.jsx` — 日 tab 切换、per-day 计数、score/airing 格式化
- `CharacterSection.test.jsx` / `StaffSection.test.jsx` — 中日英命名策略、CV 区块开关、role 映射
- `RelationSection.test.jsx` / `RecommendationSection.test.jsx` — `ORDER` 排序、titleChinese 偏好、点击/Enter 导航
- `CompletedGems.test.jsx` / `SeasonRankings.test.jsx` — refresh invalidate、episode badge、rank 分段染色
- `AnimeStats.test.jsx` — 计算热门 genre/season、donut 中心总数、空态三路 divider
- `EpisodeNav.test.jsx` / `MatchProgress.test.jsx` — EP 补零、active 禁点、step status 图标映射
- `ForgotPasswordPage.test.jsx` / `ResetPasswordPage.test.jsx` — mismatch 校验、success navigate、服务端 error message 透传
- `SearchPage.test.jsx` / `SeasonPage.test.jsx` — URL param 同步、Show More 增量、genre/format/status 过滤
- `FollowListPage.test.jsx` / `ProfilePage.test.jsx` — 返回导航、tab 切换触发 hook 重调、列表搜索 + 无匹配态

*服务端 `server/__tests__/`（1 个）：*
- `socket.index.test.js` — `Server` 构造 cors 默认/env 注入、`io.use(socketAuth)`、connection handler 注册、per-packet 过期中间件分路径断言（过期 → `auth:expired` + disconnect；有效 → `next()`）

**顺手修复的既有 flaky 测试：**
- `ScrollToTop.test.jsx` 第二集：`setTimeout(navigate)` 未被 `act(...)` 包裹导致 scrollTo 只统计到 1 次，改成 `useEffect` 触发 + `await act(async () => render(...))`，稳定到 2 次
- `useAdmin.test.jsx` 的 `useEnrichmentList` 断言：hook 签名已扩展到 5 个参数，`toHaveBeenCalledWith(1, 'missing', 'naruto')` 不再匹配，补齐 `undefined, undefined`

**测试模式备忘：**
- `ContinueWatching`/`HeroCarousel` 等只做渲染/交互断言的组件，全部走 `vi.mock('../context/LanguageContext', ...)` + `vi.mock('../hooks/*')` 隔离外部依赖，不再拉起 `QueryClientProvider` + `LanguageProvider`
- 导航断言统一走 `MemoryRouter` + `<Route path="*" element={<LocationProbe />}>` pattern，比 `mockNavigate` spy 更贴近真实行为
- schema 校验直接用 `Model.schema.indexes()` / `Model.schema.paths`，不连 MongoDB
- socket 测试 mock 掉 `socket.io` 的 `Server`，抓 `on('connection', ...)` 的 handler 手动触发，断言 per-packet 中间件逻辑分支

**结果：**
- 客户端：`npx vitest run` 全绿 — **68 files / 546 tests**
- 服务端：`npx jest` 全绿 — **31 files / 273 tests**
- 合计：**99 文件 / 819 tests**，本 session 期间新增 20 文件、修 2 个 pre-existing flaky

**为什么值得记一笔：**
- 覆盖了用户肉眼能看到的每个主要 UI section（home/detail/profile/search/season/password flow/follow list），对未来视觉或文案改动会立刻被 fail 捕到
- socket 入口有 auth/过期两条分支的 regression net，以后换 JWT 库或调 cors 不会静默出错
- 顺手消除的 flaky 测试避免 CI 间歇性红灯（act warning 下只通过一半）

### 提交记录

- 本次改动限于 `client/src/__tests__/*.test.jsx` 与 `server/__tests__/socket.index.test.js`，无生产代码变更

---

## [1.0.6] - 2026-04-18

### CSP 放行 blob: 让本地视频在生产环境恢复播放

**症状：**
- 生产域名 `animegoclub.com` 上用户拖入本地 mp4/mkv，ArtPlayer 只显示黑幕加播放按钮，点击无响应
- 开发者工具 console 连 4+ 条 CSP 违规：
  - `Connecting to 'blob:https://animegoclub.com/...' violates "connect-src 'self' wss://animegoclub.com"`
  - `Fetch API cannot load blob:... Refused to connect because it violates the document's Content Security Policy`
  - `Creating a worker from 'blob:...' violates "script-src 'self'"`（worker-src 回退到 script-src）
  - 最终 `NotSupportedError: The element has no supported sources`
- 本地 `npm run dev` 正常，只有 nginx 反代后的生产环境触发

**根因：**
- `client/src/hooks/useVideoFiles.js:52` 用 `URL.createObjectURL(file)` 生成 `blob:https://animegoclub.com/...` URL 交给 ArtPlayer 的 `<video>` 元素
- `nginx/default.conf:73` 的 CSP 三处同时拦 blob：
  - `media-src` 未显式声明 → 回退到 `default-src 'self'`，`<video>` 无法加载 blob URL
  - `worker-src` 未显式声明 → 回退到 `script-src 'self'`，ArtPlayer 内部创建的 blob worker 被阻止
  - `connect-src 'self' wss://$host` 无 `blob:`，浏览器内部 Fetch 读 blob 字节流被拒
- 开发环境走 Vite dev server，没挂 nginx 头，所以观察不到

**修复：**
- `nginx/default.conf` CSP 补三条最小授权：
  - 新增 `worker-src 'self' blob:` — 单独声明避免 fallback 到 `script-src`，blob 只允许跑 worker，不打开可执行脚本口子
  - 新增 `media-src 'self' blob:` — 让 `<video>` 加载本地 blob URL
  - `connect-src` 列表插入 `blob:` — 让 Fetch 能读 blob 字节流
- 不改 `script-src 'self'`，保持内联脚本注入面不变
- 部署方式：只改 nginx 配置文件，VPS 上 `git pull && docker compose restart nginx`，无 app 容器重启，无停机

**附带：放行 Cloudflare Web Analytics beacon**
- CF 对走 proxy 的域名自动注入 `https://static.cloudflareinsights.com/beacon.min.js`，被 `script-src 'self'` 拦，Web Analytics 收不到 RUM 数据
- `script-src` 加 `https://static.cloudflareinsights.com`，`connect-src` 加 `https://cloudflareinsights.com`（beacon 上报端点）
- 换来 Core Web Vitals（LCP/INP/CLS）、按国家/设备的访问量、JS 错误率；免 cookie，不影响隐私合规

**安全权衡：**
- `blob:` URL 永远是同源浏览器内存对象，不引入跨域或外部脚本执行风险
- `worker-src 'self' blob:` 精确到 worker 场景，没顺手加进 `script-src`
- Cloudflare 两个域是官方边缘资源，信任边界明确

**验证：**
- 本机 `curl -sI https://animegoclub.com/ | grep -i content-security-policy` 确认线上头已包含 `worker-src 'self' blob:` / `media-src 'self' blob:` / `connect-src 'self' blob: wss://animegoclub.com https://cloudflareinsights.com` / `script-src 'self' https://static.cloudflareinsights.com`
- 实机在生产环境播放 `C1 Opening 1.mkv`，视频正常解码、字幕正常渲染、无 console 错误

### 提交记录

- `3d29f63` fix(nginx): allow blob: in CSP for media/worker/connect
- `4885a7d` fix(nginx): allow Cloudflare Web Analytics beacon in CSP

---

## [1.0.5] - 2026-04-18

### dandanplay 匹配成功后番剧信息富化降级

**症状：**
- 拖入本地文件夹（如 `/Volumes/T7 Shield/.../Akiba Maid Sensou`），dandanplay 成功匹配 7 集弹幕，页面却只显示标题 `秋叶原女仆战争` + 封面
- 评分、题材、工作室、制式、`查看详情` 按钮全部不渲染
- 同样的番剧走「关键字搜索」Phase 2 路径时富化正常，问题只在 Phase 1

**根因：**
- `POST /api/dandanplay/match` 的 Phase 1 combined /match 路径里，富化只用 `dandanplay.animeTitle`（中文）去 `searchAnimeCache` 命中 AnimeCache
- 用户文件夹名通常是英文/罗马音（`Akiba Maid Sensou`），AnimeCache 主键命中字段是 `titleRomaji` / `titleEnglish`，dandanplay 返回的中文 `秋叶原女仆战争` 未必出现在缓存文档里
- 单路径 miss 就直接返回 `siteAnime: null`，前端 `EpisodeFileList.jsx` 的 `{sa && (...)}` 优雅降级成「裸标题+封面」

**修复：**

1. **`findSiteAnime(title, userKeyword)` 3 级降级** — `server/controllers/dandanplay.controller.js` 新增 helper：
   - ① `searchAnimeCache(dandanplay title)` 命中即返回
   - ② 未命中 → `searchAnimeCache(user keyword)` 命中即返回（REGRESSION 修复点）
   - ③ 仍未命中 → `bangumi.fetchBangumiData(title, userKeyword)` 拿 `bgmId` → `AnimeCache.findOne({ bgmId }).lean()`
   - 全部 miss 返回 `null`，`matched:true` 不受影响

2. **bgm.tv 超时 + 异常吞掉** — 第 3 步包在 `Promise.race` 里，`BGM_FALLBACK_TIMEOUT_MS = 2000`，`.catch(() => null)` 兜住任何 `fetchBangumiData` 抛错。bgm.tv 挂 / 5xx / 网络慢 都不会卡 `/match`，最多延迟 2s 返回 `siteAnime: null`

3. **`bangumi.service.js` 导出 `fetchBangumiData`** — 之前是模块私有函数，controller 拿不到，测试也 mock 不了

**测试：**
- 新增 `server/__tests__/dandanplay.controller.test.js`（6 用例）：title 命中 / keyword 降级命中（REGRESSION）/ bgmId 降级命中 / 全 miss 返回 null / `fetchBangumiData` 抛错吞掉 / 永挂 2s 超时
- 实机验证：`Akiba Maid Sensou` 文件夹现在渲染 `★ 7.4 · BGM ★ 6.6 · TV · 已完结 · 12 集 · 秋季 2022 · Action/Comedy/Drama · 查看详情 →`，与 Phase 2 路径一致

**设计文档：** `docs/designs/implementDandanplay.md` 新增「Phase 1 番剧信息富化降级（siteAnime）」小节，记录 3 级降级顺序和超时保护

**已知限制（写入 TODO.md）：** `enqueueEnrichment` 以 `anilistId` 做队列键，bgmId-only 的番剧暂时进不了后台富化。Phase 1 的实时降级已覆盖主要用户路径，后台富化队列的扩展留作 P2 改进

### 提交记录

- `8f12d9c` fix(player): enrich siteAnime when dandanplay title misses AnimeCache

---

## [1.0.4] - 2026-04-17

### 修复 token 过期时 401 级联导致的 React 崩溃

**症状：**
- access token 过期后进入弹幕播放页，控制台连续报 `/api/auth/refresh` 401、两条 `/api/dandanplay/comments/xxx` 401，紧接着 React minified error #300 和 #520，整棵树白屏
- 未登录用户打开播放页也触发同一链路（弹弹 play 数据是公开的，不该绑登录）

**根因链：**
1. access token 过期 → `comments` 请求 401
2. axios 响应拦截器调用 `/auth/refresh` → refresh cookie 也已过期，再 401
3. 同步栈内 `setAccessToken(null)` + `dispatchEvent('auth:expired')` + `Promise.reject`
4. `AuthContext` 监听器同步 `setUser(null)`
5. `ProtectedRoute` 看到 `!user` 立即 `<Navigate to="/login">`，`PlayerPage` 开始卸载
6. 此时 `useDandanComments` 的 catch 分支还在跑 `setState`，对一个正在卸载的组件写状态 → React #300（render 期间 update 另一个组件）
7. 另一条 pending 请求同步走完 catch，触发 #520 包裹错误

**修复（方案 D 全量落地）：**

1. **公开端点去掉 auth gate** — `server/routes/dandanplay.routes.js` 四个路由（`match` / `search` / `comments/:episodeId` / `episodes/:animeId`）是弹弹 play 的透传代理，本身无用户态，不需要登录。移除 `authenticateToken`，游客也能看弹幕。IP 级 `apiLimiter`（300 req/min）已经兜底抗刷。

2. **`auth:expired` 派发延后到 microtask** — `client/src/api/axiosClient.js` 的 refresh 失败分支，把 `window.dispatchEvent(new CustomEvent('auth:expired'))` 包进 `queueMicrotask(() => ...)`。`setUser(null)` 不再发生在 axios reject 的同步栈里，卸载路由的时机也就不会撞到仍 pending 的 setState。

3. **`useIsMounted` + 异步 setState 护栏** — 新增 `client/src/hooks/useIsMounted.js`（useRef + useEffect 清理）。`useDandanComments` 和 `useDandanMatch` 所有 await 点后、catch/finally 里的 `setState` 调用前，先 `if (!mounted.current) return;`。组件卸载后 async 回调静默退出，不再触发警告。

4. **401 静默处理** — 两个 hook 的 catch 里，遇到 `err.response?.status === 401` 时重置 state 并 `return`，不把 401 当错误往 UI 抛。401 的登出流程由全局 `auth:expired` 事件统一处理，hook 自己不该重复报。

**测试：**
- 新增 `client/src/__tests__/useDandanComments.test.jsx`（6 用例）：happy path、静默 401、非 401 错误仍冒泡、卸载后 pending resolve 不 setState、`clearComments` 重置、falsy episodeId 短路
- 新增 `client/src/__tests__/axiosClient.test.js`（3 用例）：用 `vi.hoisted` 捕获拦截器 handler，验证 microtask 延迟派发、非 401 直通、refresh 端点自身 401 不再递归

### 提交记录

- `c58e09e` fix(player): stop 401 cascade from crashing react tree on token expiry

---

## [1.0.3] - 2026-04-17

### 播放器字幕大小与位置滑块

**动机：**
- MKV 内嵌字幕默认 20px，在 1080p 以上分辨率上偏小，用户反馈看不清
- 字幕默认紧贴进度条（`bottom: ~10px`），被控制条和进度条遮挡

**实现：**
- Artplayer 齿轮菜单新增两项原生 `range` 滑块（`settings[]` 内置 API，零新依赖）：
  - **字幕大小**：14-48px，步长 2，默认 20
  - **字幕位置**：距底部 10-200px，步长 5，默认 60（把字幕抬离进度条）
- tooltip 实时跟随滑块当前值（`"28px"` / `"120px"`）
- `localStorage` 持久化（key：`animego:subtitleFontSize` / `animego:subtitleOffset`），跨集、跨会话保持
- 读取时 `clamp(value, min, max)`，历史越界数据自动拉回合法区间，不崩
- 换集时 `art.subtitle.switch(url, { style: ... })` 重新应用当前字号和位置，避免 Artplayer 切字幕轨重置 style

**重构：**
- 提取 `readNumberPref` / `writeNumberPref` 通用 localStorage 访问函数，字号和位置共用
- `VideoPlayer.jsx` 新增 `subtitleOffsetRef`，与 `subtitleSizeRef` 并列

**测试：**
- 新增 `client/src/__tests__/VideoPlayer.test.jsx`（6 个用例）
- 覆盖：默认值、localStorage 读写、越界 clamp、slider onChange、换集保持
- mock Artplayer 构造函数捕获 config，断言 `subtitle.style` 和 `settings[].range`

### 提交记录

待提交。相关文件：
- `client/src/components/player/VideoPlayer.jsx`
- `client/src/__tests__/VideoPlayer.test.jsx`

---

## [1.0.2] - 2026-04-17

### 番剧详情页新增弹幕播放入口

**「▶ 弹幕播放」按钮：**
- 番剧详情页在「磁力资源」旁新增播放入口，点击在新标签页打开本地弹幕播放器
- 文案从通用「播放」改为「▶ 弹幕播放」，明确与 VLC 等通用播放器的差异（弹幕是核心卖点）
- `window.open('/player', '_blank', 'noopener,noreferrer')`：新标签页隔离，防止 `window.opener` 反向访问详情页
- `aria-label` 包含「在新标签页打开」提示，满足 WCAG 3.2.5（屏幕阅读器点击前可预知行为）

**按钮行视觉与交互统一：**
- 抽出 `OutlineButton` 组件复用给 Share 和 Torrent,新增完整 hover/focus 状态机（边框 65%→90%、文字 60%→92%、微弱背景、`translateY(-1px)` 抬起、灰色 focus ring）
- 所有按钮高度统一到 40px(`padding: '10px 18px'`、`minHeight: 40`),满足 iOS HIG 触控目标
- 主 CTA(蓝色 Play)靠颜色而非尺寸突出,行内节奏均衡,过渡曲线 150ms 一致
- 父容器改用 `gap: 12` 统一水平间距,移除子级 `marginLeft` 避免重复计算导致的节奏不均

**空番剧防御：**
- 未开播番剧(`episodes === 0`)时 Play 和 Torrent 共用条件一起隐藏,避免"播放不了"的孤儿按钮出现在 Share 旁边

**i18n：**
- 新增 `detail.openPlayer` / `detail.openPlayerAria` 中英文键值

### 提交记录

待提交。相关文件：
- `client/src/pages/AnimeDetailPage.jsx`
- `client/src/locales/zh.js`
- `client/src/locales/en.js`

---

## [1.0.1] - 2026-04-17

### 播放器稳定性修复 + DanmakuPicker 统一 + 生产上线

**Hook-order 崩溃修复：**
- 移动端早期 return 移到所有 hooks 之后；窗口缩放跨越 600px 不再抛 "Rendered fewer hooks than expected"
- 通过 state + resize listener 驱动，响应式行为保留

**MKV 字幕 blob 内存泄漏修复：**
- 用 ref 追踪 blob URL，在替换、换集、卸载时统一 `URL.revokeObjectURL`
- 长会话切换多部 MKV 不再持续吃内存

**播放体验增强：**
- 自动连播：`VideoPlayer.onEnded` 自动跳到映射的下一集
- 弹幕加载指示器：顶栏 badge 显示 1-3s fetch 进度，避免用户误以为无弹幕
- 进度记忆：按 animeId + 集数 localStorage 存取 `currentTime`（30 天 TTL，5s 节流，末 10s 不记录以免跳过片尾）

**DanmakuPicker 架构统一：**
- 之前 `EpisodeFileList` 和 `PlayerPage` 各自挂一个 picker，跨列表 ↔ 播放视图时搜索词和 tab 状态丢失
- 现在提升到 `PlayerPage` 单一挂载，由 `pickerEp` state 驱动；`EpisodeFileList` 只发 `onSetDanmaku(epNum)` 事件
- 移除死代码 `useDandanMatch.goManual`（自 `3f2c854` 以来未被使用）

**文档更新：**
- README 重写为 v1.0.0 版本，介绍 dandanplay 播放器能力与致谢
- TODO 待办十五（启动时扫描未富化番剧）标记为 v0.8.0 已完成
- TODO 待办十八（部署后 GSC 操作）标记完成：sitemap 确认、首页 + 2 个详情页请求编入索引、`/anime` 301 双 UA 验证

### 生产部署

- VPS `45.152.65.208` 更新到 `3415298`
- 三容器（app/nginx/mongodb）健康，season 缓存预热 SPRING 2026 共 89 部
- 生产域名 `https://animegoclub.com/` 返回 200

### 提交记录

| Hash | 描述 |
|------|------|
| `3415298` | refactor(player): unify DanmakuPicker and drop dead goManual export |
| `c1f042e` | docs: mark TODO 15 (sweepUnenriched) as completed |
| `8fc6de5` | fix(player): resolve hook-order crash, blob leak, and add UX polish |
| `1dd5c4e` | docs: rewrite README for v1.0.0 with dandanplay player and credits |

---

## [1.0.0] - 2026-04-17

### 弹幕手动设置 + SEO 修复

**弹幕源手动选择器（DanmakuPicker）：**
- 每一集新增「设置弹幕」入口（💬 按钮），支持在匹配列表和播放状态下随时更换弹幕源
- 双标签模式：「当前番剧」直接切换集数，「搜索其他番剧」可搜索任意动画后选集
- 搜索标签打开时自动用文件解析关键词预搜索，不会出现空白状态
- 选择新番剧后自动传播：后续所有集的弹幕选择器默认使用新番剧的集数列表
- Modal 标题显示当前番剧名，方便辨识
- 键盘支持：ESC 关闭、Tab 导航、Enter 选择

**SEO 修复：**
- 消除重复内容信号：季度页 canonical 加 `?year=&season=` 参数，详情页移除多余 `keywords` meta
- TV 动画启用 `contentRating` 富文本片段（PG-13、R-17+）

**导航栏优化：**
- 播放页滚动 50px 后导航栏自动隐藏，回到顶部才重新出现

### 提交记录

| Hash | 描述 |
|------|------|
| `3fac2b4` | style(player): show anime title in DanmakuPicker modal header |
| `3f2c854` | style(player): improve DanmakuPicker a11y and touch targets |
| `7f635b9` | feat(player): add per-episode danmaku source picker |
| `6c170ef` | fix(seo): eliminate duplicate-content signals and enable TV rating rich snippets |
| `481d573` | style: adjust navbar hide threshold to 50px |
| `c4b590f` | style: navbar only reappears when scrolled to top in player page |

---

## [0.9.6] - 2026-04-15

### 播放器设计审查 + 性能优化

**设计审查修复（/design-review）：**
- 封面图比例从 5:7 修正为 DESIGN.md 规定的 `3:4`，圆角从 10px 修正为 12px（`--radius`）
- 集数列表播放图标响应行悬停，hover 时变蓝（之前写死不变色）
- 所有播放器阶段（拖放/匹配/手动搜索/文件列表/播放中）加 fadeUp 入场动画（300ms）
- DropZone 重设计：emoji 📂 替换为 SVG 播放图标，背景改为 `#1c1c1e` 卡片底色，加边框脉冲空闲动画，宽度从 600px 扩至 720px
- 播放状态顶栏升级：毛玻璃背景（`backdrop-filter: blur`）+ Ghost 返回按钮 + 集标题显示 + 弹幕数 teal pill badge
- 移除播放器下方孤立的弹幕数文字行，整合到顶栏右侧

**导航栏播放适配：**
- 播放页向下滚动超过 50px 时导航栏自动隐藏（`translateY(-100%)`），滚回顶部才重新出现
- 导航栏与播放顶栏之间新增 16px 间距

**换集延迟消除：**
- MKV 内嵌字幕提取从阻塞 `await` 改为后台异步：点击换集后视频立刻播放，字幕提取完成后通过 `art.subtitle.switch()` 动态挂载
- VideoPlayer 的 useEffect 依赖从 `[videoUrl, subtitleUrl, subtitleType, subtitleContent]` 精简为 `[videoUrl]`，字幕变化不再触发播放器销毁重建
- 弹幕 API 请求与视频加载并行，不阻塞播放

### 提交记录

| Hash | 描述 |
|------|------|
| `68b52e7` | perf: eliminate episode switch delay by making MKV subtitle extraction non-blocking |
| `c42646a` | style: navbar auto-hide on scroll in player page, add spacing above play header |
| `1ca0e7d` | style(design): glass header with ghost back btn, episode title, danmaku badge |
| `df811b5` | style(design): redesign DropZone with SVG icon, card bg, pulse animation |
| `8f7b32f` | style(design): add fadeUp entrance animation to all player phases |
| `c1cd15a` | style(design): play icon highlights blue on row hover |
| `03f07e7` | style(design): fix cover aspect ratio to 3/4 and border radius to 12px |

---

## [0.9.5] - 2026-04-15

### 播放器匹配增强 + 站内番剧关联

**站内番剧信息展示：**
- dandanplay 匹配成功后，用番剧名称反查 AnimeCache，在播放页展示站内番剧信息（评分、BGM 评分、类型、状态、季度、制作公司、来源、Genre 标签）
- Phase 1（dandanplay 直接匹配）和 Phase 2（AnimeCache 关键词匹配）均支持
- 手动选择时同样携带站内番剧信息
- 新增「查看详情 →」按钮，新标签页跳转至站内番剧详情页

**续集集数匹配修复：**
- 文件列表始终发送至服务端（含 fileName + episode），不再依赖 hash 计算成功
- 逐文件匹配（`matchUnmappedFiles`）不再要求 fileHash，仅凭文件名即可调用 dandanplay match API
- 解决跨季连续编号（如 ep 13-23）无法匹配 dandanplay 按季编号（1-11）的问题：每个文件独立发送完整文件名，由 dandanplay 服务端识别具体集数

**播放列表改进：**
- 所有视频文件统一显示为可播放行，未匹配弹幕的文件同样可点击播放
- 移除底部「未匹配」文件堆砌区域
- 移除「重新匹配」按钮

---

## [0.9.4] - 2026-04-14

### 本地播放器：弹弹Play 弹幕匹配 + MKV 内嵌字幕

**弹弹Play 匹配流程重构：**
- 匹配改为 dandanplay-vi 的方式：前端预计算所有文件 MD5 hash（前 16MB），一次请求发送 hash + 文件名，不指定 matchMode 让 API 自动决策
- 三级降级匹配：Phase 1 hash+文件名 → Phase 2 AnimeCache 关键词 → Phase 3 逐文件 hash 回退
- 逐文件 hash 回退（`matchUnmappedByHash`）：对 `buildEpisodeMap` 无法按集号映射的集数，逐个用文件 hash 匹配弹弹Play，解决 OVA/特别篇等非标准集号的弹幕匹配
- 新增 `matchCombined()` 服务函数，整合 hash + 文件名发送到 `/api/v2/match`
- hash 回退添加去重检查，避免多集映射到同一个 dandanEpisodeId

**OVA/特别篇集号映射修复：**
- `buildEpisodeMap` 新增 `O{n}`/`S{n}` 匹配：对弹弹Play 集号为 "O1"、"O2"、"S1" 等 OVA/SP 集数，按数字部分映射到用户文件集号
- 保留原始 `rawEpisodeNumber` 字段用于 OVA 匹配
- 修复辉夜大小姐 OVA 两集显示相同标题的问题

**MKV 内嵌字幕提取：**
- 新增 `mkvSubtitle.worker.js`：Web Worker 解析 EBML/Matroska 结构，提取 ASS/SSA/SRT 字幕轨
- 支持 CodecPrivate（ASS 头部 + 样式）+ Cluster 块（Dialogue 行）的完整重建
- ASS 自动转换为 VTT 纯文本版本（`buildVttFromEvents`），去除 ASS 样式标签，通过 Artplayer 原生字幕显示
- 30 秒超时保护，大文件（600MB+）在浏览器中正常工作

**播放器 UI 改进：**
- 集列表每行下方显示弹弹Play 匹配的集标题（加粗）
- 「手动匹配」按钮始终可见，用户随时可重新选择番剧
- 容器宽度、封面尺寸、字体大小整体调大

---

## [0.9.3] - 2026-04-13

### SEO 索引修复

**解决 Google 96% 页面未索引问题（4,832/5,014 页）：**

**丰富爬虫 HTML 内容（核心修复）：**
- `/anime/:id` 页面从 2 行文字扩展为 8 个内容板块：作品信息（类型/集数/状态/首播/时长/原作/制作公司/别名）、标签、双评分（AniList + Bangumi）、角色与声优（最多 12 个）、制作人员（最多 8 个）、关联作品链接、相似推荐链接、剧集列表（最多 50 集）
- 新增中文翻译映射：FORMAT_CN、STATUS_CN、SEASON_CN、SOURCE_CN、RELATION_CN、ROLE_CN
- 目标：修复 1,149 个"已抓取 - 尚未编入索引"页面（Google 因内容太薄拒绝收录）

**Canonical URL 统一：**
- 所有爬虫页面改用固定 `SITE_URL` 而非请求头动态生成的 `base`，避免 http/https 或域名不一致
- 首页 canonical 加尾部斜杠，与 `index.html` 保持一致

**品牌搜索优化：**
- 首页正文加入 "AnimeGoClub (animegoclub.com)" 品牌文案
- 结构化数据添加 `alternateName: "AnimeGoClub"`（首页爬虫 HTML + index.html）
- 解决搜索 "animegoclub" 时首页不在第一位的问题

**robots.txt 完善：**
- 新增 Disallow：`/login`、`/register`、`/forgot-password`、`/reset-password`、`/profile`

**Sitemap 优化：**
- 排序从按时间改为按评分降序，高分动画优先被 Google 爬取
- 动态优先级：评分 80+ → 0.9、60+ → 0.8、40+ → 0.7、其余 → 0.6

**错误处理改进：**
- DB 查询失败时返回有意义的 fallback HTML，而非空 SPA shell（修复 4 个 5xx 错误页面）

---

## [0.9.2] - 2026-04-12

### SEO 增强

**Google 搜索 Favicon 修复：**
- 生成 `favicon.ico`（16/32/48 多尺寸 ICO 格式），解决 Google 搜索结果不显示图标问题
- 新增 `site.webmanifest` 声明图标信息（Google 推荐的图标发现方式）
- index.html 和 ogTags 中间件均添加 favicon.ico 和 manifest 链接

**结构化数据升级：**
- 动画页从通用 `WebSite` 升级为 `TVSeries`/`Movie` 等具体类型
- 添加 `aggregateRating`（评分/满分/评分人数），可触发 Google 星级富摘要
- 添加 `numberOfEpisodes`、`datePublished`、`genre`、`alternateName` 等字段
- 所有页面添加 `BreadcrumbList` 面包屑导航结构化数据

**标题格式优化：**
- 从 `AnimeGo - 动画名` 改为 `动画名 - AnimeGo`，内容优先提高点击率

**安全加固：**
- JSON-LD 输出中 `<` 转义为 `\u003c`，防止 XSS 注入

---

## [0.9.1] - 2026-04-11

### SEO 优化

**修复 Google 搜索结果无图片问题：**
- favicon.png 从 JPEG 转为真 PNG 格式，尺寸从 32x32 升级到 48x48（Google 最低要求）
- 新增 favicon-192.png（192x192，Google 推荐尺寸）
- 创建 og-default.png（1200×630 品牌 OG 图片），修复之前引用不存在文件的问题
- og:image / twitter:image 从相对路径改为绝对 URL
- ogTags 中间件首页/季度/搜索页补上默认 OG 图片（之前传空字符串）

**提升首页 SEO 权重：**
- 首页爬虫 HTML 从 2 行文字扩展为完整页面：导航链接、30 部热门动画（含评分）、15 个类型标签
- 添加 JSON-LD WebSite structured data（含 SearchAction）
- Google 现在能看到丰富的内部链接结构，而非空壳页面

**标题更新：**
- 网站标题改为「AnimeGo - 动漫 · 二次元 · 发现」

---

## [0.9.0] - 2026-04-11

### 追番体验优化

**在追卡片重设计：**
- 标题从卡片底部移入封面图内，使用渐变遮罩（`linear-gradient`）叠加在封面底部
- 进度条移至标题下方，背景改为半透明白色轨道 + 蓝色填充
- 移除卡片背景色和边框，视觉更干净

**自动完成/恢复：**
- 当集数 ≥ 总集数时，自动将状态切换为「已看完」
- 在集数控制上方显示内联完成提示（绿色 `已看完 ✓`），2.5 秒后淡出
- 当「已看完」状态减集数低于总集数时，静默恢复为「在看」

**剧集列表颜色逻辑：**
- 已看完状态：全部集数显示绿色
- 在看状态：已看的集显示绿色，当前集显示蓝色
- 修复最后一集看完后仍显示蓝色的问题

### 缓存一致性修复

**问题：** 管理后台修改中文标题后，本周更新仍显示旧标题。

**根因：** 双层缓存未清除。
- 服务端 `scheduleCache`（内存 Map，30 分钟 TTL）
- 客户端 React Query（`staleTime: 30min`）

**修复：**
- `admin.controller.js`：更新 titleChinese 时调用 `clearScheduleCache()` 清除服务端缓存
- `useAdmin.js`：`useUpdateEnrichment` 的 `onSuccess` 中 `invalidateQueries(['weeklySchedule'])` 清除客户端缓存

### 本周更新设计探索

制作了 7 个独立 HTML demo 评估不同布局方案：
- **A 时间轴流**：按播出时间垂直排列，时间线 + 圆点 + 已播/待播状态
- **B 横向滚动**：按天分列水平滚动，今天列高亮放大
- **C 杂志分栏**：Feature 大图 + Side 卡片 + 紧凑行列表
- **D 泳道视图**：每天一条泳道，卡片横向滚动
- **D2 日历 Bento**：7 列网格，每列一天
- **E 瀑布流卡片墙**：Masonry 布局，混合 tall/wide/square 比例
- **E2 当前设计微调**：保留现有网格，增加已播/待播状态和相对时间

所有 demo 使用数据库真实当季番剧数据（芙莉莲 S2、Re:Zero S4、JOJO 飙马野郎等）。

---

## [0.8.0] - 2026-04-10

### AniList 429 限流修复与历史回填

**问题：** `warmAllSeasons` 全量回填 2014–2026 共 50 个季度时，AniList API 返回 429 Too Many Requests，导致整季数据为空。

**429 自动重试：**
- `queryAniList` 读取 `Retry-After` 响应头，等待指定秒数后自动重试（最多 3 次）
- 每季之间插入 10 秒冷却，避免突发请求触发限流

**并发保护：**
- `warmAllRunning` 互斥锁，防止管理后台触发和定时任务同时运行 `warmAllSeasons`
- 重复调用直接跳过并打印警告

**数据验证：**
- 回填完成后与 AniList API 逐季对比，50 个季度共 5,547 部番剧，100% 匹配

### 可持续的季度更新策略

**问题：** 每年都有新番上架，新季度动态出现，如何保证数据时效性？

**启动 warm：**
- 服务启动时只 warm 当前季度（快速启动，~2 页数据）

**24h 定时刷新：**
- 每 24 小时自动 warm 当前年份所有季度 + 下一季度
- 覆盖场景：季度转换期新番、当前年历史数据更新、提前预热下季预告
- 例：2026 年 10 月（FALL），24h warm 覆盖 WINTER/SPRING/SUMMER/FALL 2026 + WINTER 2027

**cachedAt 过滤移除：**
- 季番列表查询路径 ① 移除 `cachedAt` 新鲜度过滤，避免旧数据被排除导致列表不完整
- 后台 warm 会刷新数据，前端始终展示最新可用数据

### 孤儿 v0 条目恢复

**问题：** 服务器重启后内存中的富化队列清空，导致已入队但未处理的 v0 条目永远卡在 v0。部署后发现 331 个孤儿条目。

**修复：**
- 启动时扫描 `bangumiVersion: 0` 的所有条目，自动重新入队到 Phase 1 管线
- 启动日志输出 `🔧 Re-enqueued N orphaned v0 entries for enrichment`

### 管理后台：Re-enrich 按钮

**功能：** Enrichment Status 进度条的 v0/v1/v2 标签旁新增 Re-enrich 按钮，与已有的 v3 Heal All 功能对齐。

**后端路由：**
- `POST /api/admin/enrichment/re-enrich?version=0|1|2`
- v0 → 重新入队 Phase 1（搜索 Bangumi）
- v1 → 重新入队 Phase 4（评分 + 角色 + 集数）
- v2 → 有 bgmId 的入队 V3 Heal；无 bgmId 的直接升版本到 v3（Bangumi 无此番剧，无法 heal）

**v2 无 bgmId 问题：**
- 1,455/1,456 个 v2 条目的 bgmId 为 null（Phase 1 在 Bangumi 搜不到匹配）
- V3 Heal 需要 bgmId 查 name_cn，这些条目无法入队，导致看起来"卡住"
- 修复：Re-enrich v2 时，无 bgmId 条目 `updateMany` 直接升到 v3

### 管理后台：富化表格排序

**功能：** 富化管理列表支持点击表头排序。

**可排序列：**
- AniList ID、标题（titleRomaji）、中文标题（titleChinese）、版本（bangumiVersion）、评分（bangumiScore）

**实现：**
- 后端 `listEnrichment` 接收 `sort` / `order` 参数，白名单校验排序字段
- 前端 `sortField` / `sortOrder` 状态，表头点击切换 asc ↔ desc，带排序方向指示箭头

### 数据架构说明

**全部走 MongoDB 永久层，无独立缓存：**
- `AnimeCache` collection 同时承担缓存和持久存储角色
- AniList 数据通过 `findOneAndUpdate(upsert)` 写入
- Bangumi 富化通过 `updateOne` 在同一条文档上叠加字段和升版本
- 内存中只有调度队列（`enrichMap` / `enrichPhase4Map` / `enrichV3Map`），不存实际数据
- 详情页访问时 TTL 7 天过期刷新，触发缺失字段补富化

### 提交记录

| Hash | 描述 |
|------|------|
| `2ba3b93` | fix: promote v2 entries without bgmId directly to v3 in re-enrich |
| `b7306e5` | feat: add sortable columns to admin enrichment table |
| `b289cfc` | feat: add re-enrich buttons for v0/v1/v2 in admin dashboard |
| `22c9bdb` | fix: re-enqueue orphaned v0 entries on startup after restart |
| `5eac2a2` | fix: 24h warm covers current year + next season for upcoming anime |
| `6a8b935` | fix: remove cachedAt filter from warmed path to prevent stale data exclusion |
| `c5ddff0` | fix: 24h scheduled warm covers all seasons of current year |
| `c9f94ce` | fix: replace startup backfill with 24h scheduled re-warm |
| `256bd8a` | fix: auto-retry on AniList 429 with Retry-After header, add mutex |
| `92c1dde` | fix: add retry with backoff to warmAllSeasons for AniList 429 |
| `d4b1419` | feat: backfill all historical seasons on startup |
| `1eaeda9` | feat: add warm-all-seasons admin endpoint for historical backfill |
| `e7e984b` | fix: resolve season page title flash and perPage cap |

---

## [0.7.2] - 2026-04-09

### 反镜像站防护

**问题发现：**
- Google 搜索 AnimeGo 出现 `bokeba.com` 而非 `animegoclub.com`
- 该站抓取/反代了 AnimeGo 的内容，因域名年龄更久排名更高

**Host 检查中间件：**
- 新增 Host header 白名单校验，拒绝非授权域名的请求（返回 403）
- 白名单默认 `animegoclub.com,localhost`，可通过 `ALLOWED_HOSTS` 环境变量扩展
- 支持子域名匹配（`*.animegoclub.com` 自动通过）

**robots.txt 增强：**
- 新增 `Host: https://animegoclub.com` 指令，声明权威域名

**AnimePGT AI 助手规划：**
- `FUTURE.md` 新增 AI agent chat 完整规划（架构、工具、分阶段实现、模型候选）
- 包含 Codex (GPT-5.4) 可行性审查结果和范围裁剪建议

### 提交记录

| Hash | 描述 |
|------|------|
| `1878940` | fix: block unauthorized host domains and add robots.txt Host directive |
| `83e73f7` | docs: add AnimePGT AI agent chat feature plan |

---

## [0.7.1] - 2026-04-09

### 域名与 SEO 修复

**域名错误修复：**
- `sitemap.js` 默认域名从 `animego.site` 改为 `animegoclub.com`，之前 Google 抓到的全是错误域名
- `index.html` 的 `<link rel="canonical">` 同步修正
- 修复后 Google Search Console 成功读取 sitemap（1,148 个页面）

**Google Search Console 接入：**
- 添加 `/googlec1c1aceafd3279a2.html` 验证路由（Express 路由返回，非静态文件）
- 所有权验证通过，sitemap 提交成功

### 安全加固

**敏感文件清理：**
- 从 GitHub 移除 `CHANGELOG.md`、`CLAUDE.md`、`.claude/`、`scripts/setup.sh`（含 SSH 端口等部署信息）
- `.gitignore` 新增以上路径 + `*.archive`（数据库备份）
- 文件仅从 git tracking 删除，本地保留

### 数据库备份

- 通过 `mongodump --archive` 导出 VPS MongoDB 到本地（2.3MB）
- 当前数据量：1,145 条 animecaches（2.3MB），其余集合合计 < 3KB

### 文档

- README 重写，反映当前全部功能（弹幕、角色、V3 自愈、Docker 部署、SEO）
- 新增 `README.zh.md` 中文版，GitHub 顶部语言切换链接

### 提交记录

| Hash | 描述 |
|------|------|
| `617a810` | chore: ignore database backup archives |
| `d8b035e` | docs: add Chinese README with language toggle |
| `df43631` | docs: rewrite README with current features |
| `404e8dd` | feat: add Google Search Console verification route |
| `a4ff5cc` | fix: update domain from animego.site to animegoclub.com |
| `5039dbe` | chore: remove sensitive files from tracking |

---

## [0.7.0] - 2026-04-09

### V3 中文标题自愈系统

Phase 1-3 搜索 Bangumi 时需要日文名精确匹配才取 `name_cn`，导致大量有 `bgmId` 但无中文标题的番剧。V3 阶段直接用 `bgmId` 调 `/v0/subjects/{bgmId}` 获取 `name_cn`，自动补全。

**富化管线扩展：**
- `fetchBangumiTitleCn(bgmId)` — 直接通过 bgmId 查 Bangumi subject 获取 `name_cn`
- V3 队列系统 — 与 Phase 1-3 / Phase 4 相同的优先队列架构（`enrichV3Map` + `enrichV3Priority`）
- Phase 4 完成后自动入队 — `processPhase4Queue` 检测 `titleChinese == null && bgmId` 后自动推入 V3
- `getAnimeDetail` 缓存命中自愈 — `bangumiVersion === 2 && bgmId && !titleChinese` 时以 priority 入队 V3
- 已有中文标题的条目 — V3 处理时直接升版本号，不发 API 请求

**管理后台进度监控：**
- Enrichment Status 进度条新增 v3 (蓝色 `#5ac8fa`) 分段
- `getQueueStatus()` 返回三个队列实时深度 + V3 批量进度 (`total` / `processed` / `healed` / `paused`)
- **Heal All 按钮** — `POST /api/admin/enrichment/heal-cn` 批量查找 `bgmId != null && bangumiVersion ∈ [2,3) && titleChinese == null` 并入队
- **进度条动态显示** — 条纹流动动画（`linear-gradient 135deg` + `background-position` 循环），V3 运行中 2 秒轮询，百分比实时更新
- **暂停/继续** — `POST heal-cn/pause` / `heal-cn/resume`，暂停时进度条变橙色 + PAUSED 标签
- `VersionBadge` 颜色区分 — v3+ 蓝色、v2 绿色、v1 橙色、v0 红色
- **缺中文标题筛选** — `no-cn` filter，管理员可快速定位缺标题的条目

**TanStack Query v5 兼容修复：**
- `refetchInterval` 回调签名从 `(data)` 修正为 `(query)`，数据通过 `query.state.data` 访问
- 影响 `useAdminStats`、`useAnimeDetail`、`useSeasonalAnime` 三个 hook

### 季度页 Show More

替换分页为 "显示更多" 按钮，一次请求整季全部数据（`perPage=200`），客户端控制可见数量。

- 初始显示 20 部（4 行 × 5 列），每次点击追加 20 部
- 全部展示完后按钮自动消失
- 切换季度/筛选条件时重置为初始数量
- `useSeasonalAnime` 支持 `perPage` 参数

### SEO 基础设施

SPA 应用对搜索引擎不友好（空 `<div id="root">`），补全 SEO 基础：

**`index.html` 增强：**
- `<title>` / `<meta description>` / `theme-color` / `canonical`
- Open Graph + Twitter Card 默认值（首页分享卡片）

**动态 sitemap (`/sitemap.xml`)：**
- 自动包含所有 AnimeCache 番剧详情页 URL（最多 5000 条）
- 带 `lastmod`（来自 `cachedAt`）、`changefreq`、`priority`
- 1 小时内存缓存

**`/robots.txt`：**
- 允许全站爬取，禁止 `/admin` 和 `/api/`
- 指向 sitemap

**ogTags 中间件扩展：**
- 新增匹配 Googlebot / Bingbot / Baiduspider / YandexBot / DuckDuckBot
- 支持 `/`（首页）、`/season`（季度页）、`/search`（搜索页），不再仅限 `/anime/:id`
- 统一 `sendOgHtml` 函数，包含 `<meta description>` + `<link rel="canonical">`

**客户端动态 `document.title`：**
- 详情页：`葬送的芙莉莲 第二季 — AnimeGo`
- 季度页：`2026年春季新番 — AnimeGo`
- 离开页面时恢复默认标题

### 提交记录

| Hash | 描述 |
|------|------|
| *pending* | feat: V3 中文标题自愈 + 管理后台进度监控 + 季度页 Show More + SEO |

---

## [0.6.0] - 2026-04-08

### 香港 VPS 部署上线

**基础设施：**
- Docker 多阶段构建 — Stage 1 编译客户端（Vite build），Stage 2 仅运行 server + 生产依赖
- `docker-compose.yml` 三服务架构：app（Node.js）、mongodb（mongo:7，wiredTiger 缓存限 0.4GB）、nginx（反向代理）
- Nginx 反向代理配置 — WebSocket upgrade（Socket.IO）、Cloudflare 真实 IP 透传（`set_real_ip_from`）
- 自签名 SSL 证书 + Cloudflare Full 模式（443 端口 HTTPS）
- UFW 防火墙（17776 SSH / 80 HTTP / 443 HTTPS）
- `scripts/setup.sh` 一键初始化 Debian 12（Docker、git、UFW）

**域名：** animegoclub.com — Cloudflare Registrar + DNS（A 记录 proxied）

### 生产环境 Bug 修复

- **Resend API 崩溃** — `new Resend(undefined)` 启动即抛异常，改为条件初始化 + 未配置时静默跳过
- **弹幕发送无响应** — JWT payload 字段为 `userId`，danmaku handler 用了 `socket.user.id`，修正为 `socket.user.userId`
- **弹幕框发完收缩** — `DanmakuOverlay` 在 `items.length === 0` 时 return null 导致容器坍塌，移除提前返回
- **角色/配音中文名未显示** — `warmCurrentSeason` 不抓角色数据，`getAnimeDetail` 缓存命中时空角色被视为新鲜缓存跳过；Phase 4 对已 v2 记录不重试。修复：stale 检查加入 `!characters?.length`，Phase 4 skip 条件加入 `needsCharCn` 检查，缓存命中分支增加角色缺失时重新入队逻辑

### 管理后台增强

- **富化内容手动编辑** — `PATCH /api/admin/enrichment/:anilistId` 支持修改 `titleChinese`、`bgmId`、`bangumiScore`，自动标记 `manually-corrected`
- 管理后台富化表格新增行内编辑 UI（编辑/保存/取消按钮，与用户管理同样交互模式）

### 其他

- 站点标语更新为「Rundle Streetが暮れる。東京が灯る。」
- Footer GitHub 链接指向真实仓库地址

### 提交记录

| Hash | 描述 |
|------|------|
| `b5098dd` | feat: add Docker deployment config for Hong Kong VPS |
| `4f4e78f` | fix: gracefully handle missing Resend API key in production |
| `900ef0b` | fix: add HTTPS (443) to Nginx for Cloudflare Full SSL mode |
| `2466895` | fix: use correct JWT field name (userId) in danmaku handler |
| `5e88820` | fix: keep danmaku overlay area visible when no items are flying |
| `d508656` | fix: re-fetch from AniList when characters missing, re-run Phase 4 for CN names |
| `6e6c65c` | feat: add inline enrichment editing in admin dashboard |
| `bf0823b` | chore: update site tagline and footer GitHub link |

---

## [0.5.0] - 2026-04-07

### 首页内容丰富化

**新增区块：**
- **经典好番推荐 (Completed Gems)** — Bilibili「猜你喜欢」风格，5 列网格，封面全铺 + 底部渐变遮罩叠加标题/类型/评分，"换一批"按钮随机刷新
  - `GET /api/anime/completed-gems?limit=6` — MongoDB `$sample` 随机采样高分完结番（≥75 分）
- **年度评分排行榜 (Yearly Rankings)** — Editorial 紧凑列表，Top 10 按评分降序，Top 3 金色排名数字
  - `GET /api/anime/yearly-top?year=2026&limit=10` — 查 AnimeCache 全年 TV/MOVIE/ONA 按评分排序

**视觉统一：**
- `AnimeGrid` 从 `auto-fill minmax(160px)` 改为固定 5 列网格（900px→3 列，600px→2 列），季度页/搜索页同步生效

**UX 改进：**
- 路由切换自动滚顶 — `ScrollToTop` 组件监听 `pathname` 变化调用 `window.scrollTo(0, 0)`

**首页排列顺序调整：**
Hero → 热追 → 我的在追 → 本周更新 → 经典好番 → 关注动态 → 年度榜

**已创建后删除的功能（代码已清理）：**
- 类型精选 (Genre Spotlight) — 硬编码类型列表不够灵活，待改为动态热门类型后重做
- 制作公司精选 (Studio Spotlight) — 封面比例问题 + 偏高级功能，延后

---

## [0.4.0] - 2026-04-07

### Bug 修复

- **Shimmer 骨架屏动画不可见** — `@keyframes shimmer` 动画 `background-position` 对纯色背景无效，6 处骨架屏全部改为渐变背景 + `backgroundSize: '200% 100%'`（`AnimeDetailHero`, `EpisodeList`, `TrendingSection`, `ActivityFeed`）

### 代码质量

- **Follow controller DRY 重构** — `getFollowers`/`getFollowing` 提取公共函数 `paginateFollows`，消除重复逻辑
- **AnimeDetailHero 样式重构** — 30+ 内联样式提取到模块级 `S` 常量对象，提升可读性
- **新增骨架屏单元测试** — `AnimeDetailHero.test.jsx` 6 个测试覆盖中英文模式、富化中/完成/未富化场景

### 新功能：管理后台

**RBAC 基础设施：**
- `User.role` 字段（enum: `'admin'` / `null`）
- JWT 三路径（register/login/refresh）携带 role 到 accessToken
- `adminAuth` 中间件，非管理员返回 403

**仪表盘概览（`GET /api/admin/stats`）：**
- 8 路并行 `countDocuments` 汇总：用户数、番剧数、追番记录、关注关系、待审查数
- 富化进度条可视化（v0/v1/v2 占比）

**富化管理：**
- `GET /api/admin/enrichment` — 分页列表 + 4 种筛选（全部/需审查/已修正/未富化）+ 搜索（数字匹配 anilistId，文本匹配三语标题）
- `POST /api/admin/enrichment/:id/reset` — 重置 bangumiVersion=0，清除富化字段，优先重新入队
- `POST /api/admin/enrichment/:id/flag` — 设置/清除 adminFlag（needs-review / manually-corrected / null）
- `AnimeCache.adminFlag` 字段 + 索引

**用户管理（CRUD）：**
- `POST /api/admin/users` — 创建用户，用户名/邮箱重复检测返回 409
- `PATCH /api/admin/users/:id` — 编辑用户名/邮箱，重复检测
- `DELETE /api/admin/users/:id` — 删除用户 + 级联清理（Subscription + Follow），禁止自删
- `GET /api/admin/users` — 分页列表 + 搜索 + MongoDB aggregate 批量统计追番数/粉丝数

**前端：**
- `AdminDashboard.jsx` — 三板块 UI：仪表盘概览 / 富化管理（搜索+筛选+分页表格） / 用户管理（创建表单+行内编辑+两步确认删除）
- Navbar 管理员入口（仅 `role === 'admin'` 可见）
- 中英文本地化 ~70 个 key

**测试：**
- `admin.controller.test.js` — 22 个测试覆盖：adminAuth 403、stats、enrichment list/filter/search/reset/flag、user list/create/update/delete/self-delete-prevention/duplicate-detection
- 服务端 124 tests、客户端 95 tests 全部通过

### 提交记录

| Hash | 描述 |
|------|------|
| `f88dcb7` | fix: repair shimmer animations and refactor follow controller + detail hero |
| `af4b41c` | feat: add admin dashboard with enrichment management and user CRUD |

---

## [0.3.0.0] - 2026-04-05

### 方向决策（CEO Review + Office Hours）

- **产品方向待验证** — Phase 1-4 功能完整但零真实用户。通过 CEO Review 确认：在没有用户数据前不做新功能开发，先验证需求
- **核心假设重新定义** — 创始人自我审视后认为产品核心不是"社交平台"，而是"观影伴侣"：看完一集后轻量参与的情绪价值（类似 B 站弹幕体验）
- **dandanplay 集成方向** — dandanplay 有播放+弹幕但无社区，AnimeGo 有社区但无播放。组合可能是差异化方向，决定做独立 PoC 验证

### 计划：10 人验证 + dandanplay PoC

**验证期（2 周）：**
1. 部署现有 Phase 1-4 到 Railway 生产环境
2. 招募 10 个追番朋友实际使用，观察留存和行为
3. dandanplay API 申请 + 独立 HTML PoC（本地视频播放 + 弹幕匹配）
4. 收集反馈数据，决定下一步方向（追番社区 vs 看番平台）

**Pre-deploy checklist：**
- `server/.env` 生产配置（独立 JWT_SECRET、MongoDB Atlas URI）
- `app.set('trust proxy', 1)`（Railway 反向代理 TLS 终止必需，否则 secure cookie 不生效）
- httpOnly cookie secure 标志 + HTTPS
- Express morgan 生产日志开启
- 不开启 Railway autoscaling（单实例 Socket.IO，10 人规模）

**成功标准：** ≥30% 留存（第二周仍在使用）、≥5 条功能反馈、dandanplay API 可行性确认

**失败预案：** 留存不达标 → 转向 dandanplay 集成方向（需独立验证）

### 设计文档

- Office Hours 设计文档：`~/.gstack/projects/.../lawrence_li-feat-community-phase4-design-20260405-121020.md`
- CEO Plan：`~/.gstack/projects/.../ceo-plans/2026-04-05-validation-direction.md`
- 审查评分：设计文档 8/10（2 轮对抗性审查）、Outside Voice 发现 6 个问题（trust proxy 已修复）

---

## [0.2.2.0] - 2026-04-03

 ### Changed
  - **角色 & 配音演员名固定显示日文** — `CharacterSection` 移除语言适配逻辑，`nameJa`/`voiceActorJa` 始终优先，不再因语言设置切换为中文名
  - **Bangumi 标题匹配精确化** — `fetchBangumiData` 从 `list[0]` 改为在最多 5 条结果中寻找 `name === titleNative` 的精确匹配；仅精确命中时才写入
  `titleChinese`，非精确匹配仍保留 `bgmId` 但不写中文标题，避免续集 OVA 等变体污染正片翻译


### Fixed
- **bgmId 为 null 时客户端无限轮询** — Phase 1-3 搜索不到番剧时（新番未被 Bangumi 收录），原来写 `bangumiVersion: 1`，Phase 4 因 `!bgmId` 跳过，`bangumiVersion` 永远停在 1，客户端每 4 秒轮询死锁。现在直接写 `bangumiVersion: 2, episodeTitles: []` 标记完成
- **历史卡记录自愈** — `getAnimeDetail` 缓存命中时检测 `bangumiVersion === 1 && !bgmId` 的残留记录，自动推进到 version 2，无需重启或手动干预

### Performance
- **详情页秒开（placeholderData）** — `useAnimeDetail` 新增 `placeholderData`，优先从 seasonal/trending/search 的 React Query 缓存中查找该番数据；有 placeholder 时 `isLoading = false`，从列表点进详情页立刻渲染，无 loading spinner
- **富化优先队列** — `bangumi.service.js` 为 Phase 1-3 和 Phase 4 各增加 `enrichPriority` 数组；`enqueueEnrichment(items, priority)` 和 `enqueuePhase4Enrichment(items, priority)` 支持 `priority` 参数；`getAnimeDetail` 调用时传 `priority = true`，用户主动点击的番剧从队尾插到队首，等待时间从 60s+ 降至 ≤800ms；Phase 1-3 的 priority 项完成后，Phase 4 继承 priority

---

## [0.2.1.0] - 2026-04-02

### Fixed
- **历史季度中文标题缺失** — `getSeasonalAnime()` 路径③（部分缓存）和路径④（冷启动）新增 `enqueueEnrichment()` 调用，历史季度番剧现在在首次访问后会触发 Bangumi 富化
- **第一页中文标题不更新** — `useSeasonalAnime` 新增条件轮询（`refetchInterval: 20s`），当页面中存在 `bangumiEnriched: false/undefined` 的条目时自动轮询，富化完成后无需手动刷新即可看到中文标题，全部富化完成后自动停止轮询

### Changed
- `useSeasonalAnime` `staleTime` 从 5 分钟缩短为 1 分钟，确保富化完成后下次访问能及时拿到中文数据
- `SeasonPage` `AnimeGrid` 添加 `key={dataUpdatedAt}`，季度切换时新数据到达触发 `fadeUp` 动画，所有卡片同时出现而非逐个替换

---

## [0.2.0.0] - 2026-04-02

### Added
- **社区 Phase 1：趋势发现** — `GET /api/anime/trending` 热追排行榜（订阅数聚合，1h 内存缓存）；`GET /api/anime/:anilistId/watchers` 在看用户头像列表
- **社区 Phase 2：社交图谱** — 单向关注系统（`POST/DELETE /api/users/:username/follow`）；公开个人主页 `/u/:username`；关注者/关注列表；好友动态 Feed（`GET /api/feed`）
- **社区 Phase 3：实时弹幕** — WebSocket（socket.io）弹幕系统，按 `anilistId:episode` 隔离房间；`EpisodeWindow` 集合原子化首播窗口（`$setOnInsert` 消除竞态）；1 条/5s 用户级内存限流；JWT Handshake + 每事件重验（`TokenExpiredError` 精准识别）
- **iOS Blue 设计系统** — `#0a84ff` 替换全站紫色系；Apple True Black 三层背景（`#000000 → #1c1c1e → #2c2c2e`）；DESIGN.md 设计规范文档
- **WCAG 触控区域修复** — 弹幕颜色、语言切换按钮、轮播圆点、日期筛选标签均 ≥44px
- **磁力搜索重设计** — 入口迁至番剧详情页，三源并发（动漫花园 + acg.rip + Nyaa），集数筛选器，字幕组识别
- **测试基础设施** — Vitest（client）+ Jest+Supertest（server）；新增 17 个测试文件，共 81 条用例（ActivityFeed、FollowButton、danmaku.controller、follow.controller、profile.controller 等）
- `TrendingSection` 组件（首页横向卡片）；`WatchersAvatarList` 组件（番剧详情页）；`FollowButton`；`ActivityFeed`；`DanmakuOverlay`；`DanmakuInput`；`DanmakuSection`；`UserProfilePage`；`FollowListPage`
- `Danmaku` 模型（含 1 年 TTL 自动清理索引）；`EpisodeWindow` 模型；`Follow` 模型
- i18n：新增 `social.*`、`danmaku.*` 键组（中英双语）
- `useDanmaku`、`useSocial` hooks；`social.api.js`、`danmaku.api.js`
- CLAUDE.md 架构文档；docs/designs/community-platform-v2.md 设计决策记录

### Fixed
- `danmaku:join` 移入 `socket.on('connect', …)` 回调，修复重连后房间订阅丢失
- `follow.controller.js` 自关注检测改用 `ObjectId.equals()`，修复字符串与 ObjectId 比较误判
- `comment.controller` 内容长度校验改为 `content.trim().length`，修复含尾随空格内容被误拒（400）
- 弹幕 `lastSent` Map 添加 10k 上限防内存无限增长；`danmaku:join` 加参数校验 + 10 房间上限
- 弹幕历史接口加 500 条上限并倒序取最近（`.sort(-1).limit(500).then(reverse)`）
- `torrentCache` LRU 500 条上限；查询长度上限 200 字符防缓存投毒；RSS `magnet:` 协议校验
- `useFeed` 添加 `enabled: !!user` 防止未登录时发起请求
- `useSubscription` 静默处理 404（未订阅用户不抛错）
- `AuthContext` 使用 `useRef` 防止 React 18 StrictMode 下双重初始化
- `FollowButton` 关注/取消关注后显示 toast 反馈；`minWidth: 88px` 防按钮宽度抖动
- `ActivityFeed` 未登录时隐藏；空动态时显示友好提示文案
- `profile.controller.getProfile` 订阅列表上限 200 条；`getFeed` 关注列表上限 500 条

### Changed
- `server/index.js` 改用 `http.createServer` + `server.listen`，Socket.IO 绑定同端口
- 全站 success 色从 `#34d399` 统一为 Apple `#30d158`；次要文字从 `#475569` 统一为 `rgba(235,235,245,0.30)`
- `DanmakuSection` 标签色改用 teal `#5ac8fa`（符合 DESIGN.md 弹幕分区规范）
- `SeasonSelector` / `ProfilePage` tab 背景从 `rgba(26,34,53,0.8)` 统一为 `#1c1c1e`

---

## [0.1.5.0] - 2026-03-28

### Added
- **测试覆盖扩充** — 新增 5 个测试套件（48 → 48 个用例）：`EpisodeList` 高亮边界条件（6）、`LanguageContext` 回退行为（4）、`TrendingSection` 状态（4）、`WatchersAvatarList` 显示逻辑（5）、`comment.controller` 权限与内容校验（7）
- `UserProfilePage` 番剧列表"显示更多"分页（默认 12 部）
- `test/setup.js` 添加 `localStorage` mock，解决 jsdom 环境下 `LanguageContext` 语言初始化问题

### Fixed
- `UserProfilePage` `ShareButton`：`navigator.clipboard.writeText` 现在有 try/catch，剪贴板权限被拒时弹出错误 toast 而非静默失败
- `DanmakuInput` `handleSend()` 添加 `!connected` 防卫，修复通过 form 提交绕过 disabled 按钮的边界情况
- `comment.controller` 内容长度校验改为 `content.trim().length`，修复含尾随空格的合法内容被误拒（400）问题
- `UserProfilePage` `expanded` 状态在切换用户时（路由参数变化）正确重置
- `LanguageContext.test` 每个用例前清空 `localStorage`，防止测试间语言状态泄漏
- `test/setup.js` localStorage mock 添加 `configurable: true`，避免多线程测试池下重定义报错
- `UserProfilePage` 补充缺失的 `useState`/`useEffect` React 导入
- `zh.js`/`en.js` 新增 `detail.linkCopyFailed` 翻译 key

---

## [0.1.4.0] - 2026-03-28

### Added
- **磁力搜索重设计** — 入口从全局搜索迁移至番剧详情页，支持集数筛选器（全部/01/02…），字幕组识别从标题方括号提取
- `GET /api/anime/torrents` 新增第三方源：动漫花园（dmhy）+ Nyaa.si，三源并发 `Promise.allSettled`，任一失败不影响其他结果
- **iOS Blue 设计系统** — 全站 `#0a84ff` 替换紫色系，Apple True Black 三层背景（`#000000 → #1c1c1e → #2c2c2e`）
- WCAG 触控区域修复：弹幕颜色、语言切换按钮、轮播圆点、日期筛选标签均≥44px

### Fixed
- `danmaku:join` 事件移入 `socket.on('connect', …)` 回调，修复重连后房间订阅丢失问题
- `follow.controller.js` 自关注检测改用 `ObjectId.equals()`，修复字符串与 ObjectId 比较误判
- 弹幕 `lastSent` Map 添加 10k 上限防内存无限增长；新增 `username` 非空校验
- `torrentCache` 增加 500 条上限 LRU 淘汰；查询长度上限 200 字符防缓存投毒
- RSS `magnet:` 协议校验（acg.rip + Nyaa），阻断 `javascript:` / `data:` URI 注入
- followers/following 路由注册补全

### Changed
- **弹幕 `liveEndsAt` 竞态修复** — 引入 `EpisodeWindow` 集合（唯一索引 `{anilistId, episode}`），用 `findOneAndUpdate + $setOnInsert` 原子化首播窗口创建，消除并发首条弹幕竞态
- **Socket JWT 过期断连** — `socket.use()` 每事件重验 JWT，过期时 emit `auth:expired` 并断开连接；客户端监听后触发统一登出流程
- `danmaku.controller.js` `liveEndsAt` 改从 `EpisodeWindow` 读取，历史弹幕不再携带冗余字段

---

## [0.1.3.0] - 2026-03-25

### Added
- **社区 Phase 3：实时弹幕** — WebSocket（socket.io）弹幕系统，按番剧+剧集隔离房间
- `Danmaku` model：`{ anilistId, episode, userId, username, content, liveEndsAt }`，含 `(anilistId, episode, createdAt)` 复合索引
- `socketAuth` 中间件：JWT Handshake 验证，连接时附加 `socket.user`
- `danmaku.handler.js`：`danmaku:join/leave/send` 事件处理，1条/5秒用户级内存限流，2小时首播窗口（`liveEndsAt`）
- `GET /api/danmaku/:anilistId/:episode`：HTTP 历史弹幕接口，返回弹幕列表 + `liveEndsAt`
- `DanmakuOverlay` 组件：4 条泳道飞行弹幕，CSS `right→left` 动画，自动清理已播完元素
- `DanmakuInput` 组件：50字上限，字符计数器，WebSocket 连接状态指示灯（绿/灰）
- `DanmakuSection` 组件：HTTP 历史 + 实时消息合并去重，LIVE 绿色徽章，首播窗口关闭后显示只读提示
- `useDanmaku` hook：`useDanmakuHistory`（TanStack Query）+ `useDanmakuSocket`（socket.io-client）
- i18n：新增 `danmaku.*` 键组（中英文）
- `server/index.js`：改用 `http.createServer` + socket.io 绑定同端口
- `EpisodeList`：剧集展开面板顶部插入 `DanmakuSection`，评论区保留在下方

### Changed
- `server/index.js`：`app.listen` → `http.createServer(app)` + `server.listen`

---

## [0.1.2.0] - 2026-03-25

### Added
- **社区 Phase 2：关注系统** — `POST/DELETE /api/users/:username/follow`，单向关注模型，`Follow` 集合含 `(followerId, followeeId)` 唯一索引
- **公开个人主页** — `GET /api/users/:username`，含追番列表（按状态分组）、粉丝/关注数、`isFollowing` 字段（需 JWT，可选）
- **关注者/关注列表** — `GET /api/users/:username/followers` 与 `/following`
- **好友动态 Feed** — `GET /api/feed`，返回已关注用户近 40 条追番动态，按更新时间倒序
- `FollowButton` 组件：关注/取消关注切换，未登录重定向到 `/login`，自身主页隐藏
- `ActivityFeed` 组件：首页好友动态列表，含时间相对显示（timeAgo）
- `UserProfilePage` — `/u/:username` 公开主页，含渐变头像、粉丝/关注跳转、分享按钮、追番列表分 Tab 展示
- 分享按钮：`AnimeDetailPage` 和 `UserProfilePage` 均集成 `navigator.share()` + 剪贴板回退
- `optionalAuth` 中间件：有效 JWT 附加 `req.user`，无 token 静默跳过
- i18n：新增 `social.*` 键组（中英文），含 `follow`、`followers`、`feedLabel`、`action_*` 等
- `client/src/hooks/useSocial.js`：`useUserProfile`、`useFollow`（TanStack Query mutation + cache invalidation）、`useFeed`
- `client/src/api/social.api.js`：对应 REST 封装

### Changed
- 首页布局：在 `ContinueWatching` 与 `WeeklySchedule` 之间插入 `ActivityFeed`
- `App.jsx`：注册 `/u/:username` 路由指向 `UserProfilePage`
- `server/index.js`：注册 `/api/users` 路由与 `/api/feed` 端点

---

## [0.1.1.0] - 2026-03-25

### Added
- **社区 Phase 1：热门排行榜** — `GET /api/anime/trending`，按订阅数聚合排名，1 小时内存缓存（TTL），最多返回 20 条
- **社区 Phase 1：在看用户** — `GET /api/anime/:anilistId/watchers`，返回正在观看的用户头像列表及总人数
- `WatchersAvatarList` 组件：彩色首字母圆形头像 + "+N 人" 溢出文本，展示在番剧详情页订阅按钮下方
- `TrendingSection` 组件：首页水平滚动热门卡片，含 shimmer 骨架屏加载态
- `AnimeCard` 支持 `rank` 和 `watcherCount` props：显示 `#N` 排名徽章和 👥 观看人数徽章
- i18n：新增 `home.trendingLabel`、`home.trendingTitle`、`anime.watchers`、`anime.watchersMore`（中英文）
- `Subscription` 模型新增 `anilistId` 索引（优化 trending 聚合查询）
- 服务端测试：新增 `getTrending` 和 `getWatchers` 的 6 个 Jest+Supertest 单元测试（覆盖 happy path、参数校验、边界情况）

### Changed
- 首页布局：在 `ContinueWatching` 上方插入 `TrendingSection`
- 番剧详情页：在 `SubscriptionButton` 下方插入 `WatchersAvatarList`

---

## [0.1.0.0] - 2026-03-25

### Added
- 弹幕/评论删除：改用内联确认 UI，替换浏览器原生 `window.confirm()` 弹窗
- 评论发布失败时显示内联错误提示（`postError`）
- 种子搜索 5 分钟内存缓存（Map + TTL），减少对 acg.rip 的重复请求
- 测试基础设施：client 使用 Vitest + @testing-library/react（9 个测试），server 使用 Jest + Supertest（6 个测试）
- `docs/designs/community-platform-v2.md`：社区平台三阶段设计文档（含 CEO / Eng / Design Review 评审结论）
- 版本追踪：创建 `VERSION` 文件（`0.1.0.0`）

### Changed
- 种子数据源：从 Anime Garden 切换至 acg.rip RSS（`anime.controller.js`）

### Removed
- `client/src/utils/constants.js` 中的 `SEASON_LABELS` 对象（无消费者）
- `client/src/components/subscription/StatusBadge.jsx`（未被使用）

---

## 2026-03-07

### 18:26 · 初始化项目

- 创建 GitHub 仓库 `lawrenceli0228/animego`，配置 SSH 认证
- 写入 `.gitignore`（保护 `.env`、`node_modules`）
- 写入项目架构说明 `README.md`
- 配置 `.claude/launch.json` 开发服务器启动项

---

### 18:58 · 完成全栈代码开发（64 文件 / 7775 行）

**后端 · Express + MongoDB Atlas**

- `server/index.js` — Express 入口，CORS + Cookie 配置
- `server/config/db.js` — Mongoose 连接 MongoDB Atlas
- `server/models/` — User（bcrypt 加密）、AnimeCache、Subscription
- `server/services/anilist.service.js` — AniList GraphQL 代理 + MongoDB 缓存
- `server/controllers/` — 认证（JWT 双 Token）、番剧、订阅
- `server/routes/` — `/api/auth`、`/api/anime`、`/api/subscriptions`
- `server/middleware/` — JWT 验证、限流、错误处理

**前端 · React 18 + Vite**

- 暗色电影风格 UI（`#0a0e1a` 深海军蓝 + `#7c3aed` 紫 + `#06b6d4` 青）
- 页面：首页、季度、番剧详情、搜索、登录、注册、个人追番
- 组件：AnimeCard / AnimeGrid / 订阅按钮 / 季度选择器 / 搜索栏 / 分页
- TanStack Query 管理服务端状态，axios 自动刷新 Token

---

### 19:08 · 修复 AniList API 429 限流

**问题：** 每次请求都直接打 AniList，触发 90次/分钟限制

**修复（`anilist.service.js`）：**

- `getSeasonalAnime` — 优先读 MongoDB 缓存，命中则跳过 AniList 请求
- `searchAnime` — 新增内存缓存，相同搜索 10 分钟内不重复请求
- `queryAniList` — 加出站限速，两次请求间隔 ≥ 700ms（≈85次/分钟）

**涉及文件：**
- `server/services/anilist.service.js`

---

### 19:17 · 修复页面无限刷新死循环

**问题根因：**

```
无 cookie → /auth/refresh 返回 401
→ axios 拦截器捕获 → 再调一次 refresh → 失败
→ window.location.href = '/login'  ← 触发整页重载
→ AuthContext 重新挂载 → 再调 refresh → 无限循环
```

**修复：**

- 拦截器跳过 `/auth/refresh` 自身的 401（防套娃）
- 移除 `window.location.href` 硬跳转，改为派发 `auth:expired` 自定义事件
- `AuthContext` 用原生 `axios` 调 refresh，不触发拦截器
- `AuthContext` 监听 `auth:expired` 事件，优雅清除登录状态

**涉及文件：**
- `client/src/api/axiosClient.js`
- `client/src/context/AuthContext.jsx`

---

### 19:22 · 改为访客友好模式，无需强制登录

**需求：** 用户打开网站直接显示番剧内容，不强制跳转登录页

**修复：**

- `AuthContext` 拆分 `initializing`（启动 session 检查）和 `loading`（登录/注册操作中）两个独立状态
- `ProtectedRoute` 改用 `initializing` 判断，session 检查完成前不提前重定向
- `LoginPage` / `RegisterPage` 新增：已登录用户访问时自动跳回首页

**访客浏览流程：**

```
打开网站 → 首页番剧立即渲染
         → 后台静默检查 session（~200ms）
         ├── 有 session → Navbar 显示用户名和追番入口
         └── 无 session → 访客模式，Navbar 显示登录/注册按钮
仅 /profile 需要登录，其余页面全部公开访问
```

**涉及文件：**
- `client/src/context/AuthContext.jsx`
- `client/src/components/common/ProtectedRoute.jsx`
- `client/src/pages/LoginPage.jsx`
- `client/src/pages/RegisterPage.jsx`

---

---

## 2026-03-08

### · 根本修复缓存翻页与 429 限流（`fix: cache pagination and rate limit with full season pre-fetch`）

**问题：** 翻到第 2 页及以后返回空数组；每次翻页仍打 AniList 存在 429 风险

**修复：**

- 新增 `warmSeasonCache(season, year)` — 服务器启动后后台预热整个季度（每页 50 条全量写入 MongoDB）
- `getSeasonalAnime` 改为 4 级降级策略：已预热 MongoDB → 未预热时实时拉取 → 内存缓存兜底
- `server/index.js` 服务器就绪后异步触发 `warmCurrentSeason()`，不阻塞启动

**涉及文件：**
- `server/services/anilist.service.js`
- `server/index.js`

---

### · 首页新增每周放送日历（`feat: add weekly airing schedule to homepage`）

- 新增 `/api/anime/schedule` 接口，从 AniList 拉取本周 7 天播出计划，按本地日期分组，30 分钟内存缓存
- 新增 `WeeklySchedule` 组件：日期标签页（今天高亮）+ 当日番剧竖向列表（封面、集数、播出时间、评分）
- 前端 `localToday()` 用客户端本地时区计算今日日期，避免 UTC 时差错位

**涉及文件：**
- `server/queries/weeklySchedule.graphql.js`（新增）
- `server/controllers/anime.controller.js`
- `server/routes/anime.routes.js`
- `client/src/components/anime/WeeklySchedule.jsx`（新增）
- `client/src/hooks/useAnime.js`
- `client/src/api/anime.api.js`

---

### · 首页改版：Hero 轮播图 + 每周卡片网格（`feat: replace homepage grid with top-5 hero carousel`）

- 移除首页番剧方格，改为当季评分前 5 轮播图（`HeroCarousel`）：全宽 banner、Ken Burns 缩放、5 秒自动切换、悬停暂停、方向箭头、点状指示器
- 每周更新从竖向列表改为横向卡片网格（`auto-fill, minmax(140px, 1fr)`），每张卡片含封面（3:4）、标题、集数标签、时间、评分，悬停上浮效果

**涉及文件：**
- `client/src/components/anime/HeroCarousel.jsx`（新增）
- `client/src/components/anime/WeeklySchedule.jsx`（重构为卡片网格）
- `client/src/pages/HomePage.jsx`

---

### · 首页新增「继续追番」板块（`feat: add continue watching section to homepage`）

- 登录用户首页轮播图下方、每周更新上方新增横向滚动卡片条
- 展示当前状态为 `watching` 的全部追番：封面图 + 观看进度条 + 集数角标（已看/总集数）+ 标题
- 未登录或无在追番剧时自动隐藏，不占空间

**涉及文件：**
- `client/src/components/anime/ContinueWatching.jsx`（新增）
- `client/src/pages/HomePage.jsx`

---

### · 中英文切换 / 集数列表 / 磁力搜索 / 每集评论（`feat: add i18n, episode list, torrent search and episode comments`）

**中英文切换（i18n）**

- 新增 `LanguageContext.jsx` — 轻量级双语 Context，暴露 `t(key)` 和 `lang`，语言偏好持久化到 `localStorage`，默认中文
- 新增 `client/src/locales/zh.js` / `en.js` — 全站 UI 文案翻译字典（Navbar、首页、详情页、订阅、搜索、季度、登录/注册、集数评论等）
- Navbar 右上角新增 `中 / EN` 切换按钮，全站文案实时响应无需刷新

**集数列表**

- 新增 `EpisodeList.jsx` — 番剧详情页底部显示全部集数（自适应卡片网格）
- 已登录用户：已看集数绿色高亮，当前进度集数紫色高亮（数据来自 `useSubscription`）
- 每集卡片含集数编号 + 已看标记 + 磁链按钮
- `episodes` 为空时显示「集数信息待更新」友好提示

**磁力链接搜索**

- 新增 `TorrentModal.jsx` — 点击每集磁链按钮弹出全屏遮罩 Modal
- 后端 `GET /api/anime/torrents?q=` 请求 Nyaa.si RSS，`fast-xml-parser` 解析 XML，返回标题、磁链、大小、做种数
- 默认搜索词：`{titleEnglish || titleRomaji} + {episode}`；支持用户手动修改后重新搜索

**每集评论**

- 新增 `EpisodeComment` 数据模型（`anilistId + episode + userId + content`，双字段复合索引）
- 新增 REST 接口：`GET/POST /api/comments/:anilistId/:episode`（公开读 / 登录写）、`DELETE /api/comments/:id`（仅本人）
- 新增 `EpisodeComments.jsx` — 点击集数卡片手风琴展开评论区，同时只展开一集
- 已登录：文本框 + 发布按钮；访客：「请登录后参与评论」提示 + 登录跳转链接

**涉及文件：**
- `server/models/EpisodeComment.js`（新增）
- `server/controllers/comment.controller.js`（新增）
- `server/routes/comment.routes.js`（新增）
- `server/index.js`（注册 `/api/comments` 路由）
- `client/src/context/LanguageContext.jsx`（新增）
- `client/src/locales/zh.js` / `en.js`（新增）
- `client/src/components/anime/EpisodeList.jsx`（新增）
- `client/src/components/anime/TorrentModal.jsx`（新增）
- `client/src/components/anime/EpisodeComments.jsx`（新增）
- 全站各组件/页面接入 `t()` 双语支持

---

### · Bangumi 中文标题集成 + bgmId 外链（`feat: integrate Bangumi API for Chinese titles with bgmId linking`）

**中文标题后台富化**

- 新增 `server/services/bangumi.service.js` — 封装 Bangumi API（速率限制 800ms/请求），全局异步富化队列，不阻塞主请求
- `AnimeCache` 模型新增 `titleChinese`（String）、`bgmId`（Number）、`bangumiEnriched`（Boolean）三个字段
- `fetchBangumiData()` 搜索 `bgm.tv` 返回 `{ titleChinese, bgmId }`，优先用日文原名匹配
- `anilist.service.js` 三处调用 `enqueueEnrichment()`：季度预热、搜索结果、详情页懒加载；放送表额外批查 `titleChinese` 并合并

**前端中文标题显示**

- 新增 `pickTitle(obj, lang)` — 中文模式优先级：`titleChinese → titleNative → titleRomaji → titleEnglish`
- 5 个组件（AnimeCard / AnimeDetailHero / HeroCarousel / WeeklySchedule / ContinueWatching）全部切换使用 `pickTitle`

**bgm.tv 外链**

- 番剧详情页 `AnimeDetailHero` 徽章栏新增「在 Bangumi 查看 / View on Bangumi」外链按钮（红色主题，`target="_blank"`）
- 仅在 `bgmId` 非空时渲染，链接至 `https://bgm.tv/subject/{bgmId}`

**涉及文件：**
- `server/models/AnimeCache.js`（新增 3 字段）
- `server/services/bangumi.service.js`（新增）
- `server/services/anilist.service.js`（富化调用 + 放送表 titleChinese 拼接）
- `client/src/utils/formatters.js`（新增 `pickTitle`）
- `client/src/components/anime/AnimeDetailHero.jsx`（bgmId 外链）
- 5 个组件接入 `pickTitle`

---

### · 磁链搜索重构：接入 Anime Garden API + 三栏 UI（`feat: redesign torrent search with Anime Garden API`）

**数据源切换**

- 废弃 Nyaa.si RSS + XML 解析，改用 [Anime Garden API](https://api.animes.garden)（聚合 Nyaa.si + ACG.rip）
- API 直接返回预解析的 `fansub.name` 字段，覆盖 ANi、LoliHouse、SubsPlease 等中文字幕组
- 默认搜索词改为 `{titleRomaji} - {零补位集数}`（如 `Sousou no Frieren - 05`），匹配 Nyaa 命名惯例
- `formatBytes()` 处理 Anime Garden 以 KB 为单位的文件大小，正确转换为 MB/GB

**三栏弹窗重设计**

- 左侧栏：番剧名 + 字幕组过滤列表（自动聚合 + 按数量排序 + 数量 badge + 「全部/All」按钮）
- 中间列表：每条结果显示完整标题（单行省略）、分辨率 badge（1080P/720P）、编码 badge（HEVC/AVC/WEB-DL）、文件大小、日期
- 右侧：番剧封面图
- 复制磁链 ⎘ 按钮（点击变绿 ✓）+ 直接打开磁链 ↗ 按钮（唤起本地 BT 客户端）
- 切换字幕组时列表立即过滤；新搜索完成后自动重置为「全部」

**涉及文件：**
- `server/controllers/anime.controller.js`（重写 `getTorrents`，移除 XML 相关代码）
- `client/src/components/anime/TorrentModal.jsx`（完整重写）
- `client/src/locales/zh.js` / `en.js`（新增 `groupAll`、`openMagnet`、`date` 键）

---

## Git 提交记录

| Hash | 时间 | 说明 |
|------|------|------|
| `feb3ca6` | 2026-03-07 18:26 | Initial project setup: AnimeGo anime website |
| `5e8aa59` | 2026-03-07 18:58 | feat: implement full-stack AnimeGo anime website |
| `800f0ef` | 2026-03-07 19:08 | fix: resolve AniList 429 rate limit with cache-first strategy |
| `083d5ec` | 2026-03-07 19:17 | fix: resolve infinite page refresh loop on startup |
| `f11f453` | 2026-03-07 19:22 | fix: guests see content immediately, no forced login |
| `c459c6a` | 2026-03-08 | fix: cache pagination and rate limit with full season pre-fetch |
| `1585800` | 2026-03-08 | feat: add weekly airing schedule to homepage |
| `8df7df3` | 2026-03-08 | feat: replace homepage grid with top-5 hero carousel |
| `95eaeba` | 2026-03-08 | feat: add continue watching section and weekly grid layout |
| *(pending)* | 2026-03-08 | feat: add i18n, episode list, torrent search and episode comments |
| *(pending)* | 2026-03-08 | feat: integrate Bangumi API for Chinese titles with bgmId linking |
| *(pending)* | 2026-03-08 | feat: redesign torrent search with Anime Garden API |

仓库地址：`https://github.com/lawrenceli0228/animego`
