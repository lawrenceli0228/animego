# AnimeGo 开发日志

---

## 2026-03-07

### 18:26 · 初始化项目

- 创建 GitHub 仓库 `lawrenceli0228/animego`，配置 SSH 认证
- 写入 `.gitignore`（保护 `.env`、`node_modules`）
- 写入项目架构说明 `README.md`
- 配置 `.claude/launch.json` 开发服务器启动项

---

### 18:58 · 完成全栈代码开发（64 文件 / 7775 行）

**后端 · Express + MongoDB Atlas**

- `server/index.js` — Express 入口，CORS + Cookie 配置
- `server/config/db.js` — Mongoose 连接 MongoDB Atlas
- `server/models/` — User（bcrypt 加密）、AnimeCache、Subscription
- `server/services/anilist.service.js` — AniList GraphQL 代理 + MongoDB 缓存
- `server/controllers/` — 认证（JWT 双 Token）、番剧、订阅
- `server/routes/` — `/api/auth`、`/api/anime`、`/api/subscriptions`
- `server/middleware/` — JWT 验证、限流、错误处理

**前端 · React 18 + Vite**

- 暗色电影风格 UI（`#0a0e1a` 深海军蓝 + `#7c3aed` 紫 + `#06b6d4` 青）
- 页面：首页、季度、番剧详情、搜索、登录、注册、个人追番
- 组件：AnimeCard / AnimeGrid / 订阅按钮 / 季度选择器 / 搜索栏 / 分页
- TanStack Query 管理服务端状态，axios 自动刷新 Token

---

### 19:08 · 修复 AniList API 429 限流

**问题：** 每次请求都直接打 AniList，触发 90次/分钟限制

**修复（`anilist.service.js`）：**

- `getSeasonalAnime` — 优先读 MongoDB 缓存，命中则跳过 AniList 请求
- `searchAnime` — 新增内存缓存，相同搜索 10 分钟内不重复请求
- `queryAniList` — 加出站限速，两次请求间隔 ≥ 700ms（≈85次/分钟）

**涉及文件：**
- `server/services/anilist.service.js`

---

### 19:17 · 修复页面无限刷新死循环

**问题根因：**

```
无 cookie → /auth/refresh 返回 401
→ axios 拦截器捕获 → 再调一次 refresh → 失败
→ window.location.href = '/login'  ← 触发整页重载
→ AuthContext 重新挂载 → 再调 refresh → 无限循环
```

**修复：**

- 拦截器跳过 `/auth/refresh` 自身的 401（防套娃）
- 移除 `window.location.href` 硬跳转，改为派发 `auth:expired` 自定义事件
- `AuthContext` 用原生 `axios` 调 refresh，不触发拦截器
- `AuthContext` 监听 `auth:expired` 事件，优雅清除登录状态

**涉及文件：**
- `client/src/api/axiosClient.js`
- `client/src/context/AuthContext.jsx`

---

### 19:22 · 改为访客友好模式，无需强制登录

**需求：** 用户打开网站直接显示番剧内容，不强制跳转登录页

**修复：**

- `AuthContext` 拆分 `initializing`（启动 session 检查）和 `loading`（登录/注册操作中）两个独立状态
- `ProtectedRoute` 改用 `initializing` 判断，session 检查完成前不提前重定向
- `LoginPage` / `RegisterPage` 新增：已登录用户访问时自动跳回首页

**访客浏览流程：**

```
打开网站 → 首页番剧立即渲染
         → 后台静默检查 session（~200ms）
         ├── 有 session → Navbar 显示用户名和追番入口
         └── 无 session → 访客模式，Navbar 显示登录/注册按钮
仅 /profile 需要登录，其余页面全部公开访问
```

**涉及文件：**
- `client/src/context/AuthContext.jsx`
- `client/src/components/common/ProtectedRoute.jsx`
- `client/src/pages/LoginPage.jsx`
- `client/src/pages/RegisterPage.jsx`

---

## Git 提交记录

| Hash | 时间 | 说明 |
|------|------|------|
| `feb3ca6` | 18:26 | Initial project setup: AnimeGo anime website |
| `5e8aa59` | 18:58 | feat: implement full-stack AnimeGo anime website |
| `800f0ef` | 19:08 | fix: resolve AniList 429 rate limit with cache-first strategy |
| `083d5ec` | 19:17 | fix: resolve infinite page refresh loop on startup |
| `f11f453` | 19:22 | fix: guests see content immediately, no forced login |

仓库地址：`https://github.com/lawrenceli0228/animego`
