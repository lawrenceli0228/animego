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
- **Why:** 这大概率就是沙箱 CI 里 `not-found-status.spec.ts` 那条
  `/en answers 404` 偶尔变红、重试即过的真正原因 —— 一直被当成不明 flake。
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
