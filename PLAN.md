# AnimeGo 新功能计划：i18n + 集数列表 + 磁链搜索 + 集数评论

## Context
在已完成的全栈 AnimeGo 基础上，添加四个新功能：
1. **中英文切换**：全站 UI 文字支持中/英双语，Navbar 一键切换，持久化到 localStorage
2. **集数列表**：番剧详情页显示所有集数（含进度标记、磁链入口、评论入口）
3. **磁力链接搜索**：每集可搜索 Nyaa.si 种子，站内弹窗展示结果（内嵌方案 A）
4. **每集评论**：每集手风琴展开评论区，登录用户可发布/删除评论，访客显示登录提示

---

## 功能一：中英文切换

### 方案
- **不引入第三方 i18n 库**，用自定义 Context 实现，与现有 `AuthContext` 模式一致
- 创建 `client/src/locales/zh.js` 和 `en.js` 两个翻译字典
- 创建 `client/src/context/LanguageContext.jsx`，暴露 `useLang()` hook 和 `t(key)` 函数
- `lang` 存 `localStorage`，默认中文
- Navbar 右侧添加切换按钮（`中 / EN`）

### 需翻译的 UI 文字范围
只翻译固定 UI 标签，**番剧标题/简介**仍用 AniList 原文（已有 `titleEnglish`/`titleRomaji`）

| 区域 | 中文 → 英文示例 |
|------|----------------|
| Navbar | 首页/Home、季度/Season、搜索/Search、登录/Login、注册/Register、登出/Logout、我的追番/My List |
| 首页 | 放送日历/Schedule、本周更新/This Week、继续追番/Continue Watching、我的在追/Watching |
| 番剧详情 | 连载中/Releasing、已完结/Finished、展开更多/Read more、收起/Collapse、集/Ep |
| 订阅按钮 | 在看/Watching、看完/Completed、想看/Plan to Watch、弃坑/Dropped |
| 搜索页 | 搜索番剧/Search Anime、输入关键词…/Enter keywords… |
| 季度页 | 冬季/Winter、春季/Spring、夏季/Summer、秋季/Fall |
| 登录/注册页 | 表单标签、按钮文字 |
| 集数/评论 | 集数列表/Episodes、暂无评论/No comments yet、发布评论/Post、请登录后参与评论/Login to comment |

### 涉及文件
- `client/src/locales/zh.js` （新增）
- `client/src/locales/en.js` （新增）
- `client/src/context/LanguageContext.jsx` （新增）
- `client/src/main.jsx` — 包裹 `<LanguageProvider>`
- `client/src/utils/constants.js` — `SEASON_LABELS` / `STATUS_OPTIONS` 改为静态键，`t()` 运行时获取文字
- 所有含硬编码中文的组件/页面：`Navbar`、`AnimeDetailHero`、`SubscriptionButton`、`WeeklySchedule`、`ContinueWatching`、`HeroCarousel`、`SearchPage`、`SeasonPage`、`LoginPage`、`RegisterPage`、`ProfilePage`、`AnimeDetailPage`

---

## 功能二：集数列表

### 方案
- 纯前端生成，不新增 API（`anime.episodes` 已有总集数）
- 新建 `client/src/components/anime/EpisodeList.jsx`
- 根据 `anime.episodes` 生成 `[1, 2, …, N]` 数组，展示为自适应卡片网格
- 每集卡片：集数编号 + 已看标记（来自 `useSubscription` 的 `currentEpisode`）+ 磁链按钮 + 点击展开评论
- 登录用户：已看集数绿色高亮；当前进度集数紫色高亮
- 未知总集数（`episodes` 为 0 或 null）：显示「集数信息待更新」提示

### 位置
```
AnimeDetailPage
 ├── AnimeDetailHero
 ├── SubscriptionButton
 └── EpisodeList  ← 新增
      ├── 每集卡片（集数 / 已看标记 / 磁链按钮）
      └── 手风琴展开 → EpisodeComments
```

### 涉及文件
- `client/src/components/anime/EpisodeList.jsx` （新增）
- `client/src/pages/AnimeDetailPage.jsx` — 引入 `EpisodeList`

---

## 功能三：磁力链接搜索（站内内嵌）

### 实现细节

**后端新接口** `GET /api/anime/torrents?q=TITLE&episode=N`
- 请求 Nyaa.si RSS：`https://nyaa.si/?page=rss&q=TITLE+EpN&c=1_2`（`c=1_2` = 动画英字幕）
- 使用 `fast-xml-parser` 解析 RSS XML（需安装）
- 提取每条 `item`：`title`、`link`、`nyaa:size`、`nyaa:seeders`、`nyaa:leechers`、`nyaa:infoHash`
- `magnet` 由 `infoHash` 拼接：`magnet:?xt=urn:btih:HASH&dn=TITLE`
- 返回 `[{ title, magnet, size, seeders, leechers }]`，最多 20 条
- 路由须在 `/:anilistId` **之前**注册，防止路由冲突

**前端磁链 Modal** `TorrentModal.jsx`
- 点击集数卡片「磁链」按钮 → 弹出全屏遮罩 Modal
- 顶部：可编辑搜索词（默认 `{titleEnglish || titleRomaji} {episode}`）+ 重新搜索按钮
- 结果列表：标题 / 文件大小 / 做种数 / [复制磁链] 按钮（复制后按钮变绿提示已复制）
- 无结果时显示空状态提示
- 按 Escape 或点击遮罩关闭

### 涉及文件（后端）
- `server/routes/anime.routes.js` — 新增 `GET /torrents` 路由
- `server/controllers/anime.controller.js` — 新增 `getTorrents` handler
- `server/package.json` — 安装 `fast-xml-parser`

### 涉及文件（前端）
- `client/src/components/anime/TorrentModal.jsx` （新增）
- `client/src/api/anime.api.js` — 新增 `getTorrents(q, episode)`
- `client/src/hooks/useAnime.js` — 新增 `useTorrents(q, episode, enabled)`
- `client/src/components/anime/EpisodeList.jsx` — 集成磁链按钮 → 触发 Modal

---

## 功能四：每集评论系统

### 交互设计
- 点击集数卡片 → 卡片下方手风琴展开评论区（同时只展开一集）
- **访客**：输入框替换为「请登录后参与评论」提示，含跳转登录链接
- **已登录**：输入框 + 发布按钮；评论按时间倒序；自己的评论右侧显示删除按钮
- 评论头像区域显示用户名首字母作为 Avatar

### 数据库新模型 `EpisodeComment`
```js
// server/models/EpisodeComment.js
{
  anilistId: Number (required),
  episode:   Number (required),
  userId:    ObjectId ref User (required),
  username:  String (冗余存储，避免联查),
  content:   String (required, maxLength: 500),
  timestamps: true
}
// 索引
{ anilistId: 1, episode: 1 }  // 按集查询
{ userId: 1 }                 // 删除时验证归属
```

### API 接口（新增 `/api/comments` 路由）
| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/comments/:anilistId/:episode` | 公开 | 获取评论列表（按时间倒序） |
| POST | `/api/comments/:anilistId/:episode` | 需登录 | 发布评论（content 必填，≤500字） |
| DELETE | `/api/comments/:id` | 需登录（仅本人）| 删除自己的评论 |

### 涉及文件（后端）
- `server/models/EpisodeComment.js` （新增）
- `server/controllers/comment.controller.js` （新增）
- `server/routes/comment.routes.js` （新增）
- `server/index.js` — 注册 `app.use('/api/comments', commentRoutes)`

### 涉及文件（前端）
- `client/src/api/comment.api.js` （新增）
- `client/src/hooks/useComment.js` （新增）
- `client/src/components/anime/EpisodeComments.jsx` （新增）
- `client/src/components/anime/EpisodeList.jsx` — 集成 `EpisodeComments` 手风琴

---

## 实现顺序

| 步骤 | 内容 |
|------|------|
| 1 | `LanguageContext` + `zh.js` / `en.js` 翻译字典 |
| 2 | `constants.js` 适配双语；`main.jsx` 包裹 `LanguageProvider` |
| 3 | 更新所有组件/页面使用 `t()` 替换硬编码中文 |
| 4 | `EpisodeList.jsx`（纯前端集数网格 + 进度高亮） |
| 5 | 后端安装 `fast-xml-parser`，新增 `GET /api/anime/torrents` |
| 6 | `TorrentModal.jsx` + `useTorrents` hook，集成到 `EpisodeList` |
| 7 | `EpisodeComment` model + controller + routes；`server/index.js` 注册路由 |
| 8 | `comment.api.js` + `useComment.js` + `EpisodeComments.jsx` |
| 9 | `EpisodeList` 集成 `EpisodeComments` 手风琴 |
| 10 | `AnimeDetailPage` 引入 `EpisodeList` |

---

## 验证方式

1. **语言切换**：Navbar 点击 `中/EN` → 全站 UI 文字实时切换；刷新后保持选择
2. **集数列表**：访问 `/anime/:id`（如 Frieren）→ 详情页底部显示 28 张集数卡
3. **进度高亮**：已登录并记录进度 → 已看集数绿色、当前集紫色
4. **磁链弹窗**：点击某集「磁链」按钮 → Modal 弹出 → 显示 Nyaa 搜索结果 → 复制按钮变绿
5. **无集数番剧**：`episodes=0` 的番剧 → 显示「集数信息待更新」
6. **评论展开**：点击集数卡片 → 手风琴展开评论区；再点同一集 → 收起
7. **访客评论**：未登录 → 输入框区域显示「请登录后参与评论」
8. **评论增删**：登录后发布评论 → 列表顶部出现；点删除 → 消失
