// P1 接口冻结 - 修改前请同步更新 docs/designs/implementPlayer.md §3

/**
 * P1/P2 内存模式的剧集条目。
 * 无持久化、无 hash16M(P1 末期 hash 完才有)。
 * P3 落库时 id 从 `name|size|mtime` 软 id rekey 到 `hash(hash16M+size)`。
 *
 * 字段名以 useVideoFiles 实际产物为准。
 *
 * @typedef {Object} EpisodeItem
 * @property {string}  fileId               - 软 id,格式 `name|size|mtime`
 * @property {File}    file                 - 原生 File 对象(不可序列化,仅会话有效)
 * @property {string}  fileName             - 文件名(file.name 的快照)
 * @property {string}  relativePath         - webkitRelativePath 或 fileName
 * @property {number|null} episode          - 从文件名解析出的集号(null 表示解析失败)
 * @property {{ file: File, fileName: string, episode: number|null, type: string }|null} [subtitle] - 配对字幕信息(null 表示无字幕)
 * @property {string}  [parsedTitle]        - 从文件名解析出的番剧标题
 * @property {number}  [parsedNumber]       - 从文件名解析出的集号
 * @property {'main'|'sp'|'ova'|'movie'|'pv'|'unknown'} parsedKind - 集类型
 * @property {string}  [parsedGroup]        - 字幕组(从括号标签提取)
 * @property {'480p'|'720p'|'1080p'|'2160p'} [parsedResolution]   - 分辨率标签
 * @property {string}  [hash16M]            - 首 16MB SparkMD5(P1 末期 hash 完才填入)
 */

// ─── P2 同文件夹分组冻结锚点(P3 SeriesMatcher 复用此形状) ────────────────────

/**
 * 同文件夹自动分组的产物(P2 引入,P3 SeriesMatcher 直接消费)。
 * 一次 `groupByFolder(EpisodeItem[])` 调用产出 `Group[]`,按 items.length desc / groupKey asc 排序。
 *
 * P3 演化:
 *   - `id` 在 P2 是会话内随机 ulid,P3 落库时 rekey 为 `hash(libraryId + groupKey)` 跨会话稳定
 *   - `groupKey` 即 P3 SeriesMatcher 跨 batch 归并的候选键(同 key 进同一 cluster)
 *   - `Series` 在 P3 含 `Group[]`,所以本形状必须冻结
 *
 * @typedef {Object} Group
 * @property {string}  id            - 会话内随机 id(P3 落库后 rekey 为稳定值)
 * @property {string}  groupKey      - 目录键(`relativePath` 的 dirname,根目录为 `__root__`)
 * @property {string}  label         - 给 UI 用的可读名(`groupKey` 末段;根目录显示 `(根)`)
 * @property {EpisodeItem[]} items   - 已排序(默认按 episode asc,歧义时按 fileName 字母序)
 * @property {'episode'|'alpha'} sortMode  - 排序模式;'alpha' 表示触发了歧义回退
 * @property {boolean} hasAmbiguity  - 同集号多 kind / 主线带空洞被 sp/ova 填补 等情况为 true
 */

// ─── P3 IDB 冻结锚点(P1 不实现,仅占位供阅读者对齐设计文档 §3) ──────────────

/**
 * Cluster of groups that share the same normalized title tokens.
 * Produced by clusterize(); consumed by seriesMatcher.
 *
 * @typedef {Object} MatchCluster
 * @property {string}   clusterKey          - FNV-1a 8-char hex hash of normalizedTokens.join('|'), or groupKey for singletons with empty tokens
 * @property {string[]} normalizedTokens     - token array used for bucketing
 * @property {Group[]}  groups              - 1+ groups merged because their parsedTitle normalizes equal
 * @property {EpisodeItem[]} items          - flattened, sorted by (groupKey, episode|fileName)
 * @property {EpisodeItem|null} representative - first item with episode!=null and parsedKind=='main', else first item overall
 * @property {number}   [animeIdHint]       - if any group's first item has parsedTitle matching priorSeasons normalized, prefilled
 */

/**
 * The result of matching a single MatchCluster against existing records or building new ones.
 *
 * @typedef {Object} MatchVerdict
 * @property {'reuse'|'new'|'ambiguous'|'failed'} kind
 * @property {string}  [seriesId]       - when kind='reuse'
 * @property {string}  [seasonId]       - when kind='reuse'
 * @property {number}  [animeId]        - when kind='reuse'
 * @property {Series}  [seriesRecord]   - when kind='new'
 * @property {Season}  [seasonRecord]   - when kind='new' (null when dandanplay not yet called)
 * @property {Episode[]} [episodeRecords] - when kind='new'
 * @property {FileRef[]} [fileRefRecords] - when kind='new'
 * @property {number}  [confidence]     - when kind='new', 0..1
 * @property {{ animeId:number, animeTitle:string, score:number }[]} [candidates] - when kind='ambiguous'
 * @property {string}  [reason]         - when kind='failed'
 */

/**
 * 系列(跨季聚合,id 永远不用 animeId 派生)。
 * animeId 已下放到 Season.animeId。
 *
 * @typedef {Object} Series
 * @property {string}  id              - ulid
 * @property {string}  [titleZh]
 * @property {string}  [titleJa]
 * @property {string}  [titleEn]
 * @property {'tv'|'movie'|'ova'|'web'} type
 * @property {number}  [bangumiId]
 * @property {string}  [posterUrl]
 * @property {number}  [totalEpisodes]
 * @property {number}  confidence      - 0..1,<0.7 需用户确认
 * @property {number}  createdAt
 * @property {number}  updatedAt
 */

/**
 * 季(dandanplay animeId 按季切分,animeId 是 Season 的权威外键)。
 *
 * @typedef {Object} Season
 * @property {string}  id              - ulid
 * @property {string}  seriesId
 * @property {number}  number          - S1 / S2
 * @property {number}  animeId         - dandanplay 每季独立 animeId
 * @property {number}  [totalEpisodes]
 * @property {number}  updatedAt
 */

/**
 * 单集(id 为 ulid,kind/number 仅作字段,变更不影响 id 稳定性)。
 * WatchProgress 挂 episodeId,换源不丢进度。
 *
 * @typedef {Object} Episode
 * @property {string}  id              - ulid(不再是 hash(seriesId+kind+number))
 * @property {string}  seriesId
 * @property {string}  [seasonId]
 * @property {number}  [episodeId]     - dandanplay episode id
 * @property {number}  number
 * @property {'main'|'sp'|'ova'|'movie'|'pv'} kind
 * @property {string}  [title]
 * @property {string}  primaryFileId
 * @property {string[]} alternateFileIds
 * @property {number}  updatedAt
 */

/**
 * 文件引用(id = hash(hash16M+size),用户改名/移动 path 变但 key 稳定)。
 *
 * @typedef {Object} FileRef
 * @property {string}  id              - hash(hash16M + size)
 * @property {string}  libraryId
 * @property {string}  [episodeId]     - 未匹配时为空
 * @property {string}  relPath         - 相对 root
 * @property {number}  size
 * @property {number}  mtime
 * @property {string}  [hash16M]
 * @property {'480p'|'720p'|'1080p'|'2160p'} [resolution]
 * @property {'raw'|'sub'} [source]
 * @property {string}  [group]
 * @property {string}  [codec]
 * @property {'pending'|'matched'|'manual'|'ambiguous'|'failed'} matchStatus
 * @property {{ animeId: number, episodeId: number, score: number }[]} [matchCandidates]
 */

/**
 * 观看进度(挂 episodeId 不挂 file,换源不丢进度)。
 *
 * @typedef {Object} WatchProgress
 * @property {string}  episodeId
 * @property {number}  positionSec
 * @property {number}  durationSec
 * @property {number}  watchedAt
 * @property {boolean} completed
 */

/**
 * 用户手动纠错记忆(基于 anitomy 归一化 token,不裸文件名)。
 *
 * @typedef {Object} ManualOverride
 * @property {string}   seriesId
 * @property {string[]} normalizedTokens  - anitomy 归一化后的标题 token 数组
 * @property {number}   updatedAt
 */
