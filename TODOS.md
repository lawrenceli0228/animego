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
- **Why:** 2026-08 评审实测:整个 library 逻辑层只有 `buildLibraryMatchResult.test.js` 一个测试文件;代码里预留的 DI seam(`useImport` 的 `{db, dandan, hashPool}`)从未被使用;全局规则要求 80% 覆盖率。
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
