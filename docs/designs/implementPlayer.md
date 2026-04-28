# 播放器板块:单文件 → 本地影音库

> 设计文档 · 2026-04-29 · **修订 v2 · 2026-04-29(工程 review 后)**
> 目标:把播放器板块从"单文件即播"演进为"多文件/多文件夹导入 → 自动归集系列 → 库浏览 → 选集播放",并处理"同一动漫散在不同文件夹"的核心难题。

---

## 0a. 修订记录

**v2(2026-04-29 工程 review 后必改)**

1. **Series/Season 拆分**:`Series.id = ulid`,`animeId` 下放到 `Season.animeId`(dandanplay 按"季"切分,animeId 实际是 Season 主键,不是 Series 主键)。详见 §3。
2. **Episode id 改 ulid**:不再是 `hash(seriesId+kind+number)`,kind/number 仅作字段。否则用户后期把 `kind: main → sp` 时 episode id 漂移,`WatchProgress.episodeId` 立即孤儿化。详见 §3。
3. **localStorage → IDB 进度迁移在 P4 显式列出**:补 `migrateLegacyProgress()`,按 `(anilistId|dandanAnimeId|bgmId, epNum)` 反查 episodeId,否则老用户 30 天 TTL 进度全丢。详见 §6 P4。
4. **`useDandanMatch` 在 P3 是重写不是扩展**:抽出 `matchSingleCluster(cluster)` 纯函数,UI hook 退化成单 series 视图层,批量管线由 `importPipeline` 直接调纯函数。详见 §6 P3。
5. **md5 worker pool 化前移到 P1**:多文件并发 `new Worker()` 一次开 47 个会卡死磁盘 IO。固定 4-worker pool,`md5.worker.js` 从"可能改"提升为 P1 必改。详见 §1 文件清单 + §6 P1。

**其他配套**:
- IDB 单事务包整 cluster 落库(防半写),`fileRefs` 加 `[libraryId+matchStatus]` 复合索引(未归类区块查询)
- `matchCache` 7 天 TTL 加 LRU eviction(2000 集量级才不爆 quota)
- `ManualOverride.fileNamePattern` 改 `(seriesId, normalizedToken[])`,基于 anitomy 归一化 token,不裸文件名

---

## 0. TL;DR

- **杠杆点**:`DropZone` 已能吃多文件、`useDandanMatch` 已能产 `animeId`、`AnimeCard`/`AnimeDetailHero` 视觉系统现成。真正缺的只有 **IDB 持久化层 + 跨 batch 归并器 + LibraryPage 路由** 三块。
- **路线**:P1+P2 两周拿"多文件能看"高频痛点,再啃 P3 的库,P4 加纠错与持久进度,P5 可选后端同步。
- **归并键**:`dandanplay.animeId` 是 series 的权威外键;辅以同目录预聚类 + 用户 `ManualOverride` 兜底。
- **文件持有**:File System Access API + IndexedDB 存 `FileSystemFileHandle`;Safari/Firefox 降级到 session-only。
- **隐私底线**:文件流永不离开浏览器,后端只见 metadata + hash(P5 同步也是)。

---

## 1. 现状基线(事实层)

### 入口
- `client/src/components/player/DropZone.jsx` — 已支持拖拽 + `webkitdirectory` + 单文件 input,但下游全程当**单 batch 单系列**处理。
- `client/src/pages/PlayerPage.jsx` L174 — 主页面状态机。

### 文件持有
- `client/src/hooks/useVideoFiles.js` — 原生 `File[]` 存 React state,字幕按集号自动配对(L27-30);播放时临时 `URL.createObjectURL` + 切集即 revoke(L50-71)。
- 无 IndexedDB、无 FileSystemHandle、无持久化文件引用。刷新即丢。

### dandanplay 匹配链路
- 客户端 API:`client/src/api/dandanplay.api.js` L9
- 服务端控制器:`server/controllers/dandanplay.controller.js` L74-155(三阶段)
  1. dandanplay hash+filename combined match → 拿集列表建 `episodeMap`
  2. AnimeCache keyword 搜索 → 从 dandanplay 取集列表
  3. 逐文件 hash 直接匹配
- hash 算法:`client/src/workers/md5.worker.js` 取首 16MB SparkMD5,10s 超时降级。
- 失败兜底:`phase='manual'` → `ManualSearch` 组件手选番剧。
- 弹幕挂载:`useDandanMatch` 返回 `episodeMap[epNum].dandanEpisodeId` → `usePlaybackSession.play()` L59 → `loadComments(dandanEpisodeId)` → `GET /dandanplay/comments/:episodeId` → 注入 `VideoPlayer.danmakuList`。

### 持久化(全部 localStorage)
- 进度:`animego:progress:{anilistId|dandanAnimeId|bgmId}:{epNum}`,TTL 30 天
- 偏好:`subtitleFontSize` / `subtitleOffset` / `playbackRate` / `danmakuVisible` / `heatmapConfig`

### 现有 series/episode 概念
内存中已有,但仅在 match 结果存活:
```ts
matchResult = {
  matched: bool,
  anime: { anilistId, titleChinese, titleNative, titleRomaji, coverImageUrl, episodes },
  siteAnime: { ...AnimeCache },
  episodeMap: { [epNum]: { dandanEpisodeId, title } },
  source: 'dandanplay' | 'animeCache' | 'manual'
}
```

### 关键文件清单

| 文件 | 角色 | 改动 |
|---|---|---|
| `client/src/pages/PlayerPage.jsx` | 状态机入口 | 必改 |
| `client/src/hooks/useVideoFiles.js` | File 持有 + 字幕配对 | 必改 |
| `client/src/hooks/useDandanMatch.js` | 匹配状态机 | 必改 |
| `client/src/hooks/usePlaybackSession.js` | 会话续看 + MKV 字幕 | 必改 |
| `client/src/components/player/DropZone.jsx` | 文件输入入口 | 必改 |
| `client/src/components/player/EpisodeFileList.jsx` | 集列表 | 必改 |
| `client/src/components/player/VideoPlayer.jsx` | Artplayer 封装 | 可能改 |
| `client/src/workers/md5.worker.js` | 首 16MB hash | **P1 必改**(worker pool,见 §6 P1) |
| `client/src/utils/episodeMap.js` | epNum → episodeId | 可能改 |
| `server/controllers/dandanplay.controller.js` | 三阶段匹配 | 可能改 |
| `server/services/dandanplay.service.js` | dandanplay 包装 | 不动 |
| `server/models/AnimeCache.js` | MongoDB 元数据 | 不动 |

---

## 2. 推荐架构

```
┌─────────────────────────────────────────────────────────────┐
│ UI 层      LibraryPage · LocalSeriesPage · ImportDrawer ·  │
│            MergeUI · UnclassifiedSection                   │
├─────────────────────────────────────────────────────────────┤
│ Hooks 层   useLibrary · useSeries · useImport · useEpisode │
│            useResume                                       │
├─────────────────────────────────────────────────────────────┤
│ Service 层 ImportPipeline · GroupingEngine · ProgressStore │
├─────────────────────────────────────────────────────────────┤
│ 持有层     FileHandleStore (IDB) ── 引用 ── 用户磁盘文件   │
│ 元数据层   LibraryDB (IDB: series/episode/fileRef/progress)│
├─────────────────────────────────────────────────────────────┤
│ 现有播放链 PlayerPage(fileRef → File → useDandanMatch)     │
└─────────────────────────────────────────────────────────────┘
       (P5 可选) ↕ Sync API (server: 仅 metadata,不传文件)
```

### 3 个关键决策

| 决策点 | 推荐 | 弃 | 理由 |
|---|---|---|---|
| 文件持有方案 | **FSA + IDB Handle** | OPFS 拷贝 / 后端上传 | 0 拷贝、隐私、跨会话存活;Safari 降级到 session-only;1080p 5–15GB/季,VPS 带宽与版权风险都不划算 |
| 库 vs 播放器 | **独立 LibraryPage** | 嵌入 PlayerPage | 持久态 vs 即时态语义不同,混合会让入参与生命周期耦合 |
| 归并触发策略 | **自动归并 + 撤销 toast** | 强制每次确认 | 47 个文件批量导入若每次确认会变点击地狱 |

### 文件持有失败模式

| 场景 | 检测 | 兜底 |
|---|---|---|
| 浏览器重启权限失效 | `queryPermission()` 返回 `prompt` | 列表灰态 + 一键批量重授权 |
| 用户删除/移动磁盘原文件 | `handle.getFile()` 抛错 | 标 `MISSING`,保留元数据等用户重新指认 |
| 跨设备打开 | handle 不可序列化 | P5 同步只显元数据 + "在此设备绑定文件"占位 |
| IDB 配额满 | `quotaExceededError` | 拒新增 + 提示清理已观看;海报降级不缓存 |
| Safari/Firefox | FSA 不可用 | 降级到 File API session 模式,toast 提示"该浏览器仅本次会话有效" |
| dandanplay 误匹配 | 用户拖错系列 | `ManualOverride` 写回,后续同 pattern 跳过 match |

---

## 3. 数据模型

### Schema(TS interface 伪代码)

```ts
interface Library {
  id: string;              // uuid v4
  rootHandles: FSHandle[]; // FileSystemDirectoryHandle 列表
  scanVersion: number;
}

interface Series {
  id: string;              // ulid (修订 v2: 永远不用 animeId 派生,因 animeId 是 Season 主键)
  // animeId 已下放到 Season.animeId
  titleZh?: string;
  titleJa?: string;
  titleEn?: string;
  type: 'tv' | 'movie' | 'ova' | 'web';
  bangumiId?: number;      // 备用元数据源
  posterUrl?: string;
  totalEpisodes?: number;
  confidence: number;      // 0..1, <0.7 需用户确认
  createdAt: number;
  updatedAt: number;       // 修订 v2: P3 schema v3 即引入(P4 override 仲裁 + P5 同步都需要)
}

interface Season {         // 修订 v2: 必建(不是可选),因 dandanplay animeId 按季切分,animeId 是 Season 主键
  id: string;              // ulid
  seriesId: string;
  number: number;          // S1/S2
  animeId: number;         // dandanplay 每季独立 animeId — Season 的权威外键
  totalEpisodes?: number;
  updatedAt: number;
}

interface Episode {
  id: string;              // ulid (修订 v2: 不再是 hash(seriesId+kind+number),否则 kind 变更时 id 漂移会孤儿化 WatchProgress)
  seriesId: string;
  seasonId?: string;
  episodeId?: number;      // dandanplay
  number: number;          // 字段而非 id 组成
  kind: 'main' | 'sp' | 'ova' | 'movie' | 'pv';  // 字段而非 id 组成
  title?: string;
  primaryFileId: string;
  alternateFileIds: string[];
  updatedAt: number;
}

interface FileRef {
  id: string;              // hash(hash16M + size) 稳定 key
  libraryId: string;
  episodeId?: string;      // 未匹配时为空
  relPath: string;         // 相对 root,迁移友好
  size: number;
  mtime: number;
  hash16M?: string;
  resolution?: '480p' | '720p' | '1080p' | '2160p';
  source?: 'raw' | 'sub';
  group?: string;          // 字幕组
  codec?: string;
  matchStatus: 'pending' | 'matched' | 'manual' | 'ambiguous' | 'failed';
  matchCandidates?: { animeId: number; episodeId: number; score: number }[];
}

interface WatchProgress {  // 挂 episodeId 不挂 file,换源不丢进度
  episodeId: string;
  positionSec: number;
  durationSec: number;
  watchedAt: number;
  completed: boolean;
}

interface ManualOverride { // 记忆用户纠错,降低重复决策成本
  // 修订 v2: 不再用裸 fileNamePattern(易跨季误命中);改用归一化 token
  seriesId: string;
  normalizedTokens: string[];  // anitomy 归一化后的标题 token 数组
  updatedAt: number;
}
```

### 设计要点
- `animeId` 是 **Season** 的权威外键(不是 Series),跨 batch 用 `Season.animeId` 去重;Series 由用户语义聚合(同名跨季)
- `Series.id` / `Season.id` / `Episode.id` 一律 ulid,字段(kind/number/animeId)变更不影响 id 稳定性
- `WatchProgress` 挂 Episode 不挂 File:换清晰度源不丢进度
- 同集多源 = 一个 Episode + N 个 FileRef,`primaryFileId` 默认最高分辨率
- `FileRef.id = hash(hash16M + size)`:用户改名/移动 path 变,但 key 稳定 → 触发 relink 而非重建
- 同一文件出现在两根目录下(用户重复添加):`FileRef.libraryIds: string[]`(P3 落库前确认)
- 跨季独立 Series + `relatedAnimes` 前端聚合,**不强合并**(避免 dandanplay 跨季关系误判污染)
- **P1/P2 内存模式无 hash16M**:`EpisodeItem.id` 用 `name+size+mtime` 软 id,P3 落库时 rekey 到 `hash(hash16M+size)`,§7 迁移路径相应更新

---

## 4. 系列识别 Pipeline

```
Stage 1: 文件名归一化(anitomyscript / parse-torrent-title)
         input:  relPath
         output: { titleGuess, episode, kind, group, resolution }
         门槛:   置信度 ≥ 0.7 才进 Stage 2,否则进 Manual 桶

Stage 2: 同批次预聚类
         同目录优先 + titleGuess Jaro-Winkler ≥ 0.85 → 同 cluster
         中文 fast-levenshtein 字符级 / 日英 token 级
         跨目录: titleGuess 归一化(去空格/全半角/简繁)完全相等才合并候选

Stage 3: dandanplay 验证(权威源)
         每 cluster 取 1 个代表文件 → 前 16MB md5 + filename → /api/v2/match
         isMatched=true 单候选 → animeId 落库,自动归并
         isMatched=false 但有 matches[] → 标 ambiguous 等用户
         cluster 内其他文件用 filename + episode number 批量 match,共享 animeId

Stage 4: 用户纠错 UI 兜底
         拖拽合并/拆分 series · 手动绑定 animeId
         修正后写回 confidence=1, matchStatus='manual'
         同时存 ManualOverride 记忆 fileNamePattern → seriesId
```

### 置信度阈值
| 场景 | 置信度 | 处理 |
|---|---|---|
| dandanplay hash 命中 | 1.0 | 自动入库 |
| 仅 anitomy 命中 | 0.6 | 灰态待确认 |
| < 0.6 | — | 全部进"待整理"桶 |
| SP/OP/ED | — | 用 anitomy 的 `episodeType` 标 kind,**不混入正片排序** |

### Edge Cases

| Case | 检测 | 处理 |
|---|---|---|
| 同集多分辨率 | 同 cluster 同 episode 多 file | 合并 Episode.sources,默认最高分辨率 |
| 跨季多文件夹 | 不同 animeId 但同 bangumiId/系列 | **独立 Series** + relatedAnimes 前端聚合,不强合并 |
| SP/OVA/剧场版 | Stage 1 标 kind ≠ main | 同 series 下 kind 区分;剧场版若独立 animeId 则独立 series |
| 纯数字文件名 | titleGuess 为空 | 用同目录其他文件众数标题;还失败标 pending |
| 改名/移动 | path 变但 size+hash16M 不变 | 稳定 key 触发 relink 而非重建 |
| 一文件多候选 | dandanplay 返回多 match | matchStatus=ambiguous,前端弹选择器 |
| 多文件同 episodeId | 重复版本 | 按 resolution > size > mtime 排序,首位 primary |

### IndexedDB(建议 Dexie)

| 表 | 索引 |
|---|---|
| `libraries` | id |
| `series` | id, titleZh, updatedAt |
| `seasons` | id, seriesId, animeId(Season 的权威外键) |
| `episodes` | id, seriesId, episodeId, [seriesId+number] |
| `fileRefs` | id, episodeId, hash16M, matchStatus, **[libraryId+matchStatus](未归类区块查询)**, *libraryIds(multiEntry,文件跨 library) |
| `progress` | episodeId, watchedAt |
| `matchCache` | hash16M(7 天 TTL + LRU,2000 集量级才不爆) |
| `overrides` | seriesId, *normalizedTokens(multiEntry) |

**持久化**:全部元数据 + `FileSystemHandle`(IDB 原生支持,需 `requestPermission` 续权)
**不持久化**:`File` 对象、Blob URL、解码帧 — 启动时从 handle 重新 `getFile()`

---

## 5. UX/UI 蓝图

视觉锚点沿用现有 iOS Blue HUD 美学:
- 色:`#1c1c1e` 底 / `#38383a` 边框 / `#0a84ff` 主交互 / `#5ac8fa` teal 信息 / `#30d158` 完成绿
- 字:Sora(标题) + JetBrains Mono(HUD mono) + DM Sans(正文)
- HUD 元素:CornerBrackets / ChapterBar / SectionNum / mono uppercase 0.14em letterSpacing
- 卡片:radius 12 / border 1px #38383a / `backdrop-filter:blur(8px)` / hover translateY(-4px)

### 5.1 导航 + 入口
顶导新增 `[我的库 ⬡]` tab(`⬡` U+2B22 区别于圆形远端数据)。LibraryPage 空态即为大 DropZone,无需先进库再找入口。

### 5.2 DropZone 三态(扩展现有组件)

```
[空]    // LOCAL.LIBRARY //
        拖入视频文件或文件夹
        [选择文件] [选择文件夹]
        ──────────────────────────────
        ● 文件留在你的设备  不上传服务器

[hover] border → oklch(62% 0.17 210)  发光
        背景 → oklch(14% 0.04 210/0.55)
        文案变: 松手即开始解析

[解析中] ChapterBar scaleX 进度条 (底部)
         mono label: PARSING 23 / 47 FILES...
```

### 5.3 导入进度 — Drawer 不 Modal

右侧 420px Drawer,不阻断浏览。47 文件可能需 2+ 分钟,用户应能边看边浏览。

```
// IMPORT.QUEUE //                    [×]
──────────────────────────────────────────
✓ 进击的巨人 S4 EP01.mkv
  → 已归入 [进击的巨人 第四季]

⟳ [MATCHING] 进击的巨人EP02.mp4
  dandanplay 匹配中...

⚠ [LOW CONF 61%] 001.mp4
  候选: 进击的巨人 / 鬼灭之刃
  [选进击的巨人] [选鬼灭] [跳过]

✗ [UNKNOWN] random_file.avi
  [手动搜索] [创建本地系列] [跳]
──────────────────────────────────────────
完成 12/47  预计剩余 2 分钟
```

状态色:`✓ #30d158` / `⟳ #0a84ff pulse` / `⚠ #ff9f0a` / `✗ #ff453a`

### 5.4 LibraryPage(库浏览)

复用 `AnimeCard` 外壳,差异化标记:
- 左上 `⬡ LOCAL` badge(teal `#5ac8fa`)
- 底部 iOS Blue 已看进度条
- 无评分(无远端);有本地时长(mono 10px)

筛选 chip:`[最近播放] [新加入] [未看完] [已完结]` + `按季 ▾`
空态:居中 DropZone + `// NO FILES YET // 拖入视频开始归库`

### 5.5 LocalSeriesPage(系列详情)

复用 `AnimeDetailHero`:
```
[hero]   封面 + 名称 + TV·季番·集数 + ⬡ LOCAL + [+ 添加更多文件]
         ▓▓▓▓▓▓▓▓░░░░  已看 7 / 28
         [继续播放 EP08]

[tab]    [正片] [SP/OVA] [未归类]

EP01  ▶  进击的巨人 S4E1  00:24:05  ✓看过
EP08  ▶  ...              00:24:12  ⬤ 进行中 18:23
EP09  ▶  ...                        ○ 未看
  └─ 1080p · 480p  [切换源]    ← 折叠次级菜单

[文件来源]  从 2 个文件夹归并  [查看详情]
```

### 5.6 跨文件夹归并 UX(关键难点)

**自动合并 toast**:
```
⬡ 已合并  进击的巨人 第四季
   来自 2 个文件夹 (正片/ · SPs/)
   [撤销] [查看]
```
5s 自动消失,`[撤销]` 立即可点。

**系列管理面板**(右键卡片 / 详情页):
```
系列管理 — 进击的巨人 第四季

📁 /downloads/正片/
  ├ EP01.mkv  ✓
  └ EP02.mkv  ✓
📁 /downloads/SPs/
  └ SP01.mkv  ✓

[拆分此系列] [移出文件]
```

**多选合并**:LibraryPage 长按/勾选两卡片 → 顶部浮 `[合并为一个系列]` 操作条(iOS 批量模式)。

### 5.7 未识别兜底

LibraryPage 底部独立块(可折叠):
```
// UNCLASSIFIED //  3 个文件  [全部处理]
random_file.avi  [搜索归番] [创建本地系列] [忽略]
```
`[搜索归番]` 内联展开 ManualSearch(复用现有组件)。
`[创建本地系列]` 弹极简 form,产生无 dandanplay 的本地系列(占位封面 `⬡` + 首字符大字)。

### 5.8 PlayerPage 入参演化

```
P1: navigate('/player', { state: { file: File } })             // 现状
P3: navigate('/player', { state: {
      libraryEpisodeId: 'ep_uuid',
      seriesId: 'series_uuid',
      playlist: [ep1...ep28],
      episodeIndex: 7
    }})
```

PlayerPage 检测 `libraryEpisodeId` → IDB 取 handle → `handle.getFile()` → 走现有渲染路径。`EpisodeNav` 已有 prev/next,只需把 `playlist` 传入替代 `EpisodeFileList`。
HUD 状态条:`// LOCAL · 进击的巨人 S4 · EP08 //`

### 5.9 隐私感

每个导入相关 UI 固定显示:`● 文件存储在此设备 · 不上传服务器`(`#30d158` 绿点 pulse + 10px mono)。

### 5.10 新增视觉 token

| Token | 值 | 用途 |
|---|---|---|
| `PLAYER_HUE.local` | 210 | LOCAL 家族 |
| `--local-badge-color` | `#5ac8fa` | LOCAL badge 文字 |
| `--progress-track` | `oklch(62% 0.17 210 / 0.25)` | 进度条轨道 |
| `--progress-fill` | `#0a84ff` | 进度条填充 |
| `--unclassified-hue` | 40 (amber) | 未归类区块边框 |
| `⬡` glyph | U+2B22 | LOCAL 标识 |

---

## 6. 分期实施路线图

### 阶段总览

| 阶段 | 用户视角目标 | 工作量 | 累积价值 |
|---|---|---|---|
| **P0** | 单文件播放器(已上线 v1.0.17) | — | 基线 |
| **P1** | 一次拖入多文件,得到扁平剧集列表 | S | 减少重复拖拽 |
| **P2** | 同文件夹自动按集排序 + 会话断点 | S–M | 拖一季就能连看 |
| **P3** | 跨文件夹按系列归并 + IDB 持久库 + 系列卡片 | L | 真正的"本地库" |
| **P4** | 合并/拆分纠错 UI + 进度跨刷新持久 | M | 库可纠错可信赖 |
| **P5**(可选) | 后端同步、跨设备库 | M–L | 多端续看 |

### P1 — 多选导入(无分组)
- **切片**:DropZone 接受多文件 + `webkitdirectory`;`useVideoFiles` 返回数组;`EpisodeFileList` 用 `parseEpisodeNumber` 排序;当前播放索引 `useState`
- **修订 v2 必含**:**md5 worker pool 化** — `client/src/workers/md5.worker.js` 改造为可复用 worker,`PlayerPage` 改用固定 4-worker pool(`navigator.hardwareConcurrency` 上限)替代当前 `Promise.all(files.map(hashFile))` 一次开 N 个 `new Worker()` 的写法。47 文件场景实测会卡死磁盘 IO,这是 P1 阻塞性改动而非 P3。
- **不包含**:分组、跨文件夹归并、IDB、系列概念、进度持久化
- **里程碑**:定义会话期 `EpisodeItem` 形状(`id/file/parsedEp/parsedTitle/parsedKind`)——P3 schema 的种子;**软 id 用 `name+size+mtime`**(P1/P2 无 hash16M),P3 落库时 rekey 到 `hash(hash16M+size)`;URL 入参保 `?file=` 可选,多文件走内存
- **文件**:`DropZone.jsx` · `useVideoFiles.js` · `PlayerPage.jsx` · `utils/episodeParser.js` · **`workers/md5.worker.js`** · 新建 `lib/library/hashPool.js`(worker 池调度)
- **风险**:File 不可序列化 → 退路:仅会话有效,刷新失效(明示 toast)

### P2 — 同文件夹自动排序 + 会话断点
- **切片**:按 `directoryHandle/路径前缀` 分组(单 group);`usePlaybackSession` 扩展 per-episode `lastTime` Map(内存)
- **不包含**:跨文件夹合并、磁盘持久化、库视图
- **里程碑**:抽出 `lib/grouping.js` 纯函数 `(files) => Group[]`,**P3 直接复用**;冻结 `Group`/`Episode` JSDoc 接口
- **文件**:新建 `client/src/lib/grouping.js` · `client/src/lib/types.js`(JSDoc);改 `useVideoFiles.js` · `PlayerPage.jsx`
- **风险**:OVA/SP/跨季编号误判 → 退路:歧义就退化按字母序 + toast

### P3 — 跨文件夹归并 + 持久库(核心阶段)
> **修订 v2 工作量重评**:原"L"实际 4–6 周。新建文件清单 19 个 + IDB 迁移 + Dexie 选型 + Zod 校验 + FSA 兼容降级 + `useDandanMatch` 重写 + PlayerPage 入参四套兼容(`?file=` / `?groupId=` / `?seriesId=` / 旧 fallback)。

- **切片**:新增 `LibraryPage`(默认路由,Safari/Firefox 不支持 FSA 时**保留 `/player` 单文件作主入口**);引入 IDB(Dexie);`SeriesMatcher` 用 `Season.animeId` 作合并键;FSA `FileSystemFileHandle` 持久化引用(带回退);卡片点击进入 PlayerPage,入参改 `seriesId`
- **修订 v2 必含**:
  - **`useDandanMatch` 重写而非扩展**:抽出 `services/seriesMatcher.js::matchSingleCluster(cluster)` 纯函数(批量管线由 `importPipeline` 直接调);`useDandanMatch` 退化为单 series UI 适配器,仅服务于"快速播放"路径
  - **IDB 单事务包整 cluster 落库**:`db.transaction('rw', [series, seasons, episodes, fileRefs], async () => {...})` 包整段,防断电后留半截 series。Dexie 没原生跨表锁,必须显式 transaction
  - **Dexie schema v3 直接含 `updatedAt`**(不留到 P5)
  - **rename 触发 relink 改 lazy**:启动时不全量 `getFile()` 探测(2000 集成本爆炸),改在播放点击时检测,失败才触发 relink UI
  - **MKV 内嵌字幕 multi-source 处理**:同 episode 切源走 `usePlaybackSession.play()` 复用清理路径(不允许 mute swap);字幕样式(offset/fontSize)跟 episode,不跟 source
- **不包含**:用户手动合并/拆分、跨设备同步、进度持久化(仅文件路径与匹配结果持久)
- **里程碑**:确定 schema v3(含 updatedAt);选 Dexie;PlayerPage 同时支持旧 `?file=` 与新 `?seriesId=`(向后兼容);用 Zod 校验从磁盘读出的 series/season/episode 记录
- **文件**:新建 `pages/LibraryPage.jsx` · `components/library/SeriesCard.jsx` · `components/library/SeriesGrid.jsx` · `lib/library/db.js`(Dexie schema) · `lib/library/seriesRepo.js` · `lib/library/seasonRepo.js` · `lib/library/fileRefRepo.js` · `services/seriesMatcher.js`(纯函数 + `matchSingleCluster`);改 `App.jsx` 路由 · `PlayerPage.jsx` · `useDandanMatch.js`(**重写**) · `usePlaybackSession.js`(明确 multi-source 走 `play()` 复用)
- **风险**:(a) FSA Safari 不支持 → 回退非持久 File + LibraryPage 顶部 amber bar 告知;(b) dandanplay 误归并跨季 → 回退"按文件夹分卡"开关;(c) 并发 import 命中同 animeId → 单事务 transaction 兜底

### P4 — 纠错 UI + 进度持久
- **切片**:卡片菜单 `合并到…` / `从此卡拆出` / `重新匹配`;`ManualSearch` 升级为系列级;`progress` 表 per-episode `position/duration/finishedAt`;首页加"继续观看"行
- **修订 v2 必含 — localStorage → IDB 进度迁移**:
  - 新建 `lib/library/migrateLegacyProgress.js`,P4 上线时 one-shot 执行
  - 扫 localStorage 所有 `animego:progress:{anilistId|dandanAnimeId|bgmId}:{epNum}` 键
  - 按 `(anilistId|dandanAnimeId|bgmId, epNum)` 反查当前 IDB 中的 `Episode.id`(通过 `Series.bangumiId / Season.animeId + Episode.number`)
  - 命中则写入 `progress` 表,localStorage 键保留 30 天 TTL 自然过期(双写期);未命中保留 localStorage,等用户后续把对应文件入库时再迁移
  - **不做**:破坏性删 localStorage(老用户在 fallback 路径下仍可继续看)
- **里程碑**:schema v3 → v4 加 `progress` + `userOverride`(`overrideSeasonAnimeId` / `mergedFrom: seriesId[]` / `splitFrom: seriesId?` / `locked: boolean`);冲突策略:用户覆盖 > 自动匹配
- **修订 v2**:`ManualOverride` 同时记录拆分(反向规则),否则下次扫描相同文件还会自动合并;`override` 写回时按 `normalizedTokens` 索引,不裸文件名
- **文件**:新建 `MergeDialog.jsx` · `SplitDialog.jsx` · `lib/library/progressRepo.js` · `lib/library/migrateLegacyProgress.js` · `hooks/useResume.js`;改 `seriesMatcher.js` · `SeriesCard.jsx` · `HomePage.jsx`
- **风险**:override 与新匹配对账复杂 → 退路:`override` 绝对优先,自动匹配只填空;迁移脚本失败 → localStorage 兜底不删,用户至少能看

### P5(可选) — 后端同步
- **切片**:server 加 `series`/`episode_refs`/`progress` 集合(已有 Mongo);客户端 `lib/db` 抽象后端为另一种 `Repository<T>` 实现;冲突 `updatedAt` 取胜;文件指纹去重,**文件本身不上传**
- **风险**:隐私(文件名也算 PII)→ 退路:默认关闭、显式 opt-in、明示存哪些字段

---

## 7. 数据模型迁移路径(加列不删列)

```
P1 (内存)    EpisodeItem { id, file, parsedEp, parsedTitle }

P2 (内存)    + Group { groupKey, items[] }

P3 (IDB v3)  series   { id, animeId, title, cover, createdAt }
             episodes { id, seriesId, parsedEp, dandanEpId, fileRefId }
             fileRefs { id, handle, name, size }

P4 (IDB v4)  + progress      { episodeId, position, duration, finishedAt }
             + series.userOverride { animeId?, mergedFrom[]?, locked? }

P5 (Mongo)   镜像 P4 schema;syncAdapter 双向同步,updatedAt 决胜
```

### PlayerPage 入参向后兼容

```
P0/P1: ?file=               (内存 File)
P2:    ?groupId=&ep=        (内存 Group)
P3+:   ?seriesId=&ep=       (IDB Series)
旧链接 fallback 解析器进 group
```

---

## 8. 阶段依赖关系

- **P3 ← P1**:多文件 ingest 管线(DropZone + useVideoFiles 数组化)
- **P3 ← P2**:`lib/grouping.js` 纯函数被 `seriesMatcher` 复用(同文件夹优先归并)
- **P3 ← P0**:`useDandanMatch` 已能产 `animeId`,归并键现成
- **P4 ← P3**:必须有持久化的 `series` 才能 override
- **P5 ← P4**:必须有稳定的 `seriesId/episodeId` 才能跨设备合并

P2 不依赖 P1 之外的东西,**P1+P2 可两周内连发**,先解决"多文件支持"高频痛点。

---

## 9. 三个全局风险

1. **dandanplay 误匹配污染整个库**(一次错匹配 → 卡片库错位)
   - 缓解:P3 默认对低置信度匹配标"待确认"角标,不自动写入 `series.title`;P4 的 override 表是逃生通道

2. **File System Access API 浏览器分裂**(Safari/Firefox 不支持持久 handle)
   - 缓解:`fileRefs` 抽象层暴露 `isPersistent` 标志;不支持时降级为"会话库"+"重新指认文件夹"流程;不阻塞 P3 上线

3. **IndexedDB schema 升级翻车**(v3 → v4 中途崩溃留半截库)
   - 缓解:每次升级走 Dexie 版本化迁移 + P3 上线即提供"导出 JSON 备份"按钮;最坏情况清库重建只丢匹配结果不丢文件

---

## 10. 里程碑视图

- **第一周**:P1 完成并发布 v1.1(多文件可看)。承上启下:定型 `EpisodeItem` JSDoc 类型
- **第一月**:P2 完成 + P3 启动。已交付:单文件夹自动连看 + 会话续看。已开工:Dexie schema、`SeriesMatcher` 设计稿
- **三个月**:P3 上线(v1.3 库版)+ P4 收尾(v1.4 可纠错 + 持久续看)。P5 仅在用户实际反馈"想跨设备"时启动,避免 YAGNI

---

## 11. 相关文件路径速查

### 现有(改造)
- `client/src/pages/PlayerPage.jsx` — P1/P2/P3 入参三阶段改造
- `client/src/components/player/DropZone.jsx` — P1 多选改造
- `client/src/components/player/EpisodeNav.jsx` — playlist 参数扩展
- `client/src/components/player/ManualSearch.jsx` — 未归类兜底复用
- `client/src/components/anime/AnimeCard.jsx` — LocalCard 外壳复用
- `client/src/components/anime/AnimeDetailHero.jsx` — LocalSeriesPage hero 参考
- `client/src/components/shared/hud-tokens.js` — 新增 `PLAYER_HUE.local`
- `client/src/hooks/useVideoFiles.js` — P1/P2 ingest 管线
- `client/src/hooks/useDandanMatch.js` — P3 归并键来源 + 缓存命中短路
- `client/src/hooks/usePlaybackSession.js` — P2 会话续看 / P4 持久续看分叉点
- `client/src/utils/episodeParser.js` · `episodeMap.js` — P2 排序与 dandanplay 编号映射
- `client/src/App.jsx` — P3 新增 `/library` 路由
- `client/src/api/dandanplay.api.js` — P5 加 series sync 端点
- `server/` — 仅 P5 涉及

### 新建建议路径
- `client/src/lib/library/db.js` — Dexie schema + 升级
- `client/src/lib/library/fileHandleStore.js` — FSA handle 持久化
- `client/src/lib/library/grouping.js` — P2 引入,P3 复用
- `client/src/lib/library/importPipeline.js` — 4 阶段识别管线
- `client/src/lib/library/types.js` — JSDoc 接口
- `client/src/pages/LibraryPage.jsx`
- `client/src/pages/LocalSeriesPage.jsx`
- `client/src/components/library/{SeriesCard, SeriesGrid, ImportDrawer, MergeDialog, SplitDialog, UnclassifiedSection}.jsx`
- `client/src/hooks/{useLibrary, useImport, useEpisode, useResume}.js`
- `client/src/services/seriesMatcher.js`
