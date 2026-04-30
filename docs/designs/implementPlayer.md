# 播放器板块:单文件 → 本地影音库

> 设计文档 · 2026-04-29 · **修订 v3.1 · 2026-04-30(T7 真实文件系统验真后)** · v3 · 2026-04-30(业界案例调研后) · v2 · 2026-04-29(工程 review 后)
> 目标:把播放器板块从"单文件即播"演进为"多文件/多文件夹导入 → 自动归集系列 → 库浏览 → 选集播放",并处理"同一动漫散在不同文件夹"的核心难题。

---

## 0a. 修订记录

**v3.1(2026-04-30 真实文件系统验真后必改)**

针对 `/Volumes/T7 Shield/files for MacBook` 实测(88 视频 entry + 49 目录 + 41 个 `._*` AppleDouble + 5 个 `.DS_Store`)补 3 条 P1 阻塞性。

A. **`.mp4` package 探测**:macOS ExFAT 上 `.mp4` 常以目录形态出现(`drwx------`,`file <name>.mp4` 返回 `directory`),内层才是真文件且常用日文原名(外层 `Heavenly Delusion` 内层 `Tengoku Daimakyou`)。§4 新增 **Stage 0 文件枚举**:目录名末尾匹配视频扩展时下钻一层取同扩展最大文件;`._*` / `.DS_Store` / `size < 1MB` 的疑似 mp4 全部跳过。原 Stage 1 直裸吃 FSA `.values()` 在这盘上命中数 = 0。详见 §4 Stage 0。

B. **根目录散落文件不应用同目录簇**:T7 根 7 个散文件全是不同番(Heavenly Delusion / Jigokuraku / Gundam Mercury PROLOGUE vs 主篇 …),Stage 2 "同目录优先" 会塌成单簇并错合;J-W 还会把 PROLOGUE ↔ 主篇错聚。FSA 根 handle 视为"无目录信号",每文件独立 seed,直接进 Stage 3 dandanplay 仲裁。详见 §4 Stage 2 v3.1。

C. **NFC 归一化 + `Episode.version` + `OpsLog` 表**:macOS HFS+ NFD vs Linux ExFAT 字节序 → 跨平台再导入会重复建库;`v2` 修订版本(`[01v2]`)需进 `primaryFileId` 选择优先级;§5.6 24h 撤销/操作日志在原 §3 schema 完全缺失。新增:`Episode.version` 字段、`OpsLog` 表、所有字符串入库前 `String.prototype.normalize('NFC')`。详见 §3。

---

**v3(2026-04-30 业界案例调研后必改)**

调研对照 7 个参考项目(uosc_danmaku / wiidede/dandanplay-vi / miru / NipaPlay-Reload / excalidraw / Sonarr / Plex Fix Match)+ npm 生态共识,补 15 条。详细参考案例与依赖锁清单见新增 **§12**。

> **附:UI wireframe 已落地** — 见 §5.0(4 张手写 HTML 稿 + 索引板,使用真 DESIGN.md token,无 AI 漂移)。

P1 阻塞性:

1. **md5 worker 用 `workerpool` 库 + SparkMD5 增量切片**:9KB gzip,内置队列+超时+terminate;`maxWorkers = min(4, hardwareConcurrency-1)`;worker 内必须把 16MB 切 8×2MB `append()` 增量,峰值 2MB/worker。否则 47 worker × 16MB ≈ 752MB 瞬时堆 + 47 路磁盘 seek = **当前卡死的真因**。详见 §6 P1。
2. **anitomy 选型明确**:主用 `yjl9903/anitomy`(纯 TS port,中文场景优化),失败回退 `parse-torrent-title`。详见 §6 P1。

P3 必改:

3. **FSA `requestPermission()` 必须挂用户点击事件**,**不能在 `useEffect` 里跑**(Chromium issue 41471861:transient user activation 在 await 后即丢失,弹窗永不显示)。LibraryPage 检测 `queryPermission()` 返回 `'prompt'` 时,渲染显式"重授权"按钮。详见 §3 失败模式 + §6 P3。
4. **dandanplay 多候选不无条件吃 `matches[0]`**:`isMatched=true && matches.length > 1` 也要进 Stage 4 用户选(uosc_danmaku 已知 bug 警示)。详见 §4 Stage 3。
5. **跨季 keyword 拼接策略**:Stage 2 J-W 之外,加"把 `第N季` / `第一季` 别名拼回 query"再 search(uosc 路线,中文场景有效)。详见 §4 Stage 2。
6. **Dexie 复合索引语法明确**:`fileRefs: 'id, [libraryId+matchStatus]'`(中括号包字段对、`+` 号分隔,**不是逗号**)。详见 §4 IDB 表 + §6 P3。
7. **Dexie 升级容错 — `migrationState` 表**:每次 `upgrade()` 入口先 `put({v: N, status: 'in-progress'})`,完成改 `done`;启动检测 `in-progress` 显式补跑(Dexie #942:升级中断后新 version 已写但 upgrade 不重跑)。详见 §6 P3。
8. **schema 升级前自动 JSON 备份**:用 `dexie-export-import`(同作者官方插件)落 OPFS;UI 加"导出库 JSON"按钮(LibraryPage 设置区)作降版本兜底(Dexie #1599 不能降版本)。详见 §6 P3 + §9 风险 3。

P4 必改:

9. **`migrateLegacyProgress()` 必须幂等**:用 `db.progress.put()` 而非 `add()`(中断重跑不报 ConstraintError);反查失败的记录写 `migrationFailures` 表而非吞掉。详见 §6 P4。

UX 调整(Apple Photos / Material / tinyMediaManager 范式):

10. **撤销 toast 增强**:5s 是 Material 推荐下限,刚好;加 *hover/触摸暂停计时*,系列详情页保留 24h 操作日志兜底(Google Photos 不可撤销合并是反例)。详见 §5.6。
11. **拆分 / 重新匹配主入口 = 详情页 Actions menu**:卡片右键作快捷;移动端无右键,详情页是唯一合理位置(Plex / Jellyfin 共识)。详见 §5.6。
12. **低置信度候选 inline 优先**:灰态卡 + ⚠ + 显示前 2 候选按钮内联;点"更多候选"才进 modal(tinyMediaManager 阈值之下不静默自动)。详见 §5.3 + §5.7。
13. **iOS 多选模式细化**:进入选择态后导航栏变(`Cancel` + `Select All`),底部 toolbar 只放 1-2 主操作;桌面端 shift-click 等价。详见 §5.6。

阈值经验:

14. **J-W 阈值加遥测**:0.85 偏严(uosc 实战 0.75)。保留 0.85 + 加遥测埋点 `stage4_trigger_rate`,3 月后看;>30% 降到 0.80。详见 §4 置信度阈值。

依赖锁:

15. **依赖清单冻结**:`anitomy`(yjl9903) / `parse-torrent-title` / `workerpool` / `spark-md5` / `browser-fs-access` / `dexie` + `dexie-export-import` / `idb-keyval`。详见 §12.2。

---

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
| `client/src/workers/md5.worker.js` | 首 16MB hash | **P1 必改**(`workerpool` 库 + SparkMD5 增量 2MB×8 切片,见 §6 P1) |
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
  version: number;         // 修订 v3.1: 修订版本(`[01v2]` → 2,默认 1);primaryFileId 优先级 = version > resolution > size > mtime
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

interface OpsLog {           // 修订 v3.1: §5.6 的 24h 撤销与系列详情页操作日志在原 schema 缺失
  id: string;                // ulid
  seriesId: string;
  ts: number;
  kind: 'merge' | 'split' | 'rematch' | 'delete' | 'unfile';
  payload: unknown;          // 操作前快照,撤销时回写
  undoableUntil: number;     // ts + 24h;过期 GC
}
```

### 设计要点
- `animeId` 是 **Season** 的权威外键(不是 Series),跨 batch 用 `Season.animeId` 去重;Series 由用户语义聚合(同名跨季)
- `Series.id` / `Season.id` / `Episode.id` 一律 ulid,字段(kind/number/animeId)变更不影响 id 稳定性
- `WatchProgress` 挂 Episode 不挂 File:换清晰度源不丢进度
- 同集多源 = 一个 Episode + N 个 FileRef,`primaryFileId` 优先级 = `version > resolution > size > mtime`(v3.1)
- `FileRef.id = hash(hash16M + size)`:用户改名/移动 path 变,但 key 稳定 → 触发 relink 而非重建
- 同一文件出现在两根目录下(用户重复添加):`FileRef.libraryIds: string[]`(P3 落库前确认)
- 跨季独立 Series + `relatedAnimes` 前端聚合,**不强合并**(避免 dandanplay 跨季关系误判污染)
- **P1/P2 内存模式无 hash16M**:`EpisodeItem.id` 用 `name+size+mtime` 软 id,P3 落库时 rekey 到 `hash(hash16M+size)`,§7 迁移路径相应更新
- **v3.1: NFC 归一化强制**:所有入库字符串(`relPath` / `normalizedTokens` / `Series.title*` / `Episode.title`)写入前必须 `String.prototype.normalize('NFC')`。macOS HFS+ 默认 NFD,Linux ExFAT 按字节存,跨平台再导入若不归一化会重复建库。建议落点:Stage 0 enumerator yield 的 `relPath` + Stage 1 anitomy 输出 title;Stage 2 比较前已归一化无需再做。

---

## 4. 系列识别 Pipeline

```
Stage 0: FSA 文件枚举 + 噪声过滤(v3.1 新增,T7 验真后必跑)
         input:  FileSystemDirectoryHandle root
         output: AsyncIterable<{ handle, relPath: NFC, depth }>
         规则:
           skip:  name.startsWith('._') || name === '.DS_Store'
                  || name === 'Thumbs.db'  // Windows
                  || (kind === 'file' && hasVideoExt(name) && size < 1MB)
                                           // 4KB AppleDouble 伪 mp4
           file:  kind === 'file' && hasVideoExt(name) → yield (NFC 归一化 relPath)
           dir:   kind === 'directory':
                  - if hasVideoExt(name) && depth === 0:
                       // macOS .mp4 package(ExFAT 实测形态:
                       // 外层目录名带 .mp4,内层才是真文件,常用日文原名)
                       → 下钻一层,选 size 最大同扩展名文件 yield
                       → 内层 `_<name>.mp4` AppleDouble 由 size<1MB 兜过
                  - else if depth < 3 → 递归
                  - else → 截断(避免病态深嵌套)
         T7 验真:88 视频 entry → 过滤 41 个 `._*` + 5 个 `.DS_Store` +
                 package 外壳后,期望剩 ≈40-50 真视频。
                 < 30 即规则有漏,DropZone 必须 toast"枚举异常"。

Stage 1: 文件名归一化(anitomyscript / parse-torrent-title)
         input:  relPath(已 NFC 归一化)
         output: { titleGuess, episode, kind, group, resolution, version }
         门槛:   置信度 ≥ 0.7 才进 Stage 2,否则进 Manual 桶
         v3.1:   解出尾缀 `v2` / `v3` 写入 episode.version(默认 1)
                 输出 titleGuess 再 .normalize('NFC') 一次(冗余但廉价)

Stage 2: 同批次预聚类
         同目录优先 + titleGuess Jaro-Winkler ≥ 0.85 → 同 cluster
         中文 fast-levenshtein 字符级 / 日英 token 级
         跨目录: titleGuess 归一化(去空格/全半角/简繁)完全相等才合并候选
         跨季增强(v3): anitomy 解出 season > 1 时, query 拼 title + " 第N季"
                       (N=1 时双查 "第一季" / "第1季") 再做 dandanplay /search,
                       优先 Season 级精确命中(uosc_danmaku 路线,中文有效)
         **根目录特例(v3.1)**:
                       cluster 锚定目录 == FSA 根 handle 时,**禁用同目录簇**,
                       每文件独立 seed cluster 直接入 Stage 3。
                       T7 根 7 个散文件全是不同番(Heavenly Delusion / Jigokuraku /
                       Gundam Mercury PROLOGUE / 主篇 …),"同目录优先" 会塌成一个
                       垃圾大簇;J-W 还会把 PROLOGUE ↔ 主篇错合(J-W ≥ 0.90),
                       必须由 dandanplay animeId 仲裁。

Stage 3: dandanplay 验证(权威源)
         每 cluster 取 1 个代表文件 → 前 16MB md5 + filename → /api/v2/match
         isMatched=true && matches.length === 1 → animeId 落库,自动归并
         isMatched=true && matches.length > 1   → 走 Stage 4 (v3:不无条件吃
                                                  matches[0],uosc_danmaku 已知 bug)
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

**v3 阈值校准**:Jaro-Winkler 0.85 偏严(uosc_danmaku 实战 0.75)。P3 上线后加遥测埋点 `stage4_trigger_rate`,3 个月后看触发率;>30% 即调到 0.80。

### Edge Cases

| Case | 检测 | 处理 |
|---|---|---|
| 同集多分辨率 | 同 cluster 同 episode 多 file | 合并 Episode.sources,默认最高分辨率 |
| 跨季多文件夹 | 不同 animeId 但同 bangumiId/系列 | **独立 Series** + relatedAnimes 前端聚合,不强合并 |
| SP/OVA/剧场版 | Stage 1 标 kind ≠ main | 同 series 下 kind 区分;剧场版若独立 animeId 则独立 series |
| 纯数字文件名 | titleGuess 为空 | 用同目录其他文件众数标题;还失败标 pending |
| 改名/移动 | path 变但 size+hash16M 不变 | 稳定 key 触发 relink 而非重建 |
| 一文件多候选 | dandanplay 返回多 match | matchStatus=ambiguous,前端弹选择器 |
| 多文件同 episodeId | 重复版本 | v3.1: `version > resolution > size > mtime`,首位 primary |
| **(v3.1) `.mp4` 是目录** | macOS ExFAT package — `kind==='directory' && hasVideoExt(name)` | Stage 0 下钻一层取同扩展最大文件;内层 `._*` 由 size<1MB 兜过 |
| **(v3.1) `._*` 4KB 伪 mp4** | `name.startsWith('._') \|\| size < 1MB` | Stage 0 直接跳过,绝不入 hash/match 队列 |
| **(v3.1) 同系列两种拼写** | T7 实测:外层文件夹 `Akiba Maid Sensou` ↔ 内层文件 `Akiba_Maid_War`(J-W≈0.79) | Stage 2 J-W 失败 → Stage 3 dandanplay,以 `animeId` 合并 |
| **(v3.1) 外层中/内层日文不一致** | `[Airota][Heavenly Delusion]…mp4/[Airota][Tengoku Daimakyou]…mp4` | Stage 0 取内层文件作匹配输入;`Series.titleZh` 从外层目录名取(用户认知),`titleJa` 从内层 anitomy.title 取 |

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
| `opsLog`(v3.1) | id, [seriesId+ts], undoableUntil — 24h 撤销快照 + 系列详情页操作日志(§5.6) |

**持久化**:全部元数据 + `FileSystemHandle`(IDB 原生支持,需 `requestPermission` 续权)
**不持久化**:`File` 对象、Blob URL、解码帧 — 启动时从 handle 重新 `getFile()`

---

## 5. UX/UI 蓝图

视觉锚点沿用现有 iOS Blue HUD 美学:
- 色:`#1c1c1e` 底 / `#38383a` 边框 / `#0a84ff` 主交互 / `#5ac8fa` teal 信息 / `#30d158` 完成绿
- 字:Sora(标题) + JetBrains Mono(HUD mono) + DM Sans(正文)
- HUD 元素:CornerBrackets / ChapterBar / SectionNum / mono uppercase 0.14em letterSpacing
- 卡片:radius 12 / border 1px #38383a / `backdrop-filter:blur(8px)` / hover translateY(-4px)

### 5.0 Approved Mockups(2026-04-30)

✅ **手写 HTML wireframe** — 全部使用 [DESIGN.md](../../DESIGN.md) 真 token + §5.10 新增 5 个 token,无 AI 漂移,可直接照搬到 React。

**索引板**:`~/.gstack/projects/lawrenceli0228-animego/designs/local-library-ui-20260430/00-design-board.html`(`open` 即可在浏览器查看 4 张稿的 iframe 预览 + 覆盖矩阵 + 决策问题)

| # | Wireframe | 对应小节 | 关键视觉决策 |
|---|---|---|---|
| **01** | [`01-library-page.html`](../../../.gstack/projects/lawrenceli0228-animego/designs/local-library-ui-20260430/01-library-page.html) | §5.1 / §5.4 / §5.7 / §5.10 | 4 列卡片网格(1100/720 断点 → 3/2 列)· 8 张样本卡覆盖 4 种状态(in-progress / done / NEW / 多分辨率)· 底部"未归类"暖色面板(amber 左 3px) |
| **02** | [`02-local-series-page.html`](../../../.gstack/projects/lawrenceli0228-animego/designs/local-library-ui-20260430/02-local-series-page.html) | §5.5 / §5.6 / §5.8 锚点 / §5.10 | Hero 复用 `AnimeDetailHero` · 三 tab(正片 / SP·OVA / 未归类 ⚠)· 集列表三态(✓ ▶ ○)+ EP08 脉冲环 · `└─ 2 个文件源` 折叠子行 · 24h 操作日志 + 高级操作区(error 左边线) |
| **03** | [`03-import-drawer.html`](../../../.gstack/projects/lawrenceli0228-animego/designs/local-library-ui-20260430/03-import-drawer.html) | §5.3 / §5.7 / §5.9 | 460px 抽屉(scrim+blur 库背景)· 进度计 12/47 + 四色 stat · 四态分组 ✓ ⟳ ⚠ ✗ · **v3 内联候选范式**:`⚠` 文件行下方左 2px 暖色边线展开 2 候选 + "都不是·手动搜索",不开模态框 |
| **04** | [`04-dropzone-states.html`](../../../.gstack/projects/lawrenceli0228-animego/designs/local-library-ui-20260430/04-dropzone-states.html) | §5.2 / §5.9 / a11y | 三态并排:空(虚线灰)/ hover(accent 边 + 网格缓动)/ 解析中 · ChapterBar 47 格 + 当前格 `cellPulse` 动画 · 4 色 stat 同步 · 底部 spec table 列触发/视觉/出口/a11y |

**未画**:§5.8(`PlayerPage` 入参演化是 nav state 形状变化,非视觉);可在 P3 实装时直接读 §5.8 文字描述。

**5 个待决策问题**(详见 `00-design-board.html` Q1-Q5):顶栏 vs 侧栏 / ⬡ 徽标位置 / 多源折叠 vs 下拉 / 候选内联 vs 模态 / 未归类位置。当前稿都按倾向方案画(顶栏 / 左上 / 折叠 / 内联 / 底部面板),实施前确认即可。

**实装映射**(P3 起):
- `01-library-page.html` → `client/src/pages/LibraryPage.jsx`(新)+ `LocalSeriesCard` 复用 `AnimeCard`
- `02-local-series-page.html` → `client/src/pages/LocalSeriesPage.jsx`(新)+ `EpisodeRow` / `MultiSourceFold` 子组件
- `03-import-drawer.html` → `client/src/components/library/ImportDrawer.jsx`(新)
- `04-dropzone-states.html` → 扩展现有 `client/src/components/player/DropZone.jsx`(加 hover/parsing 态)

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

**v3 — 低置信度 inline 范式**:`⚠ [LOW CONF]` 行只显示**前 2 候选按钮**(命中率最高的两条),第 3 条起折叠为 `[更多候选 ▾]`,展开成 modal 列全候选 + 手输 `tvdbId/anilistId/dandanAnimeId`(tinyMediaManager:阈值之下不静默自动)。

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
5s 自动消失(Material 推荐下限),`[撤销]` 立即可点。

**v3 增强**:hover/触摸时**暂停计时**;系列详情页固定保留 24h "最近操作"日志,toast 错过仍可回溯撤销(Google Photos 不可撤销合并是反例,用户怨声载道)。

**系列管理面板**(v3:**详情页 Actions menu 主入口**;桌面端右键卡片作快捷;移动端无右键,详情页是唯一合理位置 — Plex / Jellyfin 共识):
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
**v3 细化**:进入选择态后**导航栏变化**(`Cancel` 替主标题 + `Select All` 副位),底部 toolbar 只放 1-2 主操作(`合并为系列` / `标记忽略`),避免变菜单(Apple HIG);桌面端 shift-click 等价。

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
- **修订 v3.1 必含(T7 真实文件系统验真后 — Stage 0 必跑)**:
  - **新建 `lib/library/enumerator.js`** 实现 §4 Stage 0 完整规则(`._*` / `.DS_Store` / `Thumbs.db` 跳过、`size < 1MB` 跳过、`.mp4`-package 下钻、`depth < 3` 限制、`relPath` 立刻 NFC 归一化)。Stage 1/2/3 全部消费这个 `AsyncIterable`,**不再直裸吃 FSA `directoryHandle.values()`**。
  - **DropZone 验收门槛**:本地 `/Volumes/T7 Shield/files for MacBook` 跑 enumerator 期望 `[40, 50]` 真视频(原始 88 entry,过滤 41 `._*` + 5 `.DS_Store` + package 外壳后)。<30 即规则有漏,toast"枚举异常,请检查驱动器"并阻止 import 继续。
  - **NFC 归一化兜底**:`enumerator` yield 的 `relPath` 已 NFC;`anitomy.title` / `parsedTitle` 输出后再 `.normalize('NFC')` 一次,作为 `Series.title*` / `Episode.title` 入库源。验真:同一盘在 macOS 与 Linux ExFAT 下分别导入,`Series.id` 应一致(若 ulid 重发可比 `titleZh + Season.animeId`)。
  - **测试样本固化**:新建 `tests/fixtures/t7-real-names.json` 抽 12 条真实文件名(覆盖中文文件夹 + 日罗马字内层 + 字幕组括号 + `[01v2]` 修订 + 全半角混排 + `Akiba_Maid_War` ↔ `Akiba Maid Sensou` 双拼写),Stage 0 + Stage 1 单测必跑;Stage 2 根目录特例单独测(7 散文件 → 7 cluster,不是 1)。
- **修订 v3 必含(库选型 + 内存防护 + 文件名解析)**:
  - **池化用 `workerpool` npm 包**(9KB gzip,2.3k★,内置队列+超时+terminate),`maxWorkers = Math.min(4, (navigator.hardwareConcurrency || 4) - 1)`(给主线程留 1),`maxQueueSize: 200`,`pool.exec('hashHead16MB', [file]).timeout(10_000)`。Comlink 是 RPC 不是池;手写 ~150 行不值得替代 9KB 依赖。
  - **SparkMD5 必须用增量 API**:worker 内把 16MB 切成 8 × 2MB 块 `new SparkMD5.ArrayBuffer().append(chunk)`,峰值 2MB/worker(4 worker = 8MB)。否则 47 worker × 16MB 一次读 ≈ **752MB 瞬时堆 + 47 路磁盘 seek = 当前卡死的真因**。
  - **anitomy 选型明确**:主用 `yjl9903/anitomy`(纯 TS port,无 native,中文场景优化),失败回退 `parse-torrent-title`(通用、TS 类型完整)。原文档"anitomy/PTT"模糊,v3 锁定。
- **不包含**:分组、跨文件夹归并、IDB、系列概念、进度持久化
- **里程碑**:定义会话期 `EpisodeItem` 形状(`id/file/parsedEp/parsedTitle/parsedKind`)——P3 schema 的种子;**软 id 用 `name+size+mtime`**(P1/P2 无 hash16M),P3 落库时 rekey 到 `hash(hash16M+size)`;URL 入参保 `?file=` 可选,多文件走内存
- **文件**:`DropZone.jsx` · `useVideoFiles.js` · `PlayerPage.jsx` · `utils/episodeParser.js` · **`workers/md5.worker.js`** · 新建 `lib/library/hashPool.js`(worker 池调度) · **新建 `lib/library/enumerator.js`(v3.1)** · **新建 `tests/fixtures/t7-real-names.json`(v3.1)**
- **风险**:File 不可序列化 → 退路:仅会话有效,刷新失效(明示 toast);**v3.1 风险:Stage 0 规则未覆盖 NTFS / Btrfs / Win 路径分隔符 → 退路:首版仅在 macOS+ExFAT 验真,跨平台延后到 P3**

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
- **修订 v3 必含(业界案例调研后)**:
  - **FSA `requestPermission()` 必须挂用户点击事件**,**不能在 `useEffect` / `useDirectoryHandle` 启动 hook 里直接 `await`**(Chromium issue 41471861:transient user activation 在 await 后丢失,弹窗永不显示;WICG/file-system-access #289:IDB 取出的 handle 几乎总返回 `'prompt'`)。LibraryPage 检测 `queryPermission()` 返回 `'prompt'` 时,渲染显式"重授权"按钮,**用户点击事件回调内同步调** `requestPermission({mode:'read'})`
  - **dandanplay 多候选不无条件吃 `matches[0]`**:`isMatched=true && matches.length > 1` 也走 Stage 4(uosc_danmaku 已知 bug 警示);仅 `matches.length === 1` 才自动归并
  - **跨季拼 keyword 兜底**:见 §4 Stage 2 v3 增强,Stage 2 失败时回退 keyword 查
  - **Dexie 复合索引语法**:`fileRefs: 'id, episodeId, hash16M, matchStatus, [libraryId+matchStatus], *libraryIds'`(中括号包字段对、`+` 号分隔,**不是逗号**;`*` 前缀是 multiEntry)。语法写错索引建不上,查询直接 fullscan
  - **Dexie 升级容错 — `migrationState` 表**:每次 `upgrade()` 入口先 `tx.table('migrationState').put({v: N, status: 'in-progress'})`,完成改 `done`;app 启动时检测 `in-progress` 显式补跑或恢复(Dexie #942:升级中断后新 version 已写但 upgrade 函数不会再调用)
  - **每次升级前自动 JSON 备份**:用 `dexie-export-import`(同作者官方插件)落 OPFS `:/animego/backup-v3.json`,失败可 `db.import()`;LibraryPage 加显式"导出库 JSON"按钮(设置区)作降版本兜底(Dexie #1599:不能降版本,回滚旧代码 `VersionError`)
  - **依赖锁清单**:`dexie` + `dexie-export-import` + `idb-keyval`(handle 单 key 存,excalidraw `LocalData.ts` 同款)+ `browser-fs-access`(单文件场景的 `<input>`/`<a>` 降级,目录递归与持久化仍自写)
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
- **修订 v3 必含(幂等 + 失败可观测)**:
  - `migrateLegacyProgress()` 必须**幂等**:写 `progress` 表用 `db.progress.put()` 而非 `add()`,中断重跑不报 ConstraintError
  - 反查失败的记录不能吞:写到独立 `migrationFailures` 表(`{key, reason, attemptedAt}`),用户后续入库新文件时由 `relinkProgress()` 二次反查
  - 包在同一 Dexie transaction 内(`'rw', [progress, migrationFailures]`),避免半写
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
- `client/src/lib/library/db.js` — Dexie schema + 升级 + `migrationState` 表(v3)
- `client/src/lib/library/fileHandleStore.js` — FSA handle 持久化(`idb-keyval` 单 key,excalidraw `LocalData.ts` 同款)+ 用户点击事件触发 `requestPermission()`(v3)
- `client/src/lib/library/grouping.js` — P2 引入,P3 复用
- `client/src/lib/library/importPipeline.js` — 4 阶段识别管线
- `client/src/lib/library/hashPool.js` — `workerpool` 实例(`maxWorkers = min(4, hwConcurrency-1)`,2MB×8 增量 SparkMD5)(v3 P1)
- `client/src/lib/library/migrateLegacyProgress.js` — localStorage→IDB 进度迁移(P4)+ `migrationFailures` 表写入(v3)
- `client/src/lib/library/dbBackup.js` — `dexie-export-import` 包装,升级前自动 OPFS 备份 + UI"导出库 JSON"入口(v3)
- `client/src/lib/library/types.js` — JSDoc 接口
- `client/src/pages/LibraryPage.jsx` — 含"重授权"按钮(FSA permission prompt)+"导出库 JSON"按钮(v3)
- `client/src/pages/LocalSeriesPage.jsx` — 含"最近操作"24h 撤销日志 + Actions menu(拆分/重新匹配)(v3)
- `client/src/components/library/{SeriesCard, SeriesGrid, ImportDrawer, MergeDialog, SplitDialog, UnclassifiedSection}.jsx`
- `client/src/hooks/{useLibrary, useImport, useEpisode, useResume}.js`
- `client/src/services/seriesMatcher.js` — `matchSingleCluster()` 纯函数 + 跨季拼 `第N季` keyword(v3)

---

## 12. 参考案例与依赖锁清单(v3 调研产出)

### 12.1 7 个最相关参考项目

| # | 项目 | 栈 | 借鉴点 |
|---|---|---|---|
| 1 | [Tony15246/uosc_danmaku](https://github.com/Tony15246/uosc_danmaku) | MPV Lua | 4 阶段 pipeline 1:1 对齐 / 16MB MD5 / `apis/dandanplay.lua` 调用范式 / 跨季 keyword 拼接 / J-W 0.75 实战阈值;**警示**:`matches[0]` 直接吃是已知 bug |
| 2 | [wiidede/dandanplay-vi](https://github.com/wiidede/dandanplay-vi) | Vue3+TS | 浏览器 + Web Worker md5 + Artplayer 集成模板;但单文件级,无 Series 归集 / 无 FSA 持久 |
| 3 | [ThaUnknown/miru (hayase)](https://github.com/ThaUnknown/miru) | Svelte+WebTorrent | 完整 Series→Episode 数据模型 / 续看挂 Episode / `anitomyscript` 原作者;主体走 BT 流不是 FSA,只抄数据模型与字幕架构 |
| 4 | [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) — `excalidraw-app/data/LocalData.ts` | React PWA | FSA + `idb-keyval` 存 handle 生产级范本 / `requestPermission()` 续权 UX |
| 5 | [MCDFsteve/NipaPlay-Reload](https://github.com/MCDFsteve/NipaPlay-Reload) | Flutter 多端 | dandanplay 弹幕 + Bangumi 进度同步 + 番剧管理 UI 范式 / 手动选集兜底交互 |
| 6 | [Sonarr Manual Import](https://github.com/Sonarr/Sonarr/issues/2946) | C# | 表格行内选剧集 + select-all 批改 / 歧义文件留队列 — UX 范式 |
| 7 | [Plex Fix Match](https://support.plex.tv/articles/201018497-fix-match-match/) | 商用 | 候选海报+简介 modal / Search Options 切外部 ID;低置信度时进 modal 的标杆 |

**结论**:implementPlayer.md v3 这个具体组合在 GitHub **没有 1:1 现成方案**。最接近的栈是 *dandanplay-vi(纯前端 + ddp 弹幕匹配) + miru(Series 模型 + anitomy) + NipaPlay(手动选集 UI) + excalidraw(FSA 持久化)* 拼接。

### 12.2 npm 依赖锁清单

| 包 | 用途 | 选型理由 |
|---|---|---|
| `anitomy` (yjl9903) | 文件名解析(P1/P2) | 纯 TS port,中文优化;比 `anitomyscript`(emscripten)体积小,比 `parse-torrent-title` 中文表现好 |
| `parse-torrent-title` | anitomy 失败回退 | 通用、TS 类型完整 |
| `workerpool` | md5 worker 池(P1) | 9KB gzip,内置队列+超时+terminate;Comlink 是 RPC 不是池,手写 ~150 行不值得 |
| `spark-md5` | hash 计算(P1) | **必须用增量 API**(2MB×8 切片 `append()`),不要一次读 16MB |
| `browser-fs-access` (Chrome Labs) | FSA 降级(P3) | 业界事实标准,**只解决单文件 API 形态统一**,不管 IDB 持久化;目录 + 持久化仍要自写 |
| `dexie` + `dexie-export-import` | IDB(P3/P4) | 同作者,版本迁移 + JSON 备份兜底标配 |
| `idb-keyval` | handle 单 key 存 | excalidraw 生产同款,无依赖、API 极小 |

### 12.3 没有现成 hook 包装的事实

业界没有把 (a) IDB 持久化 + (b) `queryPermission` 续权 + (c) 懒探测 + (d) Safari 降级 四件套做齐的 React hook。`TimMikeladze/use-file-system`(17★,2025-07 更新)只有 (a) 和 polling;`Fivex-Labs/react-use-file-system`(0★,单 commit)不可信。

**结论**:**自写 `useDirectoryHandle()` + `usePersistentHandle()` 共 ~150 行**,核心逻辑参考 excalidraw `excalidraw-app/data/LocalData.ts`。

### 12.4 已知坑速查(从调研收集)

| 来源 | 坑 | 兜底 |
|---|---|---|
| Chromium issue 41471861 | `requestPermission()` 在 await 后失去 transient user activation | 必须挂用户**点击事件**同步调,不能在 `useEffect` 跑 |
| WICG/file-system-access #289 | IDB 取出的 handle 几乎总返回 `'prompt'` | 显式"重授权"入口,不假装无感 |
| Dexie #942 | upgrade 中途崩溃,新 version 已写但 upgrade 函数不再调用 | `migrationState` 表显式补跑 |
| Dexie #1599 | 不能降版本(回滚旧代码 `VersionError`) | UI 埋"导出库 JSON",最坏清库重导 |
| uosc_danmaku 实战 | `matches[0]` 直接吃 → 跨季误归并 | `matches.length > 1` 走 Stage 4 |
| Google Photos | "合并不可撤销"用户怨声载道 | toast 5s + 24h 操作日志双层兜底 |
| SparkMD5 一次读 16MB | 47 worker × 16MB ≈ 752MB 瞬时堆 → 卡死 | 切 2MB×8 增量 `append()` |
| Material Design Snackbar | 5s 是带 action 的下限,低于读不完 | 5s + hover 暂停 + 24h 详情页日志 |
| Apple HIG Selection | 批量模式工具栏过满变菜单 | toolbar 只放 1-2 主操作 |

### 12.5 调研引用

- [Chrome FSA + IndexedDB 官方指南](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access) · [Chrome persistent permissions blog](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api)
- [Dexie Version.upgrade()](https://dexie.org/docs/Version/Version.upgrade()) · [dexie-export-import](https://dexie.org/docs/ExportImport/dexie-export-import)
- [dandanplay 官方 FAQ — 加载弹幕](https://doc.dandanplay.com/faq/load-danmaku.html) · [Open Platform Swagger](https://api.dandanplay.net/swagger/index.html)
- [Material Design 3 Snackbar guidelines](https://m3.material.io/components/snackbar/guidelines)
- [Apple HIG Selection and Input](https://developer.apple.com/design/human-interface-guidelines/selection-and-input)
- [tinyMediaManager Quickstart](https://www.tinymediamanager.org/docs/quickstart) — 阈值 92% 才自动 + 多完美匹配拒绝自动
