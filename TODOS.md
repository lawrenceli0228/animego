# TODOS

> 由 /plan-eng-review(2026-08-04,watch-folder 方案评审)首次生成。格式:What / Why / Pros / Cons / Context / Depends。

## 1. LibraryShell.tsx 拆分(存量债)

- **What:** 把 1240+ 行的 `next-app/src/app/library/_components/LibraryShell.tsx` 拆到 <800 行——导入编排、溢出菜单、可用性展示各自成模块。
- **Why:** 全局编码规则红线是 800 行,当前已超 55%;每个新功能都在往里堆(watch-folder PR-1 又 +~10 行)。现在拆比半年后拆便宜得多。
- **Pros:** 后续 library 迭代全部受益;接线层可测性改善;审查负担下降。
- **Cons:** 纯重构 PR,无用户可见价值;碰面大,需要完整回归(e2e library 两条 spec + 手测导入/播放链路)。
- **Context:** 2026-08 watch-folder 评审中发现的存量债,与该 feature 无阻塞关系。拆分时天然的切缝:handleAddFolder 导入编排、HudOverflowMenu items 构造、availability/probe 展示逻辑、ImportDrawer/pill 状态机。遵守"结构性与行为性改动分离"原则,单独 PR。
- **Depends on / blocked by:** 建议在 watch-folder PR-1/PR-2 合并后动手,避免同期冲突。

## 2. library 逻辑层测试债回填

- **What:** 给 `enumerator.js` / `fileHandleStore.js` / `useFileHandles.js` / `importPipeline.js` 全链路补单测。PR-1 只补被改到的部分(reuse 分支回归 + touchSeries + useImport 默认行为)。
- **Why:** 代码里预留的 DI seam(`useImport` 的 `{db, dandan, hashPool}`)从未被使用;全局规则要求 80% 覆盖率。
  > 事实更正(2026-08-22 评审):本条原写「整个 library 逻辑层只有 `buildLibraryMatchResult.test.js`
  > 一个测试文件」——已不成立。`_services/` 下现有 7 个测试文件(`rescanController`/`rematchPayload`/
  > `loadSeriesRows`/`rescanService`/`folderWatcher`/`resolveSeriesBinding`/`resolveMergedIds`)。
  > 仍缺的是 `enumerator.js` / `fileHandleStore.js` / `useFileHandles.js` / `importPipeline.js` 这条链。
- **Pros:** PR-2(改管线核心)/PR-3(observer)都有安全网;PR-1 会建好 fake DirectoryHandle(async-iterator 夹具)和 fake repo 层,回填时直接复用,边际成本低。
- **Cons:** 纯测试 PR,管线分支多(matchCache 命中/过期、reuse/new/ambiguous、跨文件夹 merge),工作量不小。
- **Context:** 测试跑法是 `bun test` 纯逻辑测试(无 RTL/jest/fake-indexeddb);仓库惯例是逻辑抽纯函数单测(authForm/registerFlow 模式)。importPipeline 可经 fake repos 测 processCluster,不需要真 Dexie。
- **Depends on / blocked by:** watch-folder PR-1 落地(复用其测试夹具)。

## 3. Dexie schema v6:fileRefs 加 [libraryId+relPath] 索引

- **What:** `next-app/src/lib/library/db/db.js` 追加 version(6),fileRefs 索引串在现有基础上追加 `[libraryId+relPath]`。
- **Why:** watch-folder 用全局 (relPath,size) 基线 + toArray 全表扫,当前规模(数百行)毫秒级完全够用;索引只在库上万行、或实现"relPath 消失条目清理"功能时才有收益。
- **Pros:** 加的时候只需一次 version bump,索引-only 变更无需 upgrade 函数;为失效条目清理铺路。
- **Cons:** 现在加是无收益 schema 变更,白承迁移风险。
- **Context:** ⚠️ 届时注意:Dexie 的 `version(N).stores({fileRefs})` 是整表替换不是合并——必须重声明**完整**索引串:`'id, episodeId, hash16M, matchStatus, [libraryId+matchStatus], *libraryIds, [libraryId+relPath]'`(2026-08 评审验证时确认,db.js 当前无裸 libraryId 索引)。
- **Depends on / blocked by:** 触发条件:库规模上万行,或"文件消失处置"产品决策落地为清理功能。

## backfill 队列的暂停 / 恢复控制

**What** — 给 `/admin` 的「中文简介」区块加一对暂停/恢复按钮，作用于 `description_backfill` 队列。

**Why** — 首次回填要连续跑约 31 小时。这期间如果 bgm.tv 出问题、或者发现写入有误想紧急刹车，目前唯一的手段是 SSH 上 prod 改数据库、或者重启容器——而重启会把在线富化一起停掉。独立队列的价值有一半就在「能单独停」，现在这半个价值还没接出来。

**Context** — P3 已经把 sweep 放进了独立队列（`internal/queue/control.go` 的 `DescriptionBackfillQueueName`），river 的 `QueuePause` 机制也已经在生产跑（V3 heal-CN 在用）。所以这件事是接线不是造轮子：
- 后端：`queue.PauseV3` / `ResumeV3` 旁边加一对同形函数，改队列名即可
- 前端：照抄 `_actions/enrichment-queue.ts` 里的 `pauseHealCn` / `resumeHealCn`
- 位置：`EnrichmentBar` 的「中文简介」区块已经留好了地方

**Depends on / blocked by** — 无。dashboard 只读部分（本次 PR）落地后即可做。

**为什么这次没做** — 它属于运维能力，不属于「看见进度」这个需求。分开做两边都更干净。

## anime-relations:字幕组连番号的精确重定向表

- **What:** 接入 [`erengy/anime-relations`](https://github.com/erengy/anime-relations),把字幕组连续编号的
  续季集号精确重定向到该季的 1..N,补上启发式归一覆盖不到的场景。
- **Why:** 本地库的显示层归一(`normalizeEpisodeNumbers`)是个保守推断——只在「本地最小集号
  已越过本季集数」且「构成连续段」时才平移。文件没下全、一季拆两个 cour、跨季混在同一
  文件夹这三种它会主动不动手,结果仍是网格前半截是死格子。
- **Pros:** 规则表是 **public domain**(比 `go-api/data/hant/` 那份 CC BY-SA 还干净,不存在
  AGPL 污染顾虑);2026-08 仍在维护;**规则里第三个 id 直接就是 AniList id**,正好是
  `anime_cache` 的主键,不需要中间跳转;约 1,000 条规则,压缩后几十 KB。
- **Cons:** 引入一个需要定期同步的外部数据集——和 `refresh-bgm-map` 同一个形状,而那个
  workflow 曾静默失败一个月无人察觉(见 issue #61/#62 的修复)。同步失败必须有告警,
  否则规则表会悄悄过期。
- **Context:** 规则语法 `MAL|Kitsu|AniList:范围 -> MAL|Kitsu|AniList:范围`,`!` 后缀表示
  同时生成一条自指规则,`~` 重复源 id,`?` 未知。两种接入方式:(a) 数据烤进构建产物,
  照 `go-api/data/hant/` 的模式——独立目录 + 独立 license 文件;(b) go-api 加一个
  `/api/anime/relations` 端点定期拉取并按 anilistId 索引,省客户端体积但多一次往返。
  备选数据集 `eliasbenb/PlexAniBridge-Mappings`(MIT,每日自动生成,AniList 主键)覆盖更全,
  但它解决的是 TVDB 季结构对齐而不是字幕组连番号,对这个场景是间接的,**不作首选**。
- **Depends on / blocked by:** 触发条件 = 显示层归一上线一个月后,统计仍有可观比例的
  卡片集号不对。在那之前不要动——先拿覆盖率数字。

## 导入抽屉:整个哈希阶段只显示一个静止的「准备中…」

- **What:** 拆掉 `useImport.js` 哈希阶段的 `Promise.all` 屏障,改成边算边吐行(下游本来就有
  `running` 状态);并在枚举结束时就把文件总数交给进度条,不必等哈希做完。
- **Why:** 现在第一行要等**所有**文件都哈希完才出现,而抽屉的空状态条件就是 `rows.length === 0`,
  所以整个哈希阶段界面是一个静止的「准备中…」,进度显示 `0 / —` ——**分母其实枚举完就知道了**。
  用户无法区分「在算」和「卡死」,唯一的判断办法是去看后端日志确认还没进匹配阶段。
  实测有人因此以为导入挂了。这是纯 UI/编排问题,管线本身是对的。
- **Pros:** 首行出现时间从「全部哈希完」降到「第一个文件哈希完」;进度条真的会动;
  不需要改哈希本身,也不需要动匹配逻辑。
- **Cons:** 边吐边算意味着行的顺序不再是枚举顺序,分组渲染要能接受乱序插入;
  失败重试的语义要重新想一遍(现在是屏障之后统一处理)。
- **Context:** 屏障在 `next-app/src/app/[lang]/library/_hooks/useImport.js` 的
  `await Promise.all(items.map(...pool.hash(item.file)))`;空状态在
  `_components/ImportDrawer.tsx` 的 `rows.length === 0` 分支。
  哈希池并发被 `lib/library/hashPool.js` 的 `MAX_POOL_SIZE = 4` 卡死,跟机器核数无关,
  所以耗时大致是 `文件数 ÷ 4 × (读前 16MB + MD5)`,走 File System Access API + Worker。
  **注意 `MAX_POOL_SIZE` 是刻意的上限,不要顺手调大** —— 先确认它当初为什么被压到 4。
- **Depends on / blocked by:** 无。与集数显示那条线无关,可独立做。

## go-api 的 Dockerfile 健康检查打的是一个不存在的路由

- **What:** `go-api/Dockerfile` 的 `HEALTHCHECK` 打 `/healthz`,但服务只注册了 `/health`
  (`cmd/server/main.go`)。改 Dockerfile 里的路径即可。
- **Why:** 那条 HEALTHCHECK **从来没成功过**,一直在 404。compose 起的容器之所以显示 healthy,
  是因为 `docker-compose.yml` 用 `/health` 覆盖了它。裸 `docker run` 这个镜像会永远 unhealthy,
  任何依赖镜像自带健康状态的编排(k8s、swarm、别人 pull 下来跑)都会拿到错误答案。
  副作用是每 2 秒往日志里写一条 404,把真实请求淹掉——排查时很误导。
- **Pros:** 一行改动;顺带让日志干净。
- **Cons:** 无。唯一要小心的是别反过来把路由改成 `/healthz` —— compose、
  部署脚本和文档都已经用 `/health`,改路由要同步改一圈,改 Dockerfile 只动一处。
- **Context:** 2026-08-22 本地起全栈时发现。`grep -rn 'healthz' go-api/` 能看到全部引用。
- **Depends on / blocked by:** 无。

## 匿名访客的访问量,后台完全看不到

- **What:** 从 nginx access log(或 Cloudflare Analytics / Logpush)离线统计未登录访客的
  页面访问量,写进一张日聚合表,在 `/admin` 的活跃度面板里单独开一块显示。
- **Why:** 活跃度面板每一个数字都按 `user_id` 统计 —— DAU/WAU/MAU、访问天数、留存,
  全部只覆盖已登录访问。而本站是 SEO 驱动的目录站,**流量大头是没有登录的**,
  所以后台看到的是一小块,不是全景。读到「今天 41 人活跃」时很容易忘掉这件事,
  尤其是半年以后。
- **Pros:** 请求路径上零成本 —— 日志本来就在产生,统计是离线的;Cloudflare 那一侧
  连边缘缓存命中的请求也能看见,而源站日志永远看不到那部分(命中时请求到不了源站)。
- **Cons:** 需要一个日志解析作业(river 定时);区分不了爬虫和真人,得自己维护 UA 过滤,
  而这份过滤会持续腐烂;CF Logpush 属于付费套餐,要先确认账号情况。
- **Context:** 这个缺口本来打算用一个浏览器 beacon(`POST /api/activity/beacon`)来填,
  在 2026-08-28 的评审里被砍掉了 —— 原因是 `/anime/*` 走 CF 边缘缓存,命中时请求根本
  到不了源站,而 beacon 是 POST(CF 从不缓存 POST),等于把「零源站负担」变成
  「每次真人浏览一个必然打到源站的请求」;它还会占用 `isPublicReadExempt` 只放行 GET
  的那个 per-IP 限流额度(1 rps / burst 60),可能把翻页快的读者 429 掉。
  日志路线是同一个需求的零请求成本实现。迁移 `0025_user_activity.up.sql` 的头注释里
  也写了同一句结论,两处可以互相印证。
- **Depends on / blocked by:** 无。与活跃度面板已有的部分完全独立,可以随时单独做。

## bangumi 绑定决策无法从存储状态重建

- **What:** 在 `anime_cache` 加一个 text 列(暂名 `bgm_match_name`),让
  `UpdateBangumiV1` 在绑定成功时把当时选中的 Bangumi 侧原名 `best.Name` 一并写下来。
  然后基于它做一次存量绑定审计。
- **Why:** 现在绑定成功只写回 `bgm_id` / `title_chinese` / `bgm_match_source` 三个字段,
  **Bangumi 侧的原名从来没被存下来**,全库也没有这个列。后果是一条已经存在的绑定,
  事后没办法回答「当时是拿哪个标题匹配上的」—— 也就没办法判断它对不对。
  `title_chinese` 只是部分代理:它在 `NameCN` 为空或等于 `Name` 时是 NULL,
  而且后续 v2/v3 富化可能已经改写过它。这是「bgm 绑定 41% 无来源」那笔债的
  结构性原因之一 —— 不是没记来源,是就算记了也无法复盘。
- **Pros:** 一个列 + 一个 UPDATE 字段,约 10 行;从此每条新绑定都可复盘,
  存量审计从「不可能」变成「一条 SQL」。
- **Cons:** 需要一条 migration(本仓已到 0026);按项目惯例写 migration 前要先走
  `database-migrations`;而且价值要到真的做存量 sweep 那一期才兑现,单独做收益为零。
- **Context:** 2026-08-28 的 `/plan-eng-review` 里发现(季号信号方案的 D3)。当时刻意
  没有并进那个 PR —— 那个改动是单文件纯逻辑、无 schema 变更、前向 only,加一条 migration
  会改变它的风险类别,而本仓 `description_cn` 那一轮用了 0014→0015→0016 三次才定下来。
  另一个必须一起想的点:`bangumi_v1` 只处理 `bangumi_version = 0` 的行,成功后置 1
  永不回头,所以存量行不会自己重新评估,审计和纠正都得单独写 sweep。
- **Depends on / blocked by:** 无技术前置。建议与存量绑定 sweep 同期做,否则加了列也没人读。

## 分割放送会 50% 概率绑错,而且标成高置信

- **What:** 给 `internal/bangumi` 的候选打分补上季号信号。**要先解一个包依赖环。**
- **Why:** `NormalizeTitle` 的 `seasonSuffixReplacer` 把 `season2..9` / `第2期..第9期` /
  `ii,iii,iv` / `part2..5` / `ova,movie` 全删掉,之后季号和格式**不再作为任何分量出现**
  (`ScoreCandidate` 只有 titleSim / yearScore / epsScore 三项)。分割放送下 S1 和 S2 同年
  同集数时两个候选得分**完全相同**,argmax 退化成「列表里谁在前面」,而档位规则 1
  (`ts≥0.95 && ys≠0`)立即命中 → 权威绑定。同一个陷阱对「剧场版 vs TV 版」也成立。
- **Pros:** 直接消掉一整类静默错绑;`titlematch` 已有 `ExtractMarker`/`MarkerFor`/`SameEntry`
  且在 live data 上被打磨过(`season.go:70-79` 记录了 anilist 213097 ↔ bgm 659686 的假阴性修复)。
- **Cons / 已知陷阱(2026-08-28 评审 + codex outside voice 找出来的,重写时别重踩):**
  1. **`internal/titlematch/titlematch.go:35` 已经 import 了 `internal/bangumi`**,
     所以 `bangumi/match.go` 不能反向 import —— 编译成环。
     ✅ **2026-08-28 已实测出解法,比预想便宜得多(0.5 人天,不是「跨包重构」)**:
     环的承重面只有 **一行** —— `titlematch.go:53` 的 `bangumi.TitleSimilarity`
     (全包 5 处提到 bangumi,其中 4 处是注释;`SearchResult` 一次都没出现,
     我最初的猜测是错的)。而 `season.go` 恰好**零仓库依赖**
     (只 import `regexp`/`strconv`/`strings`/`x/text/unicode/norm`)。
     → 把 `season.go` 原样搬成 `internal/titleseason`,在 `titlematch` 留一个
     `type Marker = titleseason.Marker` 的别名 shim + 三个 wrapper 函数。
     **实测:调用方 0 改动、测试 0 改动**,`titlematch` 的 30 个测试一字未改全绿,
     `dandanplay/seasonmatch.go` 和 `queue/bangumi_episodes.go` 也不用动。
     ⚠️ `Marker` 必须用**类型别名 `=`**,不能 `type Marker titleseason.Marker`
     ——后者不继承方法集,`SameEntry`/`Merge`/`Normalized` 会全没。
     ⚠️ shim 用 wrapper **函数**不要用 `var ExtractMarker = ...`(可变包级状态且不可内联)。
  2. 不要用字典序排序(confirmed > neutral > implicit > conflict)——那等于给季号
     **无限权重**,一个相似度很低的候选会无条件压过接近满分的候选。Seanime 的
     `−8`/`−3` 是**有界惩罚**,其它证据能翻盘,这才是对的形状。
  2b. ★**季号 gate 写在哪里决定测试是 0 改还是 1 挂**(两种写法都实跑过):
     写在 `ScoreCandidate` 里(markers 不一致就 `return 0`)会挂
     `match_test.go` 的 `TestPickBest_TierLow_YearContradicted`,而且**会把 TierLow
     塌成 TierNone —— 等于吃掉 needs-review 通道**,把「存疑」变成「无匹配」。
     写在 `PickBest` 里(marker 只作 argmax tiebreak + TierHigh 准入条件)现有测试全绿。
     **选后者。**
  3. 「一侧声明、另一侧沉默」不能只降排序不设闸门:候选表里没有正确的 S2、
     只有裸标题 S1 时它正是这一档,仍会被权威绑定 —— 洞没堵上。
  4. 不要把 Season 和 Part 判定「取更差者」:双方都声明 S2 但都没写 Part 时会退化成
     中性,让「双方确认」几乎不可达。
  5. 现有的 `TestPickBest_TierLow_YearContradicted` **分不出**这几种设计——它的年份差
     4 年,`ys=0.0` 已经把它压到 TierLow 了。必须补一个「候选声明了不同季号 **且**
     年份一致」的新用例才有判别力。
- **Context:** 参照实现是 `5rahim/seanime` 的 `internal/library/scanner/matcher.go`
  (1596 行,GPL-3.0):带负分的累加、门槛 6.0、季号一致 +5 / 明确不符 −8 / 隐含 −3、
  格式相符 +5 / 不符 −5、年份差>1年 −10。它的 `getIgnoredSynonyms` 也值得看
  ——被多个候选共享的别名只保留给主标题最短的那个,且只作用于非主标题。
  ★ **注意别重复一个已经犯过的归因错误**:这条路径产出的是 `anime_cache.bgm_id`,
  **不是** `bgm_id_map`(后者是从 `data/anilist_bgm_map.json` 灌进来的输入表,
  `bangumi_v1.go:128` 命中即绑定并 return,根本不走 scorer)。所以这个改动改善的是
  fuzzy 匹配质量,**不是**「无来源绑定」那笔债的修复,优先级要按前者判。
- **Depends on / blocked by:** ~~被包依赖环阻塞~~ —— **已不再阻塞**,解法见 Cons 第 1 条
  (0.5 人天,零调用方改动)。缺陷本身也已用可运行原型复现,不是推演:
  基线下 `picked id=1 / tier=high`(绑错季且高置信),加上修复后 `picked id=2 / tier=high`;
  候选表里只有错季条目时,基线 `tier=high` 无条件绑定,修复后 `tier=low` 转 needs-review。
## 若任一路由的服务端渲染慢过约 300ms，把段内 `loading.tsx` 加回去

- **What:** 2026-08-28 把 `app/[lang]/loading.tsx` 从根部挪进了 `(home)/`，代价是
  除首页、`/search`、`/welcome` 之外的路由在冷渲染时不再有骨架屏。若将来某个路由的
  服务端渲染变慢，给它单独加一个段内 `loading.tsx` —— 但**前提是那个路由不调
  `notFound()`**，否则 `routeBoundaries.test.ts` 会（正确地）变红。
- **Why:** 当时同意删掉的理由挂在一个会变的数上：源站直连实测首页 0.124s 渲染完，
  在「感知为瞬时」的 100ms 阈值附近，先闪 91ms 骨架屏再换内容更像多余的状态切换。
  这个论证在页面变慢时自动失效，而那时没人会记得当初是按哪个数判的。
- **Pros:** 阈值写下来了，重新判断时不用从头量；`routeBoundaries.test.ts` 已经保证
  加回去的位置不会重新制造 soft-404。
- **Cons:** 可能很久都不会触发；渲染耗时受机器和网络影响，需要用同样的方法复测
  （源站直连 TTFB vs total，差值就是流式窗口）而不是随手 curl 一下线上。
- **Context:** 那个根部文件第一行注释写着 "HomePage skeleton" —— 它本来就是首页的
  骨架屏，只是放高了一层，顺带把 Suspense 边界盖到 24 个路由段上，让 5 个调
  `notFound()` 的路由发不出 404。挪回 `(home)/` 之后首页的骨架屏原样保留。
  当时测到的流式窗口：`/search` 0.287s、`/welcome` 0.263s（两者保留了自己的
  `loading.tsx`）、`/` 0.091s、`/seasonal` 0.043s、`/calendar` 0.038s，
  而 `/anime/[id]` 是 0.001s —— 它是 ISR，整页缓存后一次发出，那 167 行骨架屏
  从来没有渲染给任何人看过。
- **Depends on / blocked by:** 无。

## 把 `resolveLocale` 拆成会抛和不会抛两个变体

- **What:** `lib/i18n/route.ts` 的 `resolveLocale()` 在 `[lang]` 不是合法 locale 时
  直接 `notFound()`。它被 20 个页面和全部 4 个 layout 引用。拆成一个给 layout 用的
  会抛变体，和一个给「边界之下的页面」用的不会抛变体。
- **Why:** `routeBoundaries.test.ts` 现在有三条 allowlist（`(home)` / `search` /
  `welcome`），理由都一样：这些页面重复调了一次 `resolveLocale`，而 `[lang]/layout.tsx`
  已经用同样的 params 在边界**之上**检查过了，所以页面里那一次永远不可能是决定 404 的
  那一次。拆开之后这三条 allowlist 自动清空，规则变成无条件成立。
- **Pros:** 把「靠 allowlist 说明为什么破例」变成「结构上不可能破例」；也省掉每个页面
  一次多余的 locale 解析。
- **Cons:** 触及 20 个页面文件，是个大范围但机械的改动；两个变体的命名要足够清楚，
  否则下一个人会挑错那个。
- **Context:** 这是「为什么 allowlist 存在」的正解，不是绕过。allowlist 每条都带了
  理由并且会做陈旧性检查（条目描述的违规若已消失，测试同样变红），所以现状是安全的，
  只是不够干净。
- **Depends on / blocked by:** 无，但做完之后要把 `routeBoundaries.test.ts` 的
  `ALLOWED` 清空，那三条陈旧性检查会提醒你。

## 清掉「客户端语言来自 `lang` cookie」这个说法 —— 全仓 14 个文件，而那个 cookie 不存在

- **What:** `grep -rlE "lang.{0,12}cookie|cookie.{0,12}lang" next-app/src` 命中 14 个
  文件。其中源头 `lib/lang-client.tsx` 已在 2026-08-28 改正，其余需要逐个过一遍：
  留下真正是历史陈述的（「cookie 被移除之后……」是准确的），删掉仍在描述当前行为的。
- **Why:** 全仓**没有任何 `lang` cookie**——不写也不读。`cookies()` 只用于鉴权
  （admin / library / login / register），`?lang=` 是 `proxy.ts` 里的遗留**查询参数**，
  不是 cookie。而这些注释描述的是一套完整的机制：hydration 后有个 effect 把语言换成
  cookie 值，所以客户端语言和服务端渲染「故意不一致」。这套机制不存在。
- **Pros:** 这不是措辞问题，它已经在改变判断。`seasonal/[season]/[year]/page.tsx`
  第 207 行用它当作一个设计决定的依据；`not-found.tsx` 曾用它论证 404 页的语言不可信
  （实测可信，现由 `e2e/specs/sandbox/not-found-status.spec.ts` 三语在浏览器里钉住）。
- **Cons:** 纯注释改动，没有测试能防止它再次发生；14 个文件要一个个读，不能批量替换，
  因为其中确实有几处是准确的历史陈述。
- **Context:** `lang-client.tsx` 自己的 `LanguageProvider` 注释一直是对的
  （"There is no reconciliation step and no local state"），与同文件头部的说法直接
  矛盾了很久没人发现 —— 一个文件里两段注释互相打架，是这类腐烂的典型信号。
- **Depends on / blocked by:** 无。

## `proxy.ts` 把任何以点后缀结尾的路径当成静态资源，裸 URL 因此匹配不到路由

- **What:** `proxy.ts:94` 的 `NON_PAGE_PATH = /^\/api\/|^\/_next\/|\.[a-z0-9]+$/i`。
  第三个分支意思是「任何以 `.` + 字母数字结尾的路径」。这类路径会跳过 locale 改写，
  而**裸 URL 正是靠那次改写才能匹配到 `/[lang]/...`** —— 于是它谁也匹配不上，落到
  Next 内置的 404 页。带 `/en`、`/zh-Hant` 前缀的不受影响（`en` 本身就填进了 `[lang]`）。
- **Why:** 实测：`/u/{contact-shaped handle}` 裸路径 404，`/en/u/{同一个}` 正常 308
  重定向到掩码 handle。凡是邮箱形状的别名都中招，因为常见邮箱域名都以点后缀结尾。
- **Pros:** 修法很清楚：把「任何点后缀」换成真实的扩展名白名单。
- **Cons:** 那条守卫是**承重**的 —— 它防止 `/sitemap.xml`、`/robots.txt`、jassub 的
  `.wasm` 被改写到 locale 段下面，而 sitemap 是这个站最不能出事的 URL。白名单漏一个
  就等于弄坏一个资源，所以这是一次需要自己的测试和自己的评审的改动。
- **Context:** 影响面有限：受害的只有**别名**形态，而站内所有链接指向的是规范形态
  `/u/user-xxxx`（无点，裸路径正常）。状态码层面 404 也是个说得过去的答案，丢掉的是
  那次重定向。已由 `not-found-status.spec.ts` 的 "KNOWN DEFECT" 用例钉住现状。
- **Depends on / blocked by:** 无。

## `/u/` 的三处重定向会丢掉 locale 前缀

- **What:** `/en/u/{alias}` 重定向到**裸** `/u/user-xxxx`，`/en` 没了。英文读者被静默
  送回中文站。三个 `/u/` 重定向调用点都是这样。
- **Why:** `permanentRedirect()` 收到的是硬编码的 `/u/${...}`，没有经过 `localizePath()`。
  以前这个缺陷是隐形的：重定向根本发不出状态码（流式响应把状态冻在 200），走的是客户端
  导航。2026-08-28 拿掉 `loading.tsx` 之后它变成真 308，缺陷才暴露在 HTTP 层。
- **Pros:** 改动很小 —— 那三处套一层 `localizePath(path, locale)` 即可，页面本来就有 locale。
- **Cons:** 需要同时更新 `not-found-status.spec.ts` 里那条 "KNOWN DEFECT" 用例，它目前
  断言的是「前缀确实丢了」，修好之后会（正确地）变红。
- **Context:** 这是那类「只有把上游修对了才看得见」的缺陷。
- **Depends on / blocked by:** 无。

## 404 的 `Cache-Control` 和真实番剧页一模一样

- **What:** 生产构建下 `/anime/{不存在的 id}` 返回
  `s-maxage=60, stale-while-revalidate=31535940`，与 `/anime/21` 逐字节相同。
  于是一个 404 会进 Cloudflare 边缘缓存，在该 id 变成真页面之后仍可能被发出一次。
- **Why:** ISR 的 `revalidate` 是**整条路由**的属性，Next 没有在页面层面按状态码区分
  缓存时长的声明式写法。要区分得走 nginx 或中间件。
- **Pros:** 实际敞口很小：SWR 语义是「发陈旧的同时后台重验」，所以最多是新鲜窗口过后
  的第一个访客拿到一次旧的 404，下一个就是新的。
- **Cons:** 这条**没有测试**，而且故意没有：沙箱套件跑在 `next dev` 上，那里这个头是
  `no-cache, must-revalidate`，断言会永远为真 —— 一条不可能失败的绿灯比没有断言更糟。
  要测只能放线上那个 project，且只能在部署之后跑。
- **Context:** 与 2026-08-28 的状态码修复无关，线上今天就是这个头，变的只是被缓存的
  东西从 200 变成了 404。
- **Depends on / blocked by:** 无。

## 未匹配任何路由的 URL 拿到的是 Next 内置 404，不是我们设计的那张

- **What:** `/en/nope-nothing-here` 这类打不中任何路由的地址，渲染的是 Next 自带的
  `404: This page could not be found.`，没有 Navbar、没有品牌、没有去处。我们设计的那张
  只在页面主动调 `notFound()` 时出现。
- **Why:** 我们的 `not-found.tsx` 在 `app/[lang]/` 下，不是 app 根。根级未匹配 URL 要
  `app/not-found.tsx` 或 `app/global-not-found.js` 才接得住，而我们**不能**建
  `app/not-found.tsx` 之外的根级静态段（会遮蔽 `[lang]`）。
- **Pros:** Next 文档正好点名了我们这个形状：「根布局用顶层动态段（如
  `app/[country]/layout.tsx`），会让统一的 404 页更难拼」，并把 `global-not-found.js`
  列为对应答案（`node_modules/next/dist/docs/01-app/03-api-reference/
  03-file-conventions/not-found.md`）。
- **Cons:** 该特性 v15.4.0 起仍是 experimental，需要开 `experimental.globalNotFound`，
  且它绕过正常渲染 —— 得自带 `<html>`、字体和全局 CSS。
- **Context:** SEO 上无损（状态码就是 404，Next 还自动注入 noindex），纯粹是体验和品牌
  问题：打错一个字的访客拿到的是一张空白页而不是回站内的入口。
- **Depends on / blocked by:** 无。

## 台湾/大陆译名不同 —— 简繁折叠做完之后剩下的那 59%

- **What:** 2026-08-28 给 `/api/anime/search` 加了查询词简繁折叠（用现有的
  `opencc-s2twp.txt`，转出的繁体额外去匹配 `title_hant`，不写库、不改显示）。
  **这条 TODO 的本体已完成。** 留下的是它够不到的部分：**同一部番在台湾和大陆
  用不同译名**，任何字符映射都跨不过去。
- **Why:** 实测而非估计。拿 **5,160 行**同时有简体标题和**权威**繁体标题
  （`title_hant_source <> 'opencc'`）的记录做测量：折叠后的简体标题能成为库里繁体
  标题的子串（正是搜索用的判据）的比例是 **40.7%**，不折叠是 **7.4%** —— 提升
  约 5.5 倍，但不是"解决"。
- **Pros:** 失配的成因已经查清，不用再猜：**2,237 条失配长度就不同**，是彻头彻尾
  的另一个译名 —— 海賊王 / 航海王、三眼小子 / 三眼神童、鋼鐵奇兵 / 金屬對決、
  勇敢魔女 / 無畏魔女。剩下 822 条等长的也多是译名差异（兄弟鬥爭 / 兄弟戰爭）
  和繁体行文惯例（你 / 妳），不是字形转换错误。
- **Cons:** 要再往前走只有一条路：**别名表**。可以从 AniList 的 synonyms 里挖
  （那本来就是多译名的来源），也可以人工维护热门番的别名。这是独立的一件事，
  且收益递减 —— 40.7% 已经覆盖了最常见的情况。
- **Context:** 另有 **57 行「有简无繁」**（用户敲繁体、库里只有简体）仍未覆盖，
  需要 t2s 表而仓库只 vendor 了 s2twp。57 行太少，是否值得再 vendor 一份表留待再判。
  ★还有个坑值得记：**s2twp 不是纯字形转换**，`wp` 是台湾词汇替换 ——「折叠」会变成
  「摺疊」而不是「折疊」。写测试探针时用了这类词会让测试红而功能其实是好的，
  我为此排查了两轮。
- **Depends on / blocked by:** 无。

## 不存在的番剧 id 在 AniList 被限流时返回 500 而不是 404

- **What:** `/anime/{不存在的 id}` 走的是「本地缓存未命中 → 实时问 AniList」。AniList
  一旦限流，go-api 返回 `AniList rate limited`，next-app 抛 `ApiError`，页面变成
  **500**。实测：沙箱套件用 `--repeat-each=3` 并发压一下就稳定复现，dev 日志逐字写着
  `Error [ApiError]: AniList rate limited` 后跟 `GET /anime/999999999 500`。
- **Why:** 一个不存在的 id 本该答 404，在限流窗口里答的是 500。缺陷本身与 CI 无关、
  独立可复现（见上面的 `--repeat-each=3`），代价写在下面的 Context 里。
  > ★**归因更正（2026-08-29）**：本条原写「这大概率就是沙箱 CI 里
  > `not-found-status.spec.ts` 那条 `/en answers 404` 偶尔变红、重试即过的真正原因」——
  > **那句是错的，已删**。那个 flake 的真身是 Turbopack dev 下**整类嵌套动态路由变
  > 404**（见下一条「Turbopack dev 下……」）。三条判据各自独立地否掉了本条：
  > 症状是 **404 不是 500**；受害路由包括 `/reset-password/[token]`，它**一次 AniList
  > 都不调**；而失败那次里 `/anime/*` 的 404 只花了 42ms（`next.js: 5ms`），
  > 根本没进过第三方调用。两件事只是恰好都落在同一个套件上。
  > ⚠️ **同一句错误归因也逐字写在 `e2e/specs/sandbox/not-found-status.spec.ts:59-60`
  > 的注释里**（"almost certainly the cause of the `/en answers 404 (retry #1)`
  > flake"），修这条缺陷时一并改掉，否则它会继续把下一个人引到 AniList 上。
- **Pros:** 修法和 2026-08-28 的搜索改动是同一个思路：**目录里没有的 id，本地就能判定
  不存在，不必问第三方**。`anime_cache` 有 17,689 行，一个 id 不在里面且不是新番的
  概率极高。至少可以做到「AniList 不可达时退回本地判定」而不是直接 500。
- **Cons:** 有真实的取舍：一个刚上映、我们还没收录的番，本地判定会给出 404，而现在
  它能通过 AniList 找到并顺带入库。要保留这个自愈能力，就不能无条件本地化。
- **Context:** 对 SEO 的影响是实的 —— Googlebot 撞上限流窗口时，一个本该是 404 的 URL
  会返回 500，而 500 会让爬虫认为是临时故障并反复重试，比 404 更糟。
  `not-found-status.spec.ts` 里那几条状态断言故意保持严格（只接受 404），**不要**为了
  让 CI 变绿而放宽成「404 或 500」—— 那会把这个缺陷永久藏起来。
- **Depends on / blocked by:** 无。与本地搜索独立，但共用同一个判断。

## Turbopack dev 下，嵌套在 `[lang]` 里的动态路由会整类 404

- **What:** 沙箱 e2e 时红时绿、重跑即过，一直被当成不明 flake。真身不在测试里：
  `next dev` 用的是 Turbopack（Next 16 起是默认），而某些进程实例里**凡是 `[lang]`
  下面还有一层动态段的路由，一整轮全部 404** —— `[lang]/anime/[id]`、
  `[lang]/reset-password/[token]`、`[lang]/u/[username]`、
  `[lang]/seasonal/[season]/[year]` 无一幸免。止血办法是让沙箱的 dev server 也走
  webpack（`next dev --webpack`，该 flag 确认存在），与 `next build --webpack` 对齐。
- **Why:** 形状本身就排除了产品代码：两个 PR（#127 改 CSS/SVG filter、#128 改弹幕速度
  设置）**diff 毫无交集**，却在 attempt 1 挂掉**同样 9 条用例、同样的行号**
  （散落在 6 个 spec 文件里），且都在**零代码改动**的重跑里全绿。
  再看范围：`[lang]` 是唯一动态段的路由（`[lang]/faq`、`[lang]/search`、
  `[lang]/privacy`）自始至终正常，`[lang]` **之外**的动态路由
  `/sitemaps/anime/sitemap/[id].xml` 同一轮里也正常 200 —— 坏的恰好是
  「`[lang]` + 再嵌一层动态段」这一类，三段路径 **0 成功 / 19 次失败**。
- **Pros:** 两条判据都能直接从 CI 日志读出来，不必复现：
  1. **`generate-params` 阶段在不在。** next-dev.log 里每条 200 都带
     `generate-params: …`，每条 404 **一个都没有**。这一段缺失＝该段从没被编译。
  2. **404 花了多久。** 健康时 `/anime/0` 是 `404 in 942ms (next.js: 870ms)` ——
     段编译过了、页面在 `anilistId <= 0` 上主动 `notFound()`，这是**产品的** 404。
     故障时是 `404 in 42ms (next.js: 5ms)` —— 从没编译过，404 来自路由层。
     ★**状态码一模一样，来源完全不同** —— 只看状态码永远分不出这两件事。
- **Cons:** `--webpack` 是**止血不是修复**，而且 2026-08-29 的对照组实测证明**现在还不能上**。
  同一个 commit 推 6 个分支各跑一次（不同 ref 才能绕开 `cancel-in-progress`，同 ref 连发只会
  互相取消）：

  | | Turbopack 基线 | webpack 6 次 |
  |---|---|---|
  | 嵌套动态段 404 指纹 | 14 次里出现 3 次 | **0/6，确实消失了** |
  | job 时长 | ~4 分钟 | **8m08s–9m23s，约 2.2 倍** |
  | 套件结果 | 间歇性红 | **6/6 全红** |

  ★**它换来了一个更糟的缺陷**：7 条用例在 6 次里每次都挂（`auth` 3 条、`locale-routing`
  2 条、`stale-tab` 2 条），确定性的，不是抖动。机理在第一条里写着 —— 期望
  「邮箱或密码错误」，实际拿到「邮箱格式不正确」，即**打字进了 DOM 没进 React state**，
  正是 #129 修 `/search` 时记下的水合竞态。#129 只修了那一个 spec，其余会打字的 spec
  仍然不等 `__reactFiber$`，而 webpack 更慢的编译把那个窗口从偶发撑成了必现。
  **结论：套件本来就依赖 dev server 足够快，Turbopack 的速度一直在掩盖这件事。**
  换打包器之前必须先把这些 spec 的水合等待补上，否则是拿一个间歇性红换一个确定性红。

  另外两块代价不变：沙箱从此不再覆盖生产之外的第二个打包器；**上游那半还没查** ——
  这是不是已知的 Next issue、有没有在更晚的 16.x 里修掉，目前是空白
  （查的时候 web search 额度已耗尽，不是查过没有）。在补上这一步之前，
  只能说「webpack 下没复现 404」，**不能**说「根因是 Turbopack 的某某」。
- **Context:** 全仓只有沙箱在跑 Turbopack —— `next-app/package.json` 的 build 是
  `next build --webpack`，只有 `dev` 走默认。当前钉的是 `next@16.2.6`。
  ★**最值钱的是早期指纹**：warm-up 那一行 `warmed /reset-password/warmup -> 404`。
  那个页面不调任何 API、也没有任何 `notFound()` 分支，**健康栈里它不可能是 404**。
  翻了 14 次历史运行它出现过 3 次，**3 次对应的 attempt 全部失败**。而 warm-up 的守卫
  只对 `5xx|000` 判失败，所以它两次都把指纹打印出来又原样放行了。把这一行收紧成
  「`/reset-password/warmup` 不是 200 就直接失败」成本一行，收益是把一次半小时的
  e2e 排查压成一条报错。
  ★**取证顺序**：重跑会**覆盖** job 日志，但
  `gh api repos/OWNER/REPO/actions/runs/<id>/attempts/1/logs` 仍取得到失败那次；
  而 `Dump service logs on failure` 是 `if: failure()`，所以 next-dev.log 和容器日志
  **只有失败那次才存在**，重跑变绿之后就永远没有了。**先取证，再重跑。**
- **Depends on / blocked by:** 无。
  ★★**2026-08-29 补：换打包器不是唯一出路，自愈已实测可行。** 自建最小复现（290 个 page +
  2.2MB 共享模块 —— **空 app 复现不出来，0/20**），把 dev server 打进故障态 41 次分三组：
  **control 0/13 修好、`touch`（纯 mtime，零字节写入）11/11、内容写入 11/11**。
  macOS 与 Linux 容器两边都跑了（FSEvents 与 inotify 对 `utimensat` 的处理没理由假设同构）。
  机理不是只看状态码翻转：touch 前 `404 in 43ms (next.js: 5ms)`（没编译），
  touch 后 `200 in 818ms (generate-params: 688ms)`（段第一次被编译）。
  三条硬约束，都是实测不是推的：
  ① **touch 必须打在 `app/` 底下** —— 打在被 import 但位于 app/ 外的模块上 **0/2**；
  ② **可以 touch 一个惰性文件**（app/ 下的空文件、零 import）**2/2**，
  所以自愈脚本不需要编辑任何 page 源码；
  ③ 检测到故障再 touch，落点远在 ready 之后，不会踩上游说的「ready 后约 1.5s 事件被吞」窗口。
  ★**一条诚实的保留**：复现里死的是**动态段下面的静态子段**，而动态叶子全部活着 ——
  **和我们 CI 里 404 的形状正好相反**。复现的确定是上游那个缺陷；
  我们 CI 那次是不是同一个，靠指纹吻合推断，**这次实验没有直接证明**。
  所以判据只能用指纹（瞬时 404 + 缺 `generate-params` + 整类全灭 + 持续整场），不能用路由形状。
  ★方法论坑，值得记：对照组差点出假阳性 —— 一台试验中的 server 被误杀，post 探测全是连接错误
  （status 0），而分类器只把 **404** 当「死路由」，于是记成「自愈成功」。
  **「不是失败信号」不等于「成功信号」**；探测器要加存活断言。
  ★**退出条件 —— 什么情况下可以把 Turbopack 换回来**，三条都满足才动：
  ① 找到对应的上游 issue，并确认它在某个具体的 16.x 里标为已修；
  ② 升到那个版本；
  ③ **用同一个指纹复验**：连跑若干次沙箱，`warmed /reset-password/warmup` 全是 200，
  且 next-dev.log 里嵌套动态路由的 200 全都带 `generate-params`。
  「跑了一次没红」**不算数** —— 这个缺陷本来就是间歇的，n=1 在本仓已经骗过人不止一次。

## 断言「不存在」的用例，在整体故障下会以错误的理由变绿

- **What:** 扫一遍沙箱套件，把「断言 404 / 不可见 / 空结果」却**没有同路由族正例配对**的
  用例挑出来，逐条补上正例。**这条 TODO 的本体是那次扫描**，不是某一个文件 ——
  下面的样本只是发现它的入口，不是全部。
  ★**已配对两处，其余未扫**（别把这两处当成扫描做完了）：
  ① `/seasonal/<season>/<year>` —— 原本唯一的正例在 `chromium-prod`，
  那个 project 打的是**已经部署的线上站**，所以「PR 把每一季都改成 404」照样全绿。
  正例已加进 `not-found-status.spec.ts` 并**排在文件第一位**：该文件是
  `mode:"serial"`，前面任何一条红掉，后面的全部 **skip**，只有第 1 位不会被静音。
  ② `stale-tab.spec.ts` 那 3 条「通知不出现」—— 它们此前在**功能彻底不工作**时
  也全绿（实测：让监听器永不注册，旧代码那 3 条一条不红）。现在它们先等
  `/version.json` 的往返真的发生，再问通知有没有出现。
  ★这两处给出的通用配方：**负向断言要先等一个「被测能力确实运行过」的可观测量**，
  不能只等一段时间然后断言什么都没发生 —— 后者与「能力从没启动」完全同形。
- **Why:** 2026-08-29 那次故障给了一个教科书级的样本：**全站每一条嵌套动态路由都在
  404**，而 `not-found-status.spec.ts` 里断言 404 的 **10 条用例全绿** ——
  `/anime/0`、`/anime/abc`、`/anime/-1`、`/anime/999999999`、
  `/seasonal/notaseason/2026`、`/u/{不存在}` 及其 `followers`/`following`，
  再加三个 locale 前缀各一条。它们要的答案是 404，而路由层正在无差别地发 404，
  于是**每一条都以完全错误的理由通过了**。一条断言「这个不存在」的用例，
  在「什么都不存在」的时候没有任何判别力。
- **Pros:** 配对的效力不是推演，**同一个文件里就有现成的对照组**：
  `not-found-status.spec.ts:207` 的 "a real anime still answers 200 in every locale
  form"。那一轮 11 条状态断言里**唯一变红的就是它**，而它的注释当初就把理由写清楚了 ——
  "a change that 404s the whole catalogue passes every assertion above"。
  作者预见到了这个形状并挡住了；缺的只是把同一条规则推广到其余用例。
- **Cons:** 配对不是免费的：正例需要一条真实存在的夹具数据，而夹具生命周期在
  `fullyParallel` 下本身就是出过 bug 的地方（#123 修过一次共享夹具的并发缺陷，
  #118 那轮的三条红也全是我自己 spec 的并发缺陷）。补正例时别顺手引入新的共享可变状态，
  否则治好一个盲区、换来一个 flake。
- **Context:** 沙箱 20 个 spec 里有 12 个含形如 `toBe(404)` / `not.toBeVisible` /
  `toHaveCount(0)` / `toBeHidden` 的负向断言，共 **35 处** —— 这是扫描的**分母**，
  **不是**「35 处都有问题」的结论，也**不是**「已经扫过了」。逐条只问一个问题：
  **「如果被测的这个能力彻底坏掉，这条断言会不会照样绿？」** 会，就补正例。
  ★配套的一条判据见上一条：状态码相同不代表路径相同，用例分辨不了的，
  服务端日志能分辨（`generate-params` 在不在 / 404 花了几毫秒）。
- **Depends on / blocked by:** 无。与 Turbopack 那条彼此独立 —— 打包器换回去之后，
  这个盲区照样在。
||||||| parent of b94900e (docs: record the dialog primitive migration as a TODO)
## 把剩余 10 个手搓对话框迁到共享 Dialog primitive

- **What:** 下一个新增的对话框会顺带抽出一个共享 Dialog primitive(backdrop、Escape、焦点进入、
  焦点归还),并让它与 `components/anime/PlayButton.tsx` 同时使用。本条是把其余 10 个也迁过去:
  `library/_components/` 的 MergeDialog / SplitDialog / RematchDialog / OpsLogDrawer / SeriesDetailSheet、
  `components/anime/TorrentModal.tsx`、`components/profile/PhotoCropModal.tsx`、
  `components/safety/ReportDialog.tsx`,以及 HudOverflowMenu 与 LanguageMenu 中的同形部分。
- **Why:** 全仓 11 个组件各自手写 `e.key === "Escape"`,**没有任何共享实现**;其中只有 3 个
  (HudOverflowMenu / LanguageMenu / PlayButton)做了关闭后的焦点归还。下一次无障碍修复
  (焦点囚禁、`inert`、滚动锁定)要手改 11 处,而没有任何机制告诉你漏了哪几处。
- **Pros:** 每迁一个,重复的图案数量减一;顺带把 8 个缺失的焦点归还一起补上;以后无障碍修复只改一处。
- **Cons:** 跨 library / player / anime / profile / safety 五个区域,各自有转场动画、背景点击、
  滚动锁定的差异,不是机械替换;纯重构 PR,无用户可见价值,需要逐个回归。
- **Context:** 2026-08-29 清点全仓对话框实现时发现。刻意没有一次性全迁 —— 让 primitive 上线
  当天就有两个真实使用者(新对话框 + PlayButton),同时把重复图案数保持在 11 而不是变成 12,
  且不让一次全站重构阻塞新功能。primitive 从 `PlayButton.tsx:36,49` 已验证的 rAF 焦点模式
  提炼(`triggerRef.current?.focus()` / `closeRef.current?.focus()`)。
  **这条 TODO 最重要的作用不是催重构,而是让下一个要写弹窗的人知道 primitive 已经存在** ——
  否则抽象会被手搓的第 12 份白白作废。建议按区域分批,一次一个 PR,每个配一条 e2e 键盘用例。
- **Depends on / blocked by:** 阻塞于 primitive 先落地。

## 网站 /library 的非 Chrome 兜底

- **What:** 给 `next-app/src/app/[lang]/library/_components/DropZone.tsx` 补上 `webkitdirectory` / `webkitGetAsEntry` 兜底路径,让 Safari / Firefox 用户能建库。`/player` 那个同名文件已经有一份现成实现(`flattenDropFiles` + `<input webkitdirectory>`),直接搬。
- **Why:** 实测 `library/_components/DropZone.tsx:262` 是 `if (onPick && isFsaSupported) onPick();` —— 非 Chromium 浏览器上点「添加文件夹」**什么都不会发生,没有任何兜底分支**。这些用户不是体验差,是整个本地库功能对他们不存在。
- **Pros:** `/player` 代码现成可搬;非 Chrome 用户从「完全用不了」变成「能用」;纯前端,不阻塞任何其他工作。
- **Cons:** 没有持久句柄 —— `File` 对象活不过刷新,每次开站要重选一次文件夹;也没有自动重扫(`FileSystemObserver` 同样 Chromium-only)。
- **Context:** 2026-08-29 `/plan-eng-review`(agent 方案评审)中发现。⚠️ **降级模式必须在 UI 上明说**,否则「每次要重选文件夹」会被用户读成「功能坏了」—— 这个仓库在静默降级上栓过多次。注意两个 `DropZone.tsx` 是不同文件,别改错。
  **为什么不等一个"装个东西就好了"的方案:** 任何要求用户先安装本地程序的路线都只救**装了的人**。不装的 Safari / Firefox 用户在那之后依然是今天这个处境,所以这一项不被它取代。
- **Depends on / blocked by:** 无。纯前端,与其他方向零交集,任何时候都能做。

## deploy.sh 的 smoke 检查从不因为 5xx 失败

- **What:** 让 `scripts/deploy.sh` 末尾那三条 smoke curl 在非 2xx/3xx 时真的让部署红掉,而不是只打印一行状态码。
- **Why:** 现在是 `curl -sk -o /dev/null -w "HTTP %{http_code} from /"` —— 把状态码**印出来但不判断**,三条都一样。脚本自己最后一行写着「If a smoke line shows 5xx, check `docker compose logs`」,也就是它明确依赖**有人去看那行输出**。一个全站 500 的部署,退出码是 0。这不是假想:2026-08-30 本地把 bgm 字段灌进 `anime_cache` 之后,`/anime/116674` 连续返 500,而整条流程照常走完。
- **Pros:** 改动极小(三行加 `-f`,或显式比较状态码);把仓库自己那条「验部署要 curl 不能看退出码」的教训真正写进脚本;严重度高于大多数前端缺陷 —— 500 是硬故障,不会自愈。
- **Cons:** smoke 跑在 `$COMPOSE up -d` **之后**,所以「失败」时新版已经在线且没有回滚。要么接受「大声报错但不回滚」(仍比静默好),要么顺带接上回滚 —— 后者就不是小改动了。`scripts/p9-rollback.sh` 已存在,可以先看它能不能直接接。
- **Context:** 2026-08-30 的 `/plan-eng-review` 中发现:外部声音指出 smoke 在 `up -d` 之后且不 gate,由读脚本确认。⚠️ 注意别顺手把它改成 `set -e` 直接退出 —— 那会在「新版已上线」的状态下留下一个半完成的部署,比现在更难收拾;先决定失败语义再动手。
- **Depends on / blocked by:** 无。纯 shell,与任何代码改动零交集。
