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
