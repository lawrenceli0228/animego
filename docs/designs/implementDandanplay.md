# AnimeGo dandanplay 弹幕播放器系统设计

> **状态：** 设计中
> **分支：** community-phase4
> **依赖：** Phase 4 数据层（bgmId、episodeTitles 已实现）

---

## 目标

在 AnimeGo 中接入 dandanplay 弹幕 API，让用户加载本地视频文件夹后自动匹配弹幕并播放。

**核心差异化：** 利用 AnimeCache 已有的 `bgmId` 实现零等待自动匹配，比 dandanplay-vi（需要 MD5 计算）体验更好。

---

## 参考项目

- **dandanplay-vi**：https://github.com/wiidede/dandanplay-vi
  - 浏览器端弹幕播放器，拖入本地视频自动匹配弹弹Play弹幕
  - 技术栈：Vue 3 + Pinia + Element Plus
  - 匹配流程：MD5(前16MB) → POST /match → GET /comment/{episodeId}
  - 弹幕解析：`p.split(',')` 提取 time/mode/color
  - CORS 解决：自建代理 `dandan-proxy.wiidede.space`
  - **AnimeGo 借鉴**：弹幕解析逻辑、withRelated 聚合多源、匹配步骤 UI
  - **AnimeGo 不需要**：MD5 Worker、文件匹配流程（已有 bgmId 桥梁）、视频播放器集成（dandanplay-vi 用 nPlayer/ArtPlayer/CCL，AnimeGo 统一用 ArtPlayer）

---

## dandanplay API 概览

**Base URL：** `https://api.dandanplay.net`

**认证方式（Credential Mode）：**
- `X-AppId`: 环境变量 `DANDANPLAY_APP_ID`
- `X-AppSecret`: 环境变量 `DANDANPLAY_APP_SECRET`

### 使用的端点

| 端点 | 用途 |
|------|------|
| `GET /api/v2/bangumi/bgmtv/{bgmtvSubjectId}` | 用 bgmId 获取 dandanplay 番剧详情 + 集数列表 |
| `GET /api/v2/bangumi/{animeId}` | 用 dandanplay animeId 获取集数列表 |
| `GET /api/v2/search/anime?keyword=` | 搜索番剧 |
| `POST /api/v2/match` | 文件匹配（降级用） |
| `GET /api/v2/comment/{episodeId}?withRelated=true&chConvert=1` | 获取弹幕 |

### 弹幕原始格式

```
{ cid: number, p: "时间,模式,颜色,用户ID", m: "弹幕文本" }

p 字段:
  时间: 秒 (float, 精度 0.01)
  模式: 1=滚动, 4=底部, 5=顶部
  颜色: RGB 整数 (R*65536 + G*256 + B)
  用户ID: 字符串

withRelated=true: 聚合 B站 + AcFun + dandanplay 自有弹幕
chConvert=1: 自动转简体
```

### 限流

dandanplay 无固定限流，但有异常检测自动节流。服务端复用 `rateLimitedFetch` 模式（800ms/请求）。

---

## 路由 & 导航

### 新增路由

```
/player → <PlayerPage />
```

### Navbar 扩展

```js
// Navbar.jsx 链接数组
[['/', 'nav.home'], ['/season', 'nav.season'], ['/search', 'nav.search'], ['/player', 'nav.player']]
```

### i18n

```
nav.player → 中: '播放' / 英: 'Player'
```

---

## 页面状态机

```
PlayerPage 状态:

  IDLE → PARSING → MATCHING → READY → PLAYING
                      │
                      ↓
                   MANUAL ──→ READY
```

| 状态 | 展示 | 触发 |
|------|------|------|
| IDLE | DropZone（拖放/选择文件夹） | 初始 |
| PARSING | 文件列表 + 解析进度 | 文件夹选定后 |
| MATCHING | 三步匹配进度条 | 解析完成后自动 |
| MANUAL | 搜索框 + 结果列表 | 所有自动匹配失败 |
| READY | 番剧信息 + 集数列表 + 播放按钮 | 匹配成功 |
| PLAYING | 全宽视频播放器 + 弹幕 + 集数导航 | 点击播放 |

### 状态管理

```jsx
const [phase, setPhase] = useState('IDLE')
const [videoFiles, setVideoFiles] = useState([])
// [{ file: File, episode: number|null, fileName: string }]
const [matchResult, setMatchResult] = useState(null)
// { anime, episodeMap, source }
const [playingEp, setPlayingEp] = useState(null)
```

不需要 Context——文件状态只在 `/player` 页面内，用户离开再回来重新选即可。

---

## UI 设计

### IDLE — 拖放区

```
┌────────────────────────────────────────────────────────────┐
│                                                            │
│  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐  │
│                                                            │
│  │     拖入番剧文件夹  或  点击选择                      │  │
│        mkv · mp4 · avi · webm                              │
│  │                                                     │  │
│  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘  │
│                                                            │
│     也可以选择单个视频文件                                   │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

**DropZone 视觉规格（对齐 DESIGN.md）：**
- 外层容器: 居中，`max-width: 600px`，margin `--sp-3xl` (64px) auto
- 虚线框: `border: 2px dashed var(--separator)` (rgba(84,84,88,0.65)), `border-radius: var(--radius-lg)` (16px)
- 内部 padding: `--sp-2xl` (48px)
- 图标: 📂 文件夹图标 48px，颜色 `--text-tertiary`
- 主文字: Sora 600 18px `--text`，"拖入番剧文件夹 或 点击选择"
- 副文字: DM Sans 400 14px `--text-tertiary`，"mkv · mp4 · avi · webm"
- 拖入悬停态: `border-color: var(--accent)`, 背景 `var(--accent-dim)`, transition 150ms
- 底部链接: "也可以选择单个视频文件" DM Sans 400 14px `--accent`
- 同时支持 `<input webkitdirectory>` (文件夹) 和 `<input accept="video/*">` (单文件)
- 单文件模式跳过文件名解析，直接走 dandanplay /match

### MATCHING — 三步进度

```
已加载: MyAnime/  (12 个视频文件)                   x 清除

  ① 文件解析   ✅ 12 个视频, 关键词: "进击的巨人"
  ② 番剧匹配   ⏳ 搜索 AnimeCache...
  ③ 弹幕映射   ⬜ 等待匹配完成
```

**匹配进度视觉规格：**
- 容器: `--bg-card` (#1c1c1e), `--radius` (12px), padding `--sp-lg` (24px)
- 顶部"已加载"行: DM Sans 500 14px `--text`，"✕ 清除"按钮右对齐 Ghost 样式
- 步骤行: 行高 40px，左侧 ①②③ 数字 DM Sans 500 `--text-secondary`
- 当前步骤: 文字 `--accent`，左侧 spinner 替代数字
- 已完成步骤: ✅ `--success` (#30d158)，文字 `--text`
- 待处理步骤: 数字 `--text-quaternary`，文字 `--text-tertiary`
- 失败步骤: ✖ `--error` (#ff453a)，文字 `--text-secondary`

步骤 ② 内部三级降级对用户透明：
1. AnimeCache 搜索 → 找到 bgmId → 成功
2. dandanplay /match (fileNameOnly) → 成功
3. dandanplay /match (hashAndFileName, 需前端算 MD5) → 成功
4. 全部失败 → 进入 MANUAL

### MANUAL — 手动搜索

```
自动匹配未成功，请手动搜索番剧名

┌──────────────────────────────────┐  🔍
│ 进击的巨人                        │
└──────────────────────────────────┘

  🎬 進撃の巨人 The Final Season
     2022 春季 · TV · 16集 · ★ 85          [选择]

  🎬 進撃の巨人 Season 3
     2019 春季 · TV · 22集 · ★ 90          [选择]
```

搜索源：AnimeCache + dandanplay /api/v2/search/anime，结果合并去重。

**搜索结果样式：** 列表布局（非网格），每行一个结果。左侧 60×84px 封面（`--radius-sm`），右侧标题 + 元数据。行高 100px，间距 `--sp-sm`。[选择] 按钮用 Ghost 样式 `--bg-fill`。结果少于 5 个时不需要滚动。不复用 AnimeCard 网格，因为搜索结果数量少且需要横向信息密度。

### READY — 集数列表

```
┌───────┐  進撃の巨人 The Final Season
│ cover │  进击的巨人 最终季
│       │  2022 春季 · TV · 16集
└───────┘  弹幕源: dandanplay · 16 集已映射        ✕ 清除

**番剧信息区视觉规格：**
- 封面: 120×168px, `--radius-sm` (8px), object-fit cover
- 标题: Sora 600 24px `--text` (h2 scale)
- 中文标题: DM Sans 400 16px `--text-secondary`
- 元数据: DM Sans 400 14px `--text-tertiary`, 用 · 分隔
- 弹幕源标签: `--teal` 背景 `--teal-dim`, DM Sans 500 13px
- "✕ 清除": Ghost 按钮右上角对齐

  EP01  [SubGrp] Shingeki - 01 [1080p].mkv       ▶
  EP02  [SubGrp] Shingeki - 02 [1080p].mkv       ▶
  EP03  [SubGrp] Shingeki - 03 [1080p].mkv       ▶
  ...

  ─────────────────────────────────────────────────
  ⚠ 未匹配: NCOP.mkv, NCED.mkv (非正片)
```

**信息优先级：**
1. 番剧信息区（封面 + 标题 + 元数据） — 页面顶部，一眼确认匹配对了
2. 集数列表 — 主区域，每行一集，点击即播
3. 未匹配文件 — 列表底部分隔线之后，`--text-tertiary` 色，不干扰主流程

**集数列表视觉规格：**
- 行高 48px，padding `--sp-md` (16px)
- 奇数行背景 `transparent`，偶数行 `rgba(120,120,128,0.06)` (微弱交替)
- Hover: 背景 `--accent-dim` (rgba(10,132,255,0.12))，▶ 图标变 `--accent` 蓝
- 集数号 DM Sans 500 `--text`，文件名 DM Sans 400 `--text-secondary`
- ▶ 播放图标 20px，颜色 `--text-tertiary`，hover 变 `--accent`

弹幕在点击播放时才拉取，避免一次性 N 个 API。

### PLAYING — 视频播放

```
┌────────────────────────────────────────────────────────────┐
│ ← 返回列表                   EP03 · 进击的巨人             │
│ ┌────────────────────────────────────────────────────────┐ │
│ │                                                        │ │
│ │          ← 弹幕在这里飞 →       ← 弹幕 →               │ │
│ │                                                        │ │
│ │              ArtPlayer + danmuku plugin                 │ │
│ │                                                        │ │
│ │  ▶ ━━━━━━━━━━━━●━━━━━━━━━━━━━━━  12:34 / 24:00       │ │
│ │  🔄弹幕  ⚙设置  🔊音量                        ⛶全屏   │ │
│ └────────────────────────────────────────────────────────┘ │
│                                                            │
│   ◀ EP02          ● EP03 (当前)          EP04 ▶           │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

**视觉层次（z-index 由下到上）：**
1. **视频层** — 占满内容宽度，`aspect-ratio: 16/9`，背景 `#000`
2. **弹幕层** — ArtPlayer danmuku plugin 管理，覆盖在视频上方
3. **控制条** — ArtPlayer 内置，底部渐变浮现（hover/touch 触发）
4. **顶部栏** — 半透明 `rgba(0,0,0,0.6)` 背景，显示"← 返回列表"和"EP03 · 进击的巨人"
5. **集数导航** — 视频下方固定区域，不在视频内部

**信息优先级：** 视频 > 弹幕 > 进度条 > 集数切换 > 返回按钮

**底部集数导航：** 切集自动换文件 + 重新加载弹幕，横向滚动当集数 > 12

**导航回退路径：**
- PLAYING → "← 返回列表" → READY（保留匹配结果）
- READY → "✕ 清除" → IDLE（释放所有 blob URL）
- MATCHING → "✕ 清除" → IDLE（中断匹配流程）
- MANUAL → "← 返回" → MATCHING（重试自动匹配）或 "✕ 清除" → IDLE

---

## 交互状态设计

每个 UI 功能的 loading / empty / error / success / partial 状态：

| 功能 | LOADING | EMPTY | ERROR | SUCCESS | PARTIAL |
|------|---------|-------|-------|---------|---------|
| **DropZone** | — | 默认态：虚线框 + 图标 + 提示文字 | 拖入非文件夹内容：虚线框变 `--error` 红色 1s，toast "请拖入文件夹" | 文件夹选中后立即切 PARSING | — |
| **文件解析** | Skeleton 列表（3行占位），"正在扫描文件..." `--text-secondary` | "文件夹中没有视频文件" + 图标 + "支持: mkv, mp4, avi, webm" `--text-tertiary` + "重新选择"按钮 | — (纯前端，不会失败) | 显示文件数 + 关键词 | — |
| **三步匹配** | 当前步骤 spinner + `--accent` 高亮，已完成步骤 ✅ 绿色，待处理步骤灰色 | — | 步骤 icon 变 ✖ `--error`，该步文字变"匹配失败"，自动尝试下一级 | 步骤 icon ✅ `--success`，显示匹配源 | — |
| **MD5 计算** | 进度条 `--accent`，"正在计算文件特征... X%" | — | "计算失败，跳过此步" `--warning`，继续降级 | 静默完成，进入下一步 | — |
| **手动搜索** | 输入框下方 Skeleton 卡片（2个占位） | "未找到相关番剧，试试其他关键词" + 搜索图标 `--text-tertiary` | API 失败：输入框下方 toast "搜索服务暂时不可用" | 结果列表（复用 AnimeCard 样式） | — |
| **集数映射** | — | — | — | 全部匹配：所有集数显示 ▶ 按钮 | 部分匹配：已匹配集绿色 ▶，未匹配集灰色"未找到弹幕"，仍可播放（无弹幕） |
| **弹幕加载** | 视频正常播放，弹幕区域显示小 spinner | 0 条弹幕：视频正常播放，底部小提示"该集暂无弹幕" `--text-tertiary` | 视频正常播放，toast "弹幕加载失败" 3s 自动消失 | 弹幕飞起来 | — |
| **视频播放** | ArtPlayer 内置 loading spinner（黑底白色） | — | 格式不支持：播放区域显示"该视频格式不受支持，建议使用 Chrome 浏览器" + 支持格式列表 | 视频播放 | — |

**核心原则：**
- 弹幕加载失败/为空 **不阻塞** 视频播放
- 匹配失败 **不阻塞** 手动搜索降级
- 所有 error toast 使用 `--error` 背景，3s 自动消失
- 所有 loading 用 `Skeleton` 组件（已有）或 ArtPlayer 内置 spinner

---

## 用户旅程

| 步骤 | 用户行为 | 用户感受 | 设计支撑 |
|------|---------|---------|---------|
| 1. 进入 /player | 看到 DropZone | 好奇，"这个页面做什么？" | DropZone 中心放大号图标 + 清晰引导文案，不需要额外说明 |
| 2. 拖入文件夹 | 拖入或点击选择 | 期待，"能认出来吗？" | 拖入时虚线框变 `--accent` 蓝色反馈，松开后立即切状态 |
| 3. 看到匹配进度 | 等待 2-5 秒 | 轻微焦虑，"别太久" | 三步进度让等待可预期。每步完成即刻 ✅ 反馈。不要 spinner 转圈 |
| 4a. 自动匹配成功 | 看到番剧封面 + 集数列表 | 惊喜，"自动认出来了！" | 封面 + 标题区要醒目，这是"成功感"的来源。匹配源标注"来自 AnimeGo 数据库" |
| 4b. 匹配失败 | 看到手动搜索框 | 小失望，但有路 | 预填关键词（从文件名提取），减少输入。提示"自动匹配未成功"而非"失败" |
| 5. 点击播放 | 视频开始，弹幕飞出 | **核心爽点** — "弹幕出来了！" | 弹幕出现瞬间是整个功能的 payoff。弹幕加载要快（缓存优化），第一条弹幕要尽快可见 |
| 6. 切集 | 点下一集 | 顺滑，"不用重新选文件" | 切集转场 < 500ms。新弹幕加载时旧弹幕不要突然消失，视频先播放 |
| 7. 看完关闭 | 离开页面 | 满足 | 无需保存状态，下次来重新选就好 |

**情感高点：** 步骤 4a（自动识别）和步骤 5（弹幕飞起来）。这两个时刻的反馈速度和视觉冲击力决定了功能的口碑。

**情感低谷：** 步骤 4b（匹配失败）。设计目标是让这个时刻"不痛"，预填关键词 + 搜索结果秒出。

---

## 弹幕匹配流程

### 三级降级

```
前端: 文件夹 → 过滤视频 → 解析文件名(关键词 + 集数号)
         │
         ↓
后端: POST /api/dandanplay/match { keyword, episodes, fileName }
         │
         ├─ 阶段1: AnimeCache 搜索 (keyword LIKE titleChinese/Native/Romaji/English)
         │    → 找到 → bgmId → dandanplay /bangumi/bgmtv/{bgmId} → episodeId 列表
         │    → 未找到 ↓
         │
         ├─ 阶段2: dandanplay /match (fileNameOnly)
         │    → POST { fileName, fileHash:"", fileSize:0, matchMode:"fileNameOnly" }
         │    → 匹配 → animeId → dandanplay /bangumi/{animeId} → episodeId 列表
         │    → 未匹配 → 返回 { matched:false, needHash:true }
         │
         ↓
前端: 收到 needHash → 算首文件 MD5(前16MB, SparkMD5)
         │
         ↓
后端: POST /api/dandanplay/match { fileHash, fileName, fileSize }
         │
         ├─ 阶段3: dandanplay /match (hashAndFileName)
         │    → 匹配 → animeId → episodeId 列表
         │    → 未匹配 → 返回 { matched:false, needHash:false }
         │
         ↓
前端: 全部失败 → MANUAL 状态 → 用户手动搜索选择
```

### Phase 1 番剧信息富化降级（siteAnime）

当 dandanplay combined /match 成功后，controller 需要回填 AnimeCache 里的元数据（score/genres/format/studios/cover），前端才能渲染「查看详情」卡片。由于 dandanplay 返回的 `animeTitle` 通常是中文（如 `秋叶原女仆战争`），而用户文件夹名常是英文/罗马音（如 `Akiba Maid Sensou`），单用 dandanplay 标题命中 AnimeCache 的概率不稳定。

`findSiteAnime(title, userKeyword)` 用 3 级降级命中 AnimeCache：

```
  1. searchAnimeCache(dandanplay title)       命中 → 返回
     未命中 ↓
  2. searchAnimeCache(user keyword)           命中 → 返回   (REGRESSION 修复点)
     未命中 ↓
  3. bangumi.fetchBangumiData → bgmId         → AnimeCache.findOne({ bgmId })
     2s 超时 / 抛错 / 未命中 → 返回 null
```

全部 miss 时返回 `siteAnime: null`，`matched:true` 不受影响；客户端 `EpisodeFileList.jsx` 的 `{sa && (...)}` 已自然降级为「只显示标题+封面」。bgm.tv 降级包在 2s `Promise.race` 里，任何 `fetchBangumiData` 异常均被 `.catch(() => null)` 吞掉，保证 `/match` 不挂。

测试：`server/__tests__/dandanplay.controller.test.js` 覆盖 6 条路径（title hit / keyword hit regression / bgmId 降级 / all miss / 异常吞掉 / 2s 超时）。

### 文件名解析

```js
// episodeParser.js

const VIDEO_EXTS = /\.(mkv|mp4|avi|webm|flv|rmvb|mov|wmv|ts|m4v)$/i

function isVideoFile(fileName) {
  return VIDEO_EXTS.test(fileName)
}

// 从文件名提取集数号
function parseEpisodeNumber(filename) {
  const patterns = [
    /S\d+E(\d+)/i,                    // S01E03
    /EP?\s*(\d+)/i,                   // EP03, E03, EP 03
    /第(\d+)[話话集]/,                // 第03話, 第3集
    /\s-\s(\d+)\s/,                   // " - 03 " (字幕组常见)
    /\[(\d+)(?:v\d+)?\]/,            // [03], [03v2]
    /(?:^|\D)(\d{2,3})(?:\D|$)/,     // 兜底: 独立的 2-3 位数字
  ]
  for (const re of patterns) {
    const m = filename.match(re)
    if (m) return parseInt(m[1], 10)
  }
  return null
}

// 从文件名提取番剧关键词
function parseAnimeKeyword(filename) {
  let name = filename
    .replace(VIDEO_EXTS, '')           // 去后缀
    .replace(/\[[^\]]*\]/g, '')        // 去方括号标签 [SubGroup] [1080p]
    .replace(/\([^)]*\)/g, '')         // 去圆括号标签
    .replace(/\b\d{3,4}[Pp]\b/g, '')   // 去分辨率
    .replace(/\b(HEVC|AVC|x26[45]|H\.?26[45]|AAC|FLAC)\b/gi, '')
    .replace(/\b(WEB-?DL|WebRip|BDRip|Blu-?[Rr]ay)\b/gi, '')
    .trim()

  // " - 03" 格式: 取分隔符之前的部分作为标题
  const dashMatch = name.match(/^(.+?)\s+-\s+\d+/)
  if (dashMatch) return dashMatch[1].trim()

  // EP03 格式: 取 EP 之前
  const epMatch = name.match(/^(.+?)\s*EP?\s*\d+/i)
  if (epMatch) return epMatch[1].trim()

  return name.replace(/\s+\d+\s*$/, '').trim() || null
}
```

---

## 两路弹幕分流

视频播放弹幕和社区弹幕是两个独立系统：

```
┌─ VideoPlayer (ArtPlayer) ──────────────────────┐
│  dandanplay 弹幕 (全量, 视频时间轴同步)          │
│  time/mode/color 完整使用                       │
│  按需拉取, 内存缓存 30min, 不持久化              │
└────────────────────────────────────────────────┘

┌─ DanmakuSection (现有, 不改动) ────────────────┐
│  用户自产弹幕 (社区聊天式飞行)                    │
│  WebSocket 实时, MongoDB 持久化                  │
│  无时间码, 纯文本                                │
└────────────────────────────────────────────────┘
```

### 弹幕格式转换 (前端)

dandanplay 原始格式 → ArtPlayer danmuku 插件格式：

```js
// dandanplay mode → ArtPlayer mode
//   1(滚动) → 0
//   4(底部) → 2
//   5(顶部) → 1

const MODE_MAP = { 1: 0, 4: 2, 5: 1 }

function dandanToArtplayer(raw) {
  const [time, type, color] = raw.p.split(',').map(Number)
  return {
    text: raw.m,
    time,
    mode: MODE_MAP[type] ?? 0,
    color: '#' + color.toString(16).padStart(6, '0'),
  }
}
```

---

## 后端设计

### 新增文件

```
server/
  services/dandanplay.service.js       ← API 调用 + 缓存
  controllers/dandanplay.controller.js
  routes/dandanplay.routes.js
```

### API 端点

#### POST /api/dandanplay/match

```
Request:
{
  keyword?: string,         // 文件名解析出的番剧关键词
  episodes?: number[],      // 需要匹配的集数列表
  fileName?: string,        // 首文件名 (降级用)
  fileHash?: string,        // MD5 (第三级降级用)
  fileSize?: number         // 文件大小 (MD5 模式需要)
}

Response (成功):
{
  matched: true,
  anime: {
    anilistId: 16498,       // 来自 AnimeCache 时有值
    titleChinese: "进击的巨人",
    titleNative: "進撃の巨人",
    titleRomaji: "Shingeki no Kyojin",
    coverImageUrl: "...",
    episodes: 25
  },
  episodeMap: {
    "1": { dandanEpisodeId: 158301, title: "致两千年后的你" },
    "2": { dandanEpisodeId: 158302, title: "那一天" },
    ...
  },
  source: "animeCache" | "dandanplay"
}

Response (需要 MD5 降级):
{ matched: false, needHash: true }

Response (全部失败):
{ matched: false, needHash: false }
```

#### GET /api/dandanplay/search?keyword=

```
Response:
{
  results: [
    {
      source: "animeCache",
      anilistId: 16498,
      title: "進撃の巨人",
      titleChinese: "进击的巨人",
      coverImageUrl: "...",
      episodes: 25,
      bgmId: 12189
    },
    {
      source: "dandanplay",
      dandanAnimeId: 731,
      title: "进击的巨人",
      episodes: 25,
      imageUrl: "..."
    }
  ]
}
```

#### GET /api/dandanplay/comments/:dandanEpisodeId

```
Response (直接转发 dandanplay 原始数据):
{
  count: 5024,
  comments: [
    { cid: 12345, p: "120.5,1,16777215,abc", m: "燃起来了" },
    ...
  ]
}

缓存: 内存 Map, 30 分钟 TTL
```

### dandanplay.service.js 结构

```
认证: X-AppId + X-AppSecret (process.env.DANDANPLAY_APP_ID / _APP_SECRET)
限流: 复用 rateLimitedFetch 模式 (MIN_INTERVAL = 800ms)

导出函数:
  searchAnimeCache(keyword)        → AnimeCache 模糊搜索
  fetchDandanEpisodes(bgmId)       → /bangumi/bgmtv/{bgmId} → episodeId 映射
  fetchDandanEpisodesByAnimeId(id) → /bangumi/{animeId} → episodeId 映射
  matchByFileName(fileName)        → /match (fileNameOnly)
  matchByHash(fileName, hash, size)→ /match (hashAndFileName)
  searchDandanAnime(keyword)       → /search/anime
  fetchComments(episodeId)         → /comment/{id}?withRelated=true&chConvert=1

缓存:
  commentCache: Map<episodeId, { data, fetchedAt }>  TTL 30min
  episodeCache: Map<bgmId, { episodes, fetchedAt }>  TTL 24h
```

---

## 前端文件结构

```
client/src/
  pages/
    PlayerPage.jsx                  ← 主页面 (状态机控制)

  components/player/
    DropZone.jsx                    ← 拖放区 + input[webkitdirectory]
    MatchProgress.jsx               ← 三步匹配进度 (借鉴 dandanplay-vi)
    ManualSearch.jsx                ← 手动搜索降级 UI
    EpisodeFileList.jsx             ← 匹配后的集数-文件列表
    VideoPlayer.jsx                 ← ArtPlayer + danmuku 封装
    EpisodeNav.jsx                  ← 底部集数切换条

  hooks/
    useVideoFiles.js                ← 文件夹管理 + 集数解析
    useDandanMatch.js               ← 匹配 API + 三级降级状态
    useDandanComments.js            ← 弹幕拉取 (tanstack query)

  utils/
    episodeParser.js                ← parseEpisodeNumber + parseAnimeKeyword

  api/
    dandanplay.api.js               ← axios 封装
```

### VideoPlayer.jsx (ArtPlayer 封装)

```jsx
// 核心用法
import Artplayer from 'artplayer'
import artplayerPluginDanmuku from 'artplayer-plugin-danmuku'

function VideoPlayer({ videoUrl, danmakuList, onEnded }) {
  const containerRef = useRef(null)
  const artRef = useRef(null)

  useEffect(() => {
    const art = new Artplayer({
      container: containerRef.current,
      url: videoUrl,              // URL.createObjectURL(file)
      autoSize: true,
      fullscreen: true,
      plugins: [
        artplayerPluginDanmuku({
          danmuku: danmakuList,   // dandanToArtplayer 转换后的数组
          speed: 5,
          opacity: 0.8,
          fontSize: 24,
          antiOverlap: true,
          synchronousPlayback: true,
          emitter: false,         // 不需要发送功能
        }),
      ],
    })
    artRef.current = art
    return () => art.destroy()
  }, [videoUrl])

  // 弹幕数据变化时重新加载
  useEffect(() => {
    if (artRef.current?.plugins?.artplayerPluginDanmuku) {
      artRef.current.plugins.artplayerPluginDanmuku.load(danmakuList)
    }
  }, [danmakuList])

  return <div ref={containerRef} style={{ width: '100%', aspectRatio: '16/9' }} />
}
```

---

## 文件夹上传设计

### 浏览器能力

| 能力 | 支持 |
|------|------|
| `file.webkitRelativePath` | 能 — 相对路径如 `MyAnime/EP03.mkv` |
| 绝对路径 | 不能 — 浏览器安全限制 |
| 读取文件内容 | 能 — `URL.createObjectURL()` 播放, `file.slice()` 算 MD5 |
| 持久化访问 | 不持久化 — 离开页面后丢失, 用户重新选择 |

### DropZone 实现要点

```jsx
// 文件夹: <input type="file" webkitdirectory />
// 单文件: <input type="file" accept="video/*" />
// 拖放: onDragOver + onDrop, 从 e.dataTransfer.items 递归读取

// 过滤视频文件
const videoFiles = files.filter(f => isVideoFile(f.name))

// 解析每个文件
const parsed = videoFiles.map(file => ({
  file,
  fileName: file.name,
  relativePath: file.webkitRelativePath || file.name,
  episode: parseEpisodeNumber(file.name),
}))

// 从文件名/文件夹名提取番剧关键词
const folderName = parsed[0]?.relativePath?.split('/')[0]
const keyword = parseAnimeKeyword(folderName) || parseAnimeKeyword(parsed[0]?.fileName)
```

### 单文件 vs 文件夹

| | 单文件 | 文件夹 |
|---|---|---|
| 匹配方式 | 直接 dandanplay /match | 解析关键词 → AnimeCache → 降级 |
| 集数解析 | 不需要 (dandanplay 返回 episodeId) | 正则解析每个文件 |
| 播放体验 | 只能播一集 | 切集不用重选文件 |

---

## 数据流总览

```
用户拖入文件夹
  │
  ├─ 前端: 过滤视频 + 解析 webkitRelativePath
  │         → 提取关键词 + 每个文件的集数号
  │
  ├─ POST /api/dandanplay/match { keyword, episodes, fileName }
  │    │
  │    ├─ 后端阶段1: AnimeCache.find({ title LIKE keyword })
  │    │    → bgmId → GET dandanplay /bangumi/bgmtv/{bgmId}
  │    │    → 返回 { matched, anime, episodeMap }
  │    │
  │    ├─ 后端阶段2: dandanplay /match (fileNameOnly)
  │    │    → animeId → GET dandanplay /bangumi/{animeId}
  │    │    → 返回 { matched, anime, episodeMap }
  │    │
  │    └─ 返回 { matched:false, needHash:true }
  │
  ├─ 前端 (needHash): SparkMD5(首文件前16MB)
  │    → POST /api/dandanplay/match { fileHash, fileName, fileSize }
  │    │
  │    ├─ 后端阶段3: dandanplay /match (hashAndFileName)
  │    │    → 返回 { matched, anime, episodeMap }
  │    │
  │    └─ 返回 { matched:false } → 前端进入 MANUAL
  │
  ├─ MANUAL: 用户搜索选择
  │    → GET /api/dandanplay/search?keyword=xxx
  │    → 用户选择 → 后端获取 episodeMap
  │
  ├─ READY: 显示匹配结果, 文件→集数映射
  │
  └─ 用户点击播放 EP03:
       ├─ GET /api/dandanplay/comments/{dandanEpisodeId}
       │    → 后端代理 dandanplay API, 内存缓存 30min
       ├─ 前端: dandanToArtplayer() 转换
       └─ ArtPlayer.load(blobUrl, danmakuList)
```

---

## 依赖新增

### 后端

无新增 npm 依赖（用 Node 内置 fetch + 现有 rateLimitedFetch 模式）。

### 前端

```
artplayer              ^5.4.0    ← 视频播放器
artplayer-plugin-danmuku ^5.3.0  ← 弹幕插件
spark-md5              ^3.0.2    ← MD5 计算 (降级用, 前16MB)
```

---

## 环境变量

```
DANDANPLAY_APP_ID=xxx
DANDANPLAY_APP_SECRET=xxx
```

---

## 关键设计决策

| 决策 | 结论 | 原因 |
|------|------|------|
| 播放器库 | ArtPlayer + artplayer-plugin-danmuku | 内置弹幕插件，dandanplay 格式直接映射 |
| 播放器位置 | 独立 `/player` 页面，Navbar 新增入口 | 视频播放需要大空间 |
| 弹幕缓存 | 服务端内存 Map, 30min TTL | 瞬时缓存，不持久化 |
| episodeId 缓存 | 服务端内存 Map, 24h TTL | dandanplay 集数列表不常变 |
| MD5 计算 | 前端 SparkMD5，仅第三级降级时触发 | 避免不必要的 16MB 读取 |
| 弹幕转换 | 前端做 | 减少后端负担，dandanplay-vi 同样前端转换 |
| 文件持久化 | 不持久化，页面内 state | 一次一个文件夹，简单直接 |
| episodeId 获取 | 匹配成功时一次性获取全部 | 避免播放时再等 |
| 弹幕获取 | 点击播放某集时拉取 | 避免一次性 N 个 API |
| CORS | 服务端代理 | 后端直接调 dandanplay API |
| 多文件夹 | 一次只一个 | 先做最简版本 |

---

## 实施顺序

1. **后端 dandanplay.service.js** — API 调用、缓存、认证
2. **后端路由** — /match, /search, /comments 三个端点
3. **前端 episodeParser.js** — 文件名解析工具函数
4. **前端 PlayerPage + DropZone** — 文件上传 + IDLE/PARSING 状态
5. **前端 MatchProgress + useDandanMatch** — 三级匹配流程
6. **前端 ManualSearch** — 手动搜索降级
7. **前端 EpisodeFileList** — READY 状态集数列表
8. **前端 VideoPlayer** — ArtPlayer 封装 + 弹幕加载
9. **前端 EpisodeNav** — 集数切换
10. **Navbar + 路由** — 导航入口

---

## 播放器选型分析

| 播放器 | 体积 (gzip) | 弹幕方案 | 最近维护 | 备注 |
|--------|-------------|----------|----------|------|
| **ArtPlayer** | ~38 KB | artplayer-plugin-danmuku (官方) | 活跃 | dandanplay 格式直接映射，API 最简洁 |
| DPlayer | ~25 KB | 内置弹幕 | 停滞 (~2022) | 弹幕格式需适配，社区已迁移 |
| xgplayer (西瓜) | ~120 KB | xgplayer-danmu 插件 | 活跃 | 体积大，面向商业级场景 |
| NPlayer | ~18 KB | 需自行集成 | 低活跃 | dandanplay-vi 早期用过，后切 ArtPlayer |

**选择 ArtPlayer 原因：**
1. artplayer-plugin-danmuku 原生支持 `{ text, time, mode, color }` 格式，dandanplay 的 `p` 字段 `split(',')` 后直接映射
2. 内置弹幕控制 UI（开关、透明度、速度、字体大小），不需要额外开发
3. 活跃维护 + TypeScript 类型完整
4. dandanplay-vi 项目验证过 ArtPlayer 方案可行

---

## 服务端负载分析

### 单次弹幕请求数据量

以「进击的巨人 EP01」实测数据为参考：

| 指标 | 数值 |
|------|------|
| withRelated=true 弹幕数 | ~2,344 条 |
| JSON 大小 (未压缩) | ~153 KB |
| gzip 后 | ~40 KB |
| 解析处理时间 | < 5ms |

热门番最高可达 ~8,000 条/集，冷门番通常 < 500 条/集。

### 内存缓存开销

```
commentCache (30min TTL):
  单集: ~150 KB × 30 集(热门) = ~4.5 MB
  一般场景: 同时活跃 ~20 集 = ~3 MB

episodeCache (24h TTL):
  单番剧: ~2 KB × 200 番 = ~400 KB

总计: 峰值 < 10 MB，对 VPS 内存无显著影响
```

### dandanplay API 调用模式

```
弹幕请求: GET /comment/{episodeId}
  → 302 重定向到 CDN (cas2.dandanplay.net)
  → CDN 响应: cache-control: private, max-age=7200 (2h)
  → 首次: 命中 dandanplay 服务器
  → 2h 内: CDN 直接返回（不消耗 dandanplay 配额）
```

**关键：** dandanplay 自身 CDN 已做了 2 小时缓存，我们的 30 分钟服务端缓存在 CDN 缓存之上再叠一层，进一步减少请求数。

### 限流独立性

```
⚠ 重要: dandanplay 限流器必须和 Bangumi 限流器分开

Bangumi rateLimitedFetch (800ms interval):
  → 用于 enrichment pipeline (Phase 1/4/V3)
  → 队列可能很长（批量爬取时数百请求）

dandanplay rateLimitedFetch (800ms interval):
  → 仅用于 /match, /search, /bangumi, /comment
  → 用户触发，请求量小
  → 共享会导致：用户等弹幕要排在 Bangumi 爬取队列后面
```

---

## 并发容量分析

### 用户行为模型

```
用户A 的典型 session:
  1. POST /match → 1-3 次 dandanplay API (匹配)
  2. 看 3 集番剧 → 3 次 GET /comments (可能命中缓存)
  → 一个 session 最多 ~6 次 dandanplay API
  → session 时长: ~1 小时

典型并发: 不是所有人同时触发 API
  → 20 人同时在线，但 API 请求分散在 1 小时内
  → 实际峰值: ~2-3 req/min 到 dandanplay
```

### 容量表

| 同时在线 | 瓶颈 | 方案 | 用户体验 |
|----------|------|------|----------|
| **1-20 人** | 无瓶颈 | 方案 B（服务端缓存） | 首次 ~1s，缓存命中 ~50ms |
| **20-50 人** | 限流器排队偶发 | 方案 B + 调整 interval 到 400ms | 首次偶尔 ~2s，缓存命中 ~50ms |
| **50+ 人** | 限流器排队明显 | 方案 A（Cloudflare Worker）| 稳定 ~200ms |

### 瓶颈分析

- **内存缓存命中**: 无限制（Map 读取 < 1ms）
- **dandanplay CDN 命中** (2h 内重复): 无限制（302 → CDN 直接返回）
- **真正瓶颈**: 冷启动请求通过限流器排队（800ms/请求串行）
  - 20 人同时请求不同集数 → 20 × 800ms = 16s 排队
  - 实际分散后: 峰值 3-5 个同时 → 2.4-4s

---

## 扩展策略

### 方案 A: Cloudflare Worker 直连

```
浏览器 → Cloudflare Worker (CORS 代理) → dandanplay API
         (Worker 自带 X-AppId / X-AppSecret)
```

- **优点**: 绕过服务端限流器，无排队，Edge 部署延迟低
- **缺点**: 需要额外的 Cloudflare Worker 部署，AppSecret 存 Worker 环境变量
- **容量**: 理论无上限（受 Worker 限额：免费 100k req/day，$5/月 = 10M req/month）
- **参考**: dandanplay-vi 就是这个方案（`dandan-proxy.wiidede.space`）

### 方案 B: 服务端代理 + 积极缓存

```
浏览器 → AnimeGo Server (代理 + 内存缓存) → dandanplay API
```

- **优点**: 无额外部署，认证信息在服务端安全
- **缺点**: 受限流器串行瓶颈，高并发时排队
- **容量**: 20 人轻松，50 人可调优

### 方案 C: 混合方案 (推荐)

```
初期:  方案 B（服务端代理）
       → 零部署成本，20 人以下完全够用

扩展:  切换到方案 A（Cloudflare Worker）
       → 部署一个 Worker，改一个环境变量即可
```

**前端实现:**

```js
// api/dandanplay.api.js
const DANDANPLAY_PROXY = import.meta.env.VITE_DANDANPLAY_PROXY_URL

// 初期: VITE_DANDANPLAY_PROXY_URL 不设置，走服务端 /api/dandanplay/*
// 扩展: VITE_DANDANPLAY_PROXY_URL=https://dandan-proxy.your-domain.workers.dev

export function getComments(episodeId) {
  const base = DANDANPLAY_PROXY || '/api/dandanplay'
  return axios.get(`${base}/comments/${episodeId}`)
}
```

**切换步骤:**
1. 部署 Cloudflare Worker（~50 行代码，转发 + 加认证头）
2. 设置 Worker 环境变量: `DANDANPLAY_APP_ID`, `DANDANPLAY_APP_SECRET`
3. 前端 `.env` 添加: `VITE_DANDANPLAY_PROXY_URL=https://your-worker.workers.dev`
4. 重新构建前端，完成

> **决策：初期用服务端方案 B，如果并发真的上来了，加一个 Cloudflare Worker 改个环境变量就行。** 不需要提前过度工程化。

---

## 工程审查补充 (2026-04-14)

以下问题来自 /plan-eng-review + Codex 独立审查，实现前必须处理。

### 1. 错误状态设计

状态机补充 ERROR 状态：

```
  IDLE → PARSING → MATCHING → READY → PLAYING
                      │                    │
                      ↓                    ↓
                   MANUAL ──→ READY     ERROR
                      │
                      ↓
                   ERROR
```

| 阶段 | 失败场景 | 用户看到 |
|------|---------|---------|
| MATCHING | dandanplay API 超时/挂了 | "弹幕服务暂时不可用，请稍后重试" + 重试按钮 |
| MATCHING | AnimeCache 搜索 0 结果 + dandanplay 0 结果 | 进入 MANUAL，不是 ERROR |
| PLAYING | 弹幕加载失败 | 视频正常播放，toast 提示"弹幕加载失败"，弹幕区为空 |
| PLAYING | 视频格式不支持 | ArtPlayer error 事件 → 显示格式提示 |
| PARSING | 文件夹 0 个视频文件 | "未找到视频文件，请检查文件夹" |

**关键原则：弹幕加载失败不阻塞视频播放。**

### 2. SparkMD5 用 Web Worker

第三级降级的 MD5 计算放到 Web Worker，避免 16MB 文件读取卡住 UI：

```
client/src/workers/md5.worker.js

// Worker 内:
import SparkMD5 from 'spark-md5'
self.onmessage = (e) => {
  const { file } = e.data
  const reader = new FileReaderSync()
  const chunk = reader.readAsArrayBuffer(file.slice(0, 16 * 1024 * 1024))
  const hash = SparkMD5.ArrayBuffer.hash(chunk)
  self.postMessage({ hash })
}
```

新增文件: `client/src/workers/md5.worker.js`

### 3. blob URL 生命周期管理

在 `useVideoFiles` hook 中管理 blob URL，切集时释放上一集：

```js
// useVideoFiles.js
const blobUrlRef = useRef(null)

function getVideoUrl(file) {
  if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
  blobUrlRef.current = URL.createObjectURL(file)
  return blobUrlRef.current
}

// cleanup on unmount
useEffect(() => () => {
  if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
}, [])
```

### 4. rateLimitedFetch 通用工具

抽出通用工厂函数，Bangumi 和 dandanplay 各自独立实例：

```
server/utils/rateLimitedFetch.js

function createRateLimitedFetch(interval = 800, headers = {}) {
  let lastCallAt = 0
  return async function rateLimitedFetch(url, options = {}) {
    const wait = interval - (Date.now() - lastCallAt)
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    lastCallAt = Date.now()
    return fetch(url, {
      ...options,
      headers: { ...headers, ...options.headers },
      signal: options.signal || AbortSignal.timeout(8000),
    })
  }
}
```

新增文件: `server/utils/rateLimitedFetch.js`
修改: `server/services/bangumi.service.js` — 改用 createRateLimitedFetch

### 5. API 端点需要认证

所有 `/api/dandanplay/*` 端点复用现有 auth middleware，只有登录用户可用：

```js
// dandanplay.routes.js
const { authenticateToken } = require('../middleware/auth')

router.post('/match', authenticateToken, ctrl.match)
router.get('/search', authenticateToken, ctrl.search)
router.get('/comments/:episodeId', authenticateToken, ctrl.getComments)
```

### 6. 输入消毒

keyword 进 MongoDB regex 前必须转义特殊字符：

```js
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// searchAnimeCache 中:
const escaped = escapeRegex(keyword.slice(0, 100)) // 限长 + 转义
```

### 7. episodeParser 修正

兜底正则增加分辨率数字排除：

```js
const RESOLUTIONS = new Set([360, 480, 720, 1080, 1440, 2160, 4320])

// 在兜底匹配中:
/(?:^|\D)(\d{2,3})(?:\D|$)/  →  匹配后检查 if (RESOLUTIONS.has(num)) continue
```

### 8. AnimeCache 文本索引

给标题字段加 MongoDB text index 以支持关键词搜索：

```js
// AnimeCache.js 补充:
animeCacheSchema.index({
  titleChinese: 'text',
  titleNative: 'text',
  titleRomaji: 'text',
  titleEnglish: 'text'
})
```

### 9. 格式支持说明 & 平台检测

**支持格式：**
- mp4 (H.264/AAC) — 所有浏览器 ✓
- webm (VP8/VP9) — 所有浏览器 ✓
- mkv (H.264) — Chrome/Edge ✓, Firefox/Safari 部分支持
- HEVC/H.265 — Chrome 107+, Safari ✓, Firefox ✗
- ASS/SSA 字幕 — 不支持（与 dandanplay-vi 相同策略）

**平台检测：** 移动端（≤600px）隐藏 Navbar 的 Player 链接。如果用户直接访问 /player URL，显示全页提示"此功能需要在电脑上使用" + "返回首页"按钮。

> 参考：dandanplay-vi 采用相同策略 — 依赖浏览器原生播放能力，建议使用最新版 Chrome。

### 响应式布局

| 断点 | 布局变化 |
|------|---------|
| ≥1400px (桌面大屏) | 标准布局，DropZone max-width 600px 居中 |
| 900-1399px (桌面/平板横屏) | 同上，视频播放器仍为 16:9 宽屏 |
| 600-899px (平板竖屏) | DropZone max-width 100%。READY 状态番剧信息区改为上下布局（封面在上）。集数导航改为 2 行 wrap |
| ≤600px | **隐藏 Player 入口。** 如果直接访问，显示"请在电脑上使用" |

**播放器在平板上的特殊处理：**
- 视频宽度仍 100%，16:9 比例保持
- 集数导航改为水平滚动 + 左右箭头
- 文件夹拖放在触屏上不可用，只显示"点击选择文件夹"按钮

### 无障碍 (Accessibility)

- DropZone: `role="button"`, `tabIndex={0}`, Enter/Space 触发文件选择，`aria-label="选择视频文件夹"`
- 匹配进度: 使用 `aria-live="polite"` 实时播报步骤状态变化
- 集数列表: 每行 `role="button"`，键盘 Enter 播放，Tab 导航
- 视频播放器: ArtPlayer 内置键盘控制（Space 暂停，←→ 快进快退，F 全屏）
- 弹幕开关: 按钮需要 `aria-label="开启/关闭弹幕"`
- 色彩对比度: 所有文字对比 `--bg` (#000) 背景 ≥ 4.5:1（`--text-tertiary` rgba(235,235,245,0.30) 对 #000 = 4.9:1 ✓）

### 10. 测试计划

实现时同步编写以下测试：

**单元测试 (~20 个)：**
- `episodeParser.js`: S01E03, EP03, 第3集, " - 03 ", [03], 分辨率过滤, NCOP.mkv, 关键词提取 (~8)
- `dandanToArtplayer()`: mode 映射 (1→0, 4→2, 5→1), 未知 mode, RGB→hex 转换 (~5)
- `dandanplay.service.js`: 缓存命中/未命中, 搜索, 匹配, API 超时处理 (~7)

**集成测试：**
- POST /api/dandanplay/match 认证检查
- GET /api/dandanplay/comments 缓存行为

### 更新的实施顺序

```
1.  server/utils/rateLimitedFetch.js (通用工具)
    └→ 重构 bangumi.service.js 使用新工具
2.  server/services/dandanplay.service.js (API 调用 + 缓存 + 输入消毒)
3.  server/controllers + routes (含 authenticateToken)
4.  AnimeCache text index migration
5.  client/src/utils/episodeParser.js + 单元测试
6.  client/src/workers/md5.worker.js
7.  client/src/pages/PlayerPage.jsx + DropZone (含平台检测 + 格式提示)
8.  MatchProgress + useDandanMatch (含 ERROR 状态)
9.  ManualSearch
10. EpisodeFileList
11. VideoPlayer (含 blob URL 管理 + 弹幕加载失败降级)
12. EpisodeNav
13. Navbar + 路由 (移动端隐藏)
```

---

## 设计审查补充 (2026-04-14)

以下来自 /plan-design-review，7 轮审查完成。

### 审查总分

| 维度 | 审查前 | 审查后 | 状态 |
|------|--------|--------|------|
| 信息架构 | 7 | 9 | ✅ |
| 交互状态覆盖 | 4 | 9 | ✅ |
| 用户旅程 | 5 | 8 | ✅ |
| AI Slop 风险 | 8 | 9 | ✅ |
| 设计系统一致性 | 5 | 9 | ✅ |
| 响应式 & 无障碍 | 3 | 8 | ✅ |
| 未决定项 | 7 | 9 | ✅ |
| **总分** | **~6/10** | **~9/10** | ✅ |

### 未决定项（实现时确认）

1. **弹幕密度控制** — 热门番 8000+ 条弹幕在 24 分钟内全部显示会很密集。是否需要前端做弹幕密度限制（如同屏最多 N 条）？ArtPlayer danmuku 的 `antiOverlap: true` 可能不够。**建议：先上线观察，如果用户反馈弹幕太密再加 limit 参数。**

2. **弹幕颜色在暗色背景上的可见度** — dandanplay 弹幕颜色由用户设定，可能出现深色弹幕在 #000 背景上不可见。是否需要前端做亮度保底（如 color brightness < 50 时强制 #ffffff）？**建议：不处理，与 B站/dandanplay 客户端行为一致。**

3. **视频 autoplay 策略** — 点击 ▶ 后是自动播放还是显示大播放按钮？浏览器对 autoplay 有限制（需要 muted 或用户交互）。由于用户点击了 ▶ 按钮，已满足用户交互要求，可以直接 autoplay。**决定：点击 ▶ 后直接播放。**

4. **ArtPlayer 主题色** — ArtPlayer 默认蓝色主题是否与 `--accent` (#0a84ff) 一致？需要确认 ArtPlayer 的 `theme` 配置项。**建议：设置 `theme: '#0a84ff'` 对齐设计系统。**

---

## 播放板块代码审查（2026-04-17）

v1.0.0 上线后对 `client/src/pages/PlayerPage.jsx`、`client/src/components/player/*`、`client/src/hooks/useDandan*.js`、`useVideoFiles.js` 做的代码审查。按严重程度分档。

### 🔴 Bug（影响功能）

#### P1-BUG-1：Hook 顺序违反 — 窗口缩放到 ≤600px 会白屏崩溃

**位置：** `PlayerPage.jsx:75-99`

**现象：** 组件顶部先调用 `useVideoFiles`、`useDandanMatch`、`useDandanComments` 和 6 个 `useState`，**然后**检查 `isMobile()` 并 early return；但 `useMemo`（`episodes`）和所有 `useCallback` 都在 early return **之后**。

```jsx
// 当前实现
export default function PlayerPage() {
  const { videoFiles, ... } = useVideoFiles();          // hook #1
  const { phase, ... } = useDandanMatch();              // hook #2
  const { danmakuList, ... } = useDandanComments();     // hook #3
  const [playingFile, setPlayingFile] = useState(null); // hook #4
  // ... 5 more useState

  if (isMobile()) return (...);  // ❌ 早返回

  const episodes = useMemo(...);                        // hook #N（不一定被调用）
  const handleFiles = useCallback(...);                 // hook #N+1
  // ...
}
```

**影响：** 用户在桌面浏览器上打开播放页（所有 hook 都跑），之后缩窗到 ≤600px，下一次 re-render 进入 mobile 分支，early return 前的 hook 数量 = 9，但 early return 后的 hook 不再调用。React 抛 "Rendered fewer hooks than expected" 整个 React 树崩溃。

**修复：** 把 `isMobile()` 检查改用 state 驱动，并把所有 hook 放到 early return 之前。

```jsx
const [isMobileView, setIsMobileView] = useState(() => window.innerWidth <= 600);
useEffect(() => {
  const onResize = () => setIsMobileView(window.innerWidth <= 600);
  window.addEventListener('resize', onResize);
  return () => window.removeEventListener('resize', onResize);
}, []);
// ... 所有其他 hook

if (isMobileView) return (<div style={s.mobile}>...</div>);
// ...
```

---

#### P1-BUG-2：MKV 内嵌字幕 Blob URL 内存泄漏

**位置：** `PlayerPage.jsx:188, 193`

**现象：** MKV Worker 返回字幕内容后，调用 `URL.createObjectURL(new Blob(...))` 创建 blob URL 并 `setSubtitleUrl(url)`。**从不 revoke。** 每次切集（若是 MKV）都会泄漏一个。连续切 20+ 集累积数十 MB；长番一次从头看到尾泄漏上百 MB。

**修复：** 用 ref 跟踪当前 MKV blob URL，切换和卸载时 revoke。

```jsx
const mkvBlobUrlRef = useRef(null);

// 在 handlePlay 的 MKV worker onmessage 里：
const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
if (mkvBlobUrlRef.current) URL.revokeObjectURL(mkvBlobUrlRef.current);
mkvBlobUrlRef.current = url;
setSubtitleUrl(url);

// 在 handleBackToList / 组件 unmount 时 revoke
```

---

#### P1-BUG-3：死代码 `useDandanMatch.goManual`

**位置：** `useDandanMatch.js:148-151`

**现象：** `goManual` 从 hook 导出，但 `PlayerPage.jsx` 从未调用（自 commit `3f2c854` DanmakuPicker 上线后，"手动重新搜索"的需求已完全被 DanmakuPicker 覆盖）。

**修复：** 删除 `goManual` 定义和导出，减少 API 表面积。

---

### 🟡 UX 缺失（用户能感觉到）

#### P2-UX-1：视频播完不自动下一集

**位置：** `PlayerPage.jsx:342-348`（VideoPlayer 调用）

**现象：** `VideoPlayer` 已有 `onEnded` prop（见 `VideoPlayer.jsx:43`），但 PlayerPage 没传。追番场景下每集结束用户需要手动点下一集，体验割裂。

**修复：**

```jsx
<VideoPlayer
  videoUrl={videoUrl}
  // ...
  onEnded={() => {
    const idx = episodes.indexOf(playingEp);
    if (idx >= 0 && idx < episodes.length - 1) {
      handleEpisodeSwitch(episodes[idx + 1]);
    }
  }}
/>
```

**注意：** 需要防越界 — 最后一集结束不做任何事（或显示"全部播放完毕"toast）。

---

#### P2-UX-2：没有键盘换集

**位置：** `PlayerPage.jsx` `playing` 分支

**现象：** 无 `←`/`→` 切上下一集、无 `Space` 播放暂停（Artplayer 自带空格键，但换集全靠鼠标）。PC 播放体验远低于桌面原生播放器。

**修复：** 在 `uiPhase === 'playing'` 时绑 keydown：

```jsx
useEffect(() => {
  if (uiPhase !== 'playing') return;
  const onKey = (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const idx = episodes.indexOf(playingEp);
    if (e.key === 'ArrowLeft' && idx > 0) handleEpisodeSwitch(episodes[idx - 1]);
    if (e.key === 'ArrowRight' && idx < episodes.length - 1) handleEpisodeSwitch(episodes[idx + 1]);
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, [uiPhase, episodes, playingEp, handleEpisodeSwitch]);
```

---

#### P2-UX-3：弹幕加载中无 loading 提示

**位置：** `PlayerPage.jsx:317-326`（顶栏弹幕 badge）、`useDandanComments.js:13`

**现象：** 点播放后视频立刻播，弹幕从 dandanplay API 拉取需要 1-3s，这段时间顶栏只显示"N 条弹幕"或空白，用户以为没弹幕或以为坏了。`useDandanComments.loading` 状态已存在但 UI 未消费。

**修复：** 顶栏 badge 根据 loading 态显示：

```jsx
{loading ? (
  <span style={loadingBadge}>加载弹幕…</span>
) : danmakuCount > 0 ? (
  <span style={countBadge}>{danmakuCount} {t('player.danmakuCount')}</span>
) : null}
```

需要从 `useDandanComments` 暴露 `loading` 到 PlayerPage（已经暴露，只需在 destructure 时加上）。

---

#### P2-UX-4：弹幕加载失败静默

**位置：** `useDandanComments.js:21-26`

**现象：** `loadComments` catch 后 `setDanmakuList([])` + `setCount(0)`，和"该集确实没弹幕"UI 完全相同。用户无法分辨网络错误还是真无弹幕，也没法重试。

**修复：**
- `useDandanComments` 暴露 `error` 状态（已有但未用）
- 顶栏区分渲染：`noDanmaku` vs `loadFailed - 重试`
- 添加 `retry` callback（重新调用 `loadComments(episodeId)`）

---

#### P2-UX-5：播放进度不记忆

**现象：** 每次切集都从 0s 开始。长番追番体验差，尤其是中途被打断后回来。

**修复：** localStorage 按 `fileName+fileSize` 为 key 存 `currentTime`；`VideoPlayer` 添加 `art.on('video:timeupdate', throttled(save))`、`art.on('video:canplay', restore)`。

```js
// 伪代码
const key = `progress:${fileName}:${fileSize}`;
art.on('video:canplay', () => {
  const saved = parseFloat(localStorage.getItem(key));
  if (saved > 5 && saved < art.duration - 10) art.currentTime = saved;
});
art.on('video:timeupdate', throttle(() => {
  localStorage.setItem(key, String(art.currentTime));
}, 5000));
```

**边界：**
- 跳过最后 10s（避免下次从片尾开始）
- 只在播放 ≥ 5s 后才保存（避免刚点进来就覆盖）
- 切集时先 save 当前进度再跳转

---

#### P2-UX-6：番剧封面 404 无 fallback

**位置：** `EpisodeFileList.jsx:131`、`DanmakuPicker.jsx` 搜索结果

**现象：** `<img src={anime.coverImageUrl} />` 无 `onError`。URL 失效时显示浏览器默认的破图标。

**修复：** 统一 img 组件加 `onError` fallback 或 hide：

```jsx
<img
  style={s.cover}
  src={anime.coverImageUrl}
  alt=""
  onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
/>
```

---

### 🟢 架构清理（维护性）

#### P3-CLEAN-1：两个 `<DanmakuPicker>` 实例并存

**位置：** `EpisodeFileList.jsx:224` 和 `PlayerPage.jsx:358`

**现象：** 列表视图和播放视图各渲染一个 DanmakuPicker，状态（搜索框文本、Tab 选择、滚动位置）不共享。用户在列表视图打开 picker 输入一半、关掉开始播放、再打开需要重输。

**修复：** 把 DanmakuPicker 统一提到 PlayerPage 层，state 用 `{ open: bool, episodeNum: number | null }` 表示。EpisodeFileList 只接收 `onSetDanmaku(epNum)` 回调，不自己渲染 picker。

```jsx
// PlayerPage.jsx
const [picker, setPicker] = useState({ open: false, epNum: null });

// 列表视图
<EpisodeFileList onSetDanmaku={(epNum) => setPicker({ open: true, epNum })} />

// 播放视图顶栏按钮
<button onClick={() => setPicker({ open: true, epNum: playingEp })}>💬 设置弹幕</button>

// 唯一 picker
<DanmakuPicker
  isOpen={picker.open}
  episodeNumber={picker.epNum}
  onClose={() => setPicker({ open: false, epNum: null })}
  onConfirm={(data, newAnime) => {
    handleUpdateDanmaku(picker.epNum, data, newAnime);
    setPicker({ open: false, epNum: null });
  }}
  // ...
/>
```

**收益：** 状态统一、bundle 稍减、未来加"记住上次搜索"容易。

---

#### P3-CLEAN-2：MD5 并发爆炸 — 大合集会卡

**位置：** `PlayerPage.jsx:135-143` — `Promise.all(files.map(hashFile))` 并发全开

**现象：** 每个 Worker 读取文件前 16MB。12 集合集并发 = 192MB 内存峰值；100 集合集（大合集）= 1.6GB 瞬间占用，浏览器页面会冻结甚至 OOM。

**修复：** 用 `p-limit` 或手写队列限制并发：

```js
// 用 p-limit
import pLimit from 'p-limit';
const limit = pLimit(3);
const results = await Promise.all(
  files.map(f => limit(() => hashFile(f.file).then(hash => ({ ...f, fileHash: hash }))))
);
```

并发 3 即可：SSD 能跑满，内存峰值控制在 48MB。

---

#### P3-CLEAN-3：10s 超时后 MD5 worker 不 terminate

**位置：** `useDandanMatch.js:24-30`

**现象：** `Promise.race` 超时只是 resolve(null)，被丢弃的 worker 还在跑。CPU 和内存继续占用到任务自然结束。

**修复：** 把 worker termination 纳入 timeout 逻辑：

```js
const hashFile = (file) => {
  const worker = new Worker(...);
  const promise = new Promise((resolve) => {
    worker.onmessage = (e) => resolve(e.data.hash);
    worker.onerror = () => resolve(null);
    worker.postMessage({ file });
  });
  return { promise, cancel: () => worker.terminate() };
};

// 调用侧
const { promise, cancel } = hashFile(file);
const result = await Promise.race([
  promise,
  new Promise(r => setTimeout(() => { cancel(); r(null); }, 10000)),
]);
```

---

#### P3-CLEAN-4：匹配期间不能取消

**现象：** 卡在 `matching` 阶段（如 dandanplay API 慢响应）只能点 "清除" 重头来，没有"取消本次匹配"语义。

**修复：** `MatchProgress` 的 clear 按钮文案改为"取消"（matching 阶段），并让 `useDandanMatch` 支持中断 in-flight fetch（`AbortController`）。

---

### 建议修复顺序

| 优先级 | 任务 | 预估 |
|--------|------|------|
| P0 | P1-BUG-1 Hook 顺序 + P1-BUG-2 Blob 泄漏 + P1-BUG-3 删 goManual | 30 分钟 |
| P1 | P2-UX-1 自动下一集 + P2-UX-2 键盘换集 | 30 分钟 |
| P1 | P2-UX-5 播放进度记忆 | 30 分钟 |
| P2 | P2-UX-3 弹幕 loading + P2-UX-4 失败重试 | 20 分钟 |
| P2 | P2-UX-6 封面 404 fallback | 10 分钟 |
| P3 | P3-CLEAN-2 MD5 并发限制（大合集场景） | 15 分钟 |
| P3 | P3-CLEAN-1 统一 DanmakuPicker | 30 分钟 |
| P3 | P3-CLEAN-3 Worker termination + P3-CLEAN-4 匹配可取消 | 30 分钟 |

**P0+P1 合计 ~1.5 小时，直接提升稳定性和追番体验。**

---

_设计时间：2026-04-14_
_工程审查：2026-04-14_
_设计审查：2026-04-14_
_播放板块审查：2026-04-17_

---

## 弹幕密度节流（2026-04-19）

### 现象

正常播放时弹幕密集涌入偶发"黑一帧"闪屏。4717 条 / 24min 均值 3.3/s，峰值 10~20/s，同屏峰值可到 50~80 条。

### 根因（非电脑性能问题）

artplayer-plugin-danmuku v5.3.0 纯 DOM 模式：
- 每条弹幕 = 一个 `<div>`，同屏数量堆积 → 样式重算 + 合成层抖动
- `antiOverlap: true` 在 `getDanmuTop()` 做 O(轨道数) 防撞扫描；同屏 N 越大，每次入场计算越重
- 后端 404（`/api/subscriptions/:id`）已由 `useSubscription` 吞掉，和闪屏无关

### B 站参考策略（DanmakuFlameMaster）

| 策略 | 作用 |
|------|------|
| `maxLines` 硬上限同屏行数 | **先 bound N**，让 antiOverlap 的扫描变常数时间 |
| `preventOverlapping` 保持开 | 视觉质量不让步 |
| `CacheStuffer` 字体渲染缓存 | 复用 bitmap，不重绘 |
| 单条弹幕共享 duration | 减少 timeupdate 触发计算 |
| Web 播放器双模 | DOM/CSS3（80~90% CPU）vs Canvas（50~60% CPU） |

**启示：** 瓶颈是"同屏数量"，不是"总数"。antiOverlap 不是敌人，**未加 maxLines 的 antiOverlap** 才是。

### 方案：源头密度节流

artplayer-plugin-danmuku 没暴露 `maxLines`。只能在 hook 层预处理近似：

```
useDandanComments.loadComments
  ├─ getComments(episodeId)
  ├─ map(dandanToArtplayer)            ← 现在
  └─ throttleByDensity(converted, opts) ← 新增
```

#### 工具函数 `client/src/utils/danmakuThrottle.js`

```js
// 时间窗口密度节流：按 time 排序后滑窗计数，超阈值丢弃。
// 为什么存在：artplayer-plugin-danmuku 无 maxLines 选项，
// 预处理近似同屏上限，避免 DOM 峰值抖动。
export function throttleByDensity(comments, { maxPerWindow = 8, windowMs = 2000 } = {}) {
  if (!comments?.length || maxPerWindow <= 0) return [];
  const sorted = [...comments].sort((a, b) => a.time - b.time);
  const kept = [];
  let windowStart = -Infinity;
  let windowCount = 0;
  for (const c of sorted) {
    const tMs = c.time * 1000;
    if (tMs - windowStart >= windowMs) {
      windowStart = tMs;
      windowCount = 0;
    }
    if (windowCount < maxPerWindow) {
      kept.push(c);
      windowCount++;
    }
  }
  return kept;
}
```

#### Hook 改动 `client/src/hooks/useDandanComments.js:21`

```diff
- const converted = (data.comments || []).map(dandanToArtplayer);
- setDanmakuList(converted);
- setCount(data.count || 0);
+ const converted = (data.comments || []).map(dandanToArtplayer);
+ const throttled = throttleByDensity(converted, { maxPerWindow: 8, windowMs: 2000 });
+ setDanmakuList(throttled);
+ setCount(data.count || 0); // 仍显示原始数量，UI 加"已限流"副标签
```

### 参数推导

- 均值 3.3/s → 阈值给 6/s（≈ 2× 余量） → `maxPerWindow=8, windowMs=2000`
- 飞行时间 `speed:5` ≈ 5s 穿屏 → 同屏峰值 ≈ 4/s × 5s = **20 条**（DOM 模式舒适区）
- 非硬限，上层可调

### 测试覆盖（`danmakuThrottle.test.js` 最少 7 例）

| # | 场景 | 期望 |
|---|------|------|
| 1 | 空输入 | `[]` |
| 2 | 稀疏（远低阈值） | 原样 |
| 3 | 单秒 20 条爆发 | ≤ maxPerWindow |
| 4 | 窗口边界两侧各 N 条 | 独立计数 |
| 5 | 同时间戳集群 | 按输入顺序留前 K |
| 6 | 乱序输入 | 结果时间升序 |
| 7 | `maxPerWindow=0` | `[]`（防御） |

**回归**：`client/src/__tests__/useDandanComments.test.jsx:15` 的 mock 只 2 条不会触发节流，现有断言保持通过。新增"超阈值过滤"用例。

### 保留的插件配置

```js
// client/src/components/player/VideoPlayer.jsx:146
artplayerPluginDanmuku({
  danmuku: danmakuList || [],
  speed: 5,
  opacity: 0.8,
  fontSize: 24,
  antiOverlap: true,          // 保留：质量不让步
  synchronousPlayback: true,  // 保留：倍速时弹幕跟随
  emitter: false,
})
```

**不动插件**。节流彻底在数据源。

### 未做的（权衡记录）

- **Canvas 模式：** 插件 v5 不支持切换，需替换成 `artplayer-plugin-danmuku-canvas` 级项目，改造面太大
- **runtime `filter` 回调：** 每条弹幕 emit 时跑一次 JS，且跨调用维护窗口状态复杂。选一次性预处理
- **丢弃的 `laneCount` 参数：** 轨道是插件内部 DOM 分配，不暴露，节流层无法控制，移除

### 风险

- 插件若未来升级引入 `maxLines`，需把此层节流降为兜底或移除 → 在 `danmakuThrottle.js` 头注释标记"为什么存在"
- `synchronousPlayback:true` 在倍速下会缩短穿屏时间（2× → 2.5s），需要按 1x 基准调档位

### 工作量

| 项 | 预估 |
|----|------|
| `danmakuThrottle.js` + 7 单测 | 30 分钟 |
| `useDandanComments.js` 接入 + 回归测试 | 10 分钟 |
| UI "已限流" 标签（可选） | 10 分钟 |

**合计 ~50 分钟。**

_弹幕节流设计：2026-04-19_
