# AnimeGo 社区平台 v2 设计文档

> **来源：** CEO Review · 2026-03-21 · SELECTIVE EXPANSION · Plan C 分阶段交付
> **状态：** 设计锁定，待实施

---

## 目标

将 AnimeGo 从单人追番工具升级为轻量社区平台，通过三阶段分阶段交付降低冷启动风险：

1. **Phase 1：趋势发现**（被动社交，无需好友）
2. **Phase 2：社交图谱**（关注 + 公开主页 + 动态流）
3. **Phase 3：实时弹幕**（首播夜 WebSocket 弹幕）

---

## Phase 1：趋势发现 + "谁在看"

### 功能范围

- **热门排行榜** `GET /api/anime/trending`
  - 数据来源：`Subscription.aggregate` 统计各番剧订阅人数
  - 返回：`[{ anilistId, title, coverImage, watcherCount }]`，默认 Top 10
  - 缓存：内存缓存 1h TTL（单例 Map，与 torrent 缓存同模式）
  - 无需新 model

- **"谁在看" 用户头像列表**（番剧详情页内嵌）
  - 数据来源：`Subscription.find({ anilistId }).populate('userId', 'username')`
  - 展示：最多 5 个头像 + "还有 N 人在看"
  - 仅展示公开用户（Phase 2 引入 `isPublic` 后过滤）

- **TrendingSection.jsx**（首页新模块）
  - 横向卡片列表，复用扩展后的 `AnimeCard`（新增 `rank` + `watcherCount` props）
  - 卡片展示：左上角大字 **#N**（深紫色）、卡片底部「N 人在看」计数
  - **首页位置：** HeroCarousel → **TrendingSection** → ContinueWatching → WeeklySchedule
  - **设计系统对齐：**
    - 小标签：`color:'#7c3aed', fontSize:13, fontWeight:600, letterSpacing:'2px', textTransform:'uppercase'`（同 ContinueWatching 模式）
    - 大标题：渐变文字 `linear-gradient(135deg,#f1f5f9,#94a3b8)` + `WebkitBackgroundClip:'text'`（同 ContinueWatching 模式）
    - 横向滚动：`overflowX:'auto', scrollbarWidth:'thin', scrollbarColor:'rgba(124,58,237,0.3) transparent'`（同 ContinueWatching 模式）
    - 框架屏 shimmer：`@keyframes shimmer { 0%{opacity:0.5} 50%{opacity:1} 100%{opacity:0.5} }` + `background:#1e293b`
  - **i18n 文案（需加入 locale 文件）：**
    - `home.trendingLabel` → 中: `本季热追` / 英: `TRENDING`
    - `home.trendingTitle` → 中: `大家都在追` / 英: `Most Watched This Season`
  - **响应式 & 无障碍：**
    - 卡片固定尺寸：`140px × 210px`（手机上每屏 2-3 张可见 + 半张提示可滚动）
    - AnimeCard 的 `<div onClick>` 在 Trending 用法中补加 `role="button" tabIndex={0}` + `onKeyDown` 回车支持
    - `#N` 排名徽章加 `aria-label="排名第N"`
  - **交互状态表：**
    ```
    状态          | 展示内容
    -------------|------------------------------------------
    LOADING      | 横向 4 个骨架卡片（固定宽高，shimmer 动画）
    EMPTY        | 整个模块隐藏（不渲染），不展示空状态
    ERROR        | 整个模块隐藏（降级处理，不报错）
    SUCCESS      | 横向卡片列表，最多 10 张
    ```

- **WatchersAvatarList.jsx**（番剧详情页英雄区内嵌）
  - **位置：** 订阅按钮正下方（英雄区内部）
  - **布局：** `██ ██ ██ +N 人在看`（圆形彩色头像 + 截断文字）
  - **头像颜色池（从设计语言取色，username.charCodeAt(0) % 6）：**
    `['#7c3aed','#06b6d4','#10b981','#f59e0b','#ec4899','#6366f1']`
  - **头像尺寸：** 28px 直径，`marginRight: -8px`（叠加效果），`border: 2px solid #0a0e1a`（背景色边框）
  - **无障碍：** 每个头像 `title={username}` + `aria-label={username}`
  - **i18n 文案：**
    - `anime.watchers` → 中: `{n} 人在追` / 英: `{n} watching`
    - `anime.watchersMore` → 中: `还有 {n} 人` / 英: `+{n} more`
  - **交互状态表：**
    ```
    状态          | 展示内容
    -------------|------------------------------------------
    LOADING      | 不渲染（英雄区已有订阅按钮占位）
    EMPTY (0人)  | 完全不渲染（不展示"成为第一个"文案）
    SUCCESS      | 最多 5 个头像圆圈 + "+N 人在看"
    ```
  - 形成「社交证据 + 行动入口」组合

### 新文件

```
server/
  controllers/trending.controller.js
  routes/trending.routes.js

client/src/
  components/home/TrendingSection.jsx
```

### API

```
GET /api/anime/trending?limit=10
Response: { data: [{ anilistId, title, coverImage, watcherCount }] }

GET /api/anime/:anilistId/watchers?limit=5
Response: { data: [{ userId, username }], total: number }
```

---

## Phase 2：社交图谱

### 功能范围

- **公开追番页** `/u/:username`
  - 展示用户当前追番列表（status = WATCHING）
  - 强制公开（无隐私开关，见 TODO 四）
  - SSR-friendly：`<title>` 和 OG tags 含用户名

- **Follow model**（单向关注）
  - Schema：`{ followerId, followeeId, createdAt }`
  - 唯一索引：`{ followerId, followeeId }`

- **关注 API**
  ```
  POST   /api/users/:userId/follow
  DELETE /api/users/:userId/follow
  GET    /api/users/:userId/followers?page=1
  GET    /api/users/:userId/following?page=1
  ```

- **分享按钮**
  - 番剧详情页 + 公开追番页均可分享
  - 实现：`navigator.share()` + 降级复制链接
  - URL 格式：`/anime/:anilistId`、`/u/:username`

- **活动动态流** `GET /api/feed`
  - 查询：当前用户关注列表的最近 Subscription 更新（lastWatchedAt）
  - 排序：时间倒序，分页
  - 无单独 Feed model，实时聚合

### 新文件

```
server/
  models/Follow.js
  controllers/follow.controller.js
  controllers/profile.controller.js
  routes/follow.routes.js
  routes/profile.routes.js

client/src/
  pages/UserProfile.jsx
  components/social/FollowButton.jsx
  components/social/ActivityFeed.jsx
```

---

## Phase 3：实时弹幕

### 功能范围

- **WebSocket 弹幕**（socket.io）
  - 首播夜窗口：番剧 `liveEndsAt` 时间戳内可发弹幕
  - 客户端判断 `Date.now() < liveEndsAt` 决定是否展示发送框
  - 历史弹幕：`GET /api/danmaku/:anilistId/:episode`（HTTP，不走 WS）

- **Danmaku model**
  ```javascript
  {
    anilistId: Number,
    episode:   Number,
    userId:    ObjectId,
    username:  String,
    content:   String,        // max 50 chars
    liveEndsAt: Date,         // 首播时间 + 2h
    createdAt:  Date
  }
  ```

- **WebSocket 鉴权**：JWT Handshake
  ```javascript
  // client 连接时携带 token
  socket = io(SERVER_URL, { auth: { token: localStorage.getItem('token') } })

  // server middleware 验证
  io.use((socket, next) => {
    const token = socket.handshake.auth.token
    // verify JWT → attach socket.userId
  })
  ```

- **限流**：Socket 内幕限流（1 条 / 5s / 用户）
  ```javascript
  // server 维护 Map<userId, lastSentAt>
  const lastSent = new Map()
  socket.on('danmaku', (data) => {
    const now = Date.now()
    if (now - (lastSent.get(userId) ?? 0) < 5000) return
    lastSent.set(userId, now)
    // broadcast + persist
  })
  ```

### 新文件

```
server/
  models/Danmaku.js
  socket/index.js              // socket.io server setup
  socket/danmaku.handler.js    // event handlers + rate limiting
  middleware/socketAuth.js

client/src/
  hooks/useDanmaku.js          // socket.io-client wrapper
  components/anime/DanmakuOverlay.jsx
  components/anime/DanmakuInput.jsx
```

### Railway 扩容注意事项

现阶段单实例 Railway 部署 WebSocket 可正常工作。多实例扩容时需引入 Redis Pub/Sub（见 TODO 五）。

---

## 关键决策记录

| 决策点 | 结论 | 备注 |
|--------|------|------|
| 实施策略 | 分阶段交付（Plan C） | 降低冷启动风险，每阶段独立验证 |
| 用户可见性 | 强制公开（Phase 1–2） | 规模化后补 isPublic（TODO 四） |
| 弹幕协议 | WebSocket（socket.io） | SSE 不支持双向，轮询延迟高 |
| WS 鉴权 | JWT Handshake | HTTP cookie 跨域复杂，handshake 干净 |
| WS 限流 | Socket 内幕限流（1条/5s） | 无需 Redis，单实例足够 |
| 弹幕窗口 | 存 liveEndsAt，客户端判断 | 服务端无 setInterval，重启不丢状态 |
| Follow 方向 | 单向关注 | 双向 = 微信，单向 = Twitter，符合动漫社区调性 |

---

## 实施前 Checklist

- [ ] **待办三**：补写核心测试（Jest + Vitest）
- [ ] Phase 1 上线并验证 Trending 有真实数据后进入 Phase 2
- [ ] Phase 2 上线并验证关注图谱有用户后进入 Phase 3

---

_设计时间：2026-03-21_
_下一步：`/plan-eng-review` 对 Phase 1 实施方案做工程评审_
