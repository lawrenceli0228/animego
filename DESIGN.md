# Design System — AnimeGo

## Product Context
- **What this is:** 面向中文用户的全栈追番 + 社区平台，支持追番管理、剧集评论、弹幕、关注系统、热门排行
- **Who it's for:** 中文动漫爱好者，熟悉 AniList/MAL，偏好暗色界面
- **Space/industry:** 动漫流媒体 / 追番社区（对标 AniList、Bilibili、Crunchyroll）
- **Project type:** 全栈 Web App（React SPA + Express API）

## Aesthetic Direction
- **Direction:** Cinematic Dark — 影院暗黑
- **Decoration level:** minimal（排版和层次做所有工作，无多余装饰）
- **Mood:** 进影院看大片的沉浸感。深邃、克制、精准。不是 SaaS 的干净，是大屏的大气。
- **Competitive insight:** AniList 用单蓝 accent + 浅灰背景，整个品类视觉同质化。AnimeGo 用 Apple True Black + iOS Blue，更沉、更有质感。

## Typography

- **Display/Hero:** Sora 700–800 — 日本设计师设计的几何无衬线，有隐性日系精密感，品类内少见
- **Body:** DM Sans 400–500 — 干净易读，不抢 Sora 的戏
- **UI/Labels:** DM Sans（同 Body）
- **Data/Tables:** DM Sans，使用 `font-variant-numeric: tabular-nums`
- **Code:** JetBrains Mono 400 — 用于 API 输出、磁力链接、剧集编号
- **Loading:** Google Fonts CDN
  ```
  https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800
    &family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400
    &family=JetBrains+Mono:wght@400;500
    &display=swap
  ```

### Type Scale
| Token     | Size     | Weight | Usage              |
|-----------|----------|--------|--------------------|
| display   | 48px/3rem | 800   | Hero 标题           |
| h1        | 32px/2rem | 700   | 页面主标题           |
| h2        | 24px/1.5rem | 600 | 区块标题             |
| h3        | 18px/1.125rem | 600 | 子区块标题          |
| body      | 16px/1rem | 400   | 正文                |
| body-sm   | 15px/0.9375rem | 400 | 辅助正文           |
| label     | 14px/0.875rem | 500 | UI 标签、按钮       |
| caption   | 13px/0.8125rem | 400 | 次要说明           |
| micro     | 11px/0.6875rem | 500 | 标签、Badge、Code label |

### Letter Spacing
- Display: `-0.03em`
- Headings: `-0.02em`
- Body: `0`
- Labels/Code (uppercase): `+0.1em`

## Color

**Approach:** restrained — iOS Blue 是唯一主 Accent，色彩极度克制，稀少时才有力量

### Backgrounds — Apple True Black System
| Token             | Value     | Usage                     |
|-------------------|-----------|---------------------------|
| `--bg`            | `#000000` | 页面底色                  |
| `--bg-card`       | `#1c1c1e` | 卡片、面板                |
| `--bg-elevated`   | `#2c2c2e` | 浮层、输入框、悬浮菜单    |
| `--bg-fill`       | `rgba(120,120,128,0.12)` | 次要填充（ghost 按钮）|
| `--separator`     | `rgba(84,84,88,0.65)`    | 半透明分隔线              |
| `--separator-opaque` | `#38383a`             | 不透明分隔线、卡片边框    |

### Accent — iOS Blue（主操作）
| Token           | Value                    | Usage                         |
|-----------------|--------------------------|-------------------------------|
| `--accent`      | `#0a84ff`                | 按钮、CTA、链接、焦点环、进度条 |
| hover           | `#409cff`                | 悬停态                        |
| `--accent-dim`  | `rgba(10,132,255,0.12)`  | 背景填充、焦点 shadow          |

> **规则：** `--accent` 只用于主操作。不要在纯装饰场景使用蓝色。

### Secondary — iOS Teal（信息场景）
| Token         | Value                   | Usage                             |
|---------------|-------------------------|-----------------------------------|
| `--teal`      | `#5ac8fa`               | 信息标签、磁力资源、弹幕分区、Code 高亮 |
| `--teal-dim`  | `rgba(90,200,250,0.10)` | Teal 背景填充                      |

> **规则：** Teal 只用于信息性/只读场景，不做可点击操作。

### Text — Apple Label System
| Token                | Value                    | Usage            |
|----------------------|--------------------------|------------------|
| `--text`             | `#ffffff`                | 主正文           |
| `--text-secondary`   | `rgba(235,235,245,0.60)` | 辅助文字         |
| `--text-tertiary`    | `rgba(235,235,245,0.30)` | 说明、占位符     |
| `--text-quaternary`  | `rgba(235,235,245,0.18)` | 极淡文字、禁用态 |

### Semantic — Apple System Colors
| Token       | Value     | Usage              |
|-------------|-----------|--------------------|
| `--success` | `#30d158` | 追番成功、已完结    |
| `--warning` | `#ff9f0a` | 评分、连载中        |
| `--error`   | `#ff453a` | 错误、删除确认      |
| `--info`    | `#5ac8fa` | 同 `--teal`         |

### Dark Mode
单一暗色主题，不提供亮色模式。背景已基于 Apple True Black，在 OLED 屏幕上极省电。

## Spacing

- **Base unit:** 8px
- **Density:** comfortable（内容浏览型产品，留白给封面图呼吸）
- **Max content width:** 1400px（`max-width: 1400px; margin: 0 auto; padding: 0 24px`）

| Token     | Value | Usage                |
|-----------|-------|----------------------|
| `--sp-xs` | 4px   | 图标间距、极小 gap    |
| `--sp-sm` | 8px   | 基础单位、元素内间距  |
| `--sp-md` | 16px  | 组件内边距            |
| `--sp-lg` | 24px  | 区块间距、容器 padding|
| `--sp-xl` | 32px  | 大区块间距            |
| `--sp-2xl`| 48px  | Section 内部分隔      |
| `--sp-3xl`| 64px  | 页面 Section 分隔     |

## Layout

- **Approach:** grid-disciplined — 严格列网格，卡片区不允许自由排版
- **Grid:** 6列（桌面）→ 3列（平板 ≤900px）→ 2列（手机 ≤600px）
- **Max content width:** 1400px

### Border Radius
| Token          | Value  | Usage            |
|----------------|--------|------------------|
| `--radius-sm`  | 8px    | 输入框、小按钮    |
| `--radius`     | 12px   | 卡片、标准按钮    |
| `--radius-lg`  | 16px   | 模块面板、大卡片  |
| `--radius-xl`  | 20px   | 大弹窗、Sheet     |
| `--radius-full`| 9999px | Badge、头像、Tag  |

## Motion

- **Approach:** intentional — 只有服务于状态理解的动画，无纯装饰动画
- **Easing:** `cubic-bezier(0.4, 0, 0.2, 1)`（所有状态转换）
  - Enter: `ease-out`（快进慢出，元素进场）
  - Exit: `ease-in`（慢进快出，元素退场）

| Token        | Duration  | Usage                  |
|--------------|-----------|------------------------|
| micro        | 50–100ms  | 图标状态切换            |
| short        | 150–250ms | 按钮 hover、颜色过渡    |
| medium       | 250–400ms | 卡片进场、模态框        |
| long         | 400–700ms | 页面转场、Toast         |
| Ken Burns    | 8–12s     | 首页 Hero 横幅缓慢缩放  |

## Component Stylings

### Buttons

**Primary (CTA)**
- Background: `#0a84ff` (`--accent`)
- Text: `#ffffff`
- Padding: 10px 20px
- Radius: 8px (`--radius-sm`)
- Font: DM Sans, 14px, weight 500
- Hover: background `#409cff`, `transition 150ms ease-out`
- Active: background `#0070d6`
- Focus: `0 0 0 3px rgba(10,132,255,0.40)` box-shadow
- Disabled: opacity 0.35, pointer-events none
- Use: 主操作 — 追番、登录、发送评论、确认弹窗

**Ghost / Secondary**
- Background: `rgba(120,120,128,0.12)` (`--bg-fill`)
- Text: `#0a84ff` (`--accent`)
- Padding: 10px 20px
- Radius: 8px
- Border: none
- Hover: background `rgba(120,120,128,0.20)`
- Use: 次操作 — 取消、筛选、切换视图

**Outlined**
- Background: transparent
- Text: `rgba(235,235,245,0.60)` (`--text-secondary`)
- Padding: 8px 16px
- Radius: 8px
- Border: `1px solid rgba(84,84,88,0.65)` (`--separator`)
- Hover: border-color `#0a84ff`, text `#0a84ff`
- Use: 三级操作 — "Load More"、外链

**Danger**
- Background: `#ff453a` (`--error`)
- Text: `#ffffff`
- Padding: 10px 20px
- Radius: 8px
- Hover: background `#ff6961`
- Use: 删除确认、退出登录

**Icon Button (圆形)**
- Background: `rgba(120,120,128,0.12)` (`--bg-fill`)
- Size: 40×40px
- Radius: 50%
- Icon color: `rgba(235,235,245,0.60)` (`--text-secondary`)
- Hover: background `rgba(120,120,128,0.20)`, icon color `#ffffff`
- Use: 收藏、分享、弹幕开关、播放控制

### Cards

**Anime Card (网格卡片)**
- Background: `#1c1c1e` (`--bg-card`)
- Radius: 12px (`--radius`)
- Border: `1px solid #38383a` (`--separator-opaque`)
- Overflow: hidden
- 封面图: 顶部，`aspect-ratio: 3/4`，`object-fit: cover`
- 标题: Sora 14px weight 600，`--text`，最多 2 行 `line-clamp`
- 副标题: DM Sans 13px weight 400，`--text-secondary`
- Hover: `transform: translateY(-4px)`, `box-shadow: 0 8px 24px rgba(0,0,0,0.40)`，`transition 250ms ease-out`
- `rank` badge: 左上角，`--accent` 背景，11px weight 500，`--radius-full`
- `watcherCount` badge: 右上角，`--bg-elevated` 背景 + backdrop-blur

**Detail Card (信息面板)**
- Background: `#1c1c1e` (`--bg-card`)
- Radius: 16px (`--radius-lg`)
- Padding: 24px (`--sp-lg`)
- Border: `1px solid #38383a`
- Use: 详情页侧边信息、角色卡、剧集列表

**Elevated Card (浮层卡片)**
- Background: `#2c2c2e` (`--bg-elevated`)
- Radius: 12px
- Shadow: `0 8px 32px rgba(0,0,0,0.50)`
- Use: 下拉菜单、Tooltip、弹幕面板

### Inputs

**Text Input**
- Background: `#2c2c2e` (`--bg-elevated`)
- Text: `#ffffff` (`--text`)
- Placeholder: `rgba(235,235,245,0.30)` (`--text-tertiary`)
- Padding: 12px 16px
- Radius: 8px (`--radius-sm`)
- Border: `1px solid #38383a` (`--separator-opaque`)
- Focus: border-color `#0a84ff`, `box-shadow: 0 0 0 3px rgba(10,132,255,0.25)`
- Font: DM Sans, 16px, weight 400

**Search Input**
- Same as Text Input
- Radius: 9999px (`--radius-full`)
- Padding: 12px 16px 12px 44px（左侧搜索图标）
- Use: 顶栏搜索框

**Select / Dropdown**
- 同 Text Input 样式
- 右侧 chevron icon，`--text-tertiary`
- Open state: 展开列表用 Elevated Card 样式

### Navigation

**Top Bar**
- Background: `rgba(0,0,0,0.80)` + `backdrop-filter: saturate(180%) blur(20px)`
- Height: 56px
- Position: sticky top
- Logo: Sora 20px weight 700，`--text`
- Nav links: DM Sans 14px weight 500，`--text-secondary`
- Active link: `--text` + 底部 2px `--accent` 下划线
- Hover: `--text`

**Mobile Bottom Bar**
- Background: `#1c1c1e` + `backdrop-filter: blur(20px)`
- Height: 56px + safe-area-inset-bottom
- Border-top: `1px solid rgba(84,84,88,0.65)` (`--separator`)
- Icons: 24px，inactive `--text-tertiary`，active `--accent`
- Labels: 11px weight 500，同图标颜色

### Tags & Badges

**Genre Tag**
- Background: `rgba(120,120,128,0.12)` (`--bg-fill`)
- Text: `--text-secondary`
- Padding: 4px 10px
- Radius: 9999px (`--radius-full`)
- Font: DM Sans, 12px, weight 500
- Hover: background `rgba(120,120,128,0.20)`

**Status Badge**
- 连载中: `--warning` (`#ff9f0a`) 文字 + `rgba(255,159,10,0.12)` 背景
- 已完结: `--success` (`#30d158`) 文字 + `rgba(48,209,88,0.12)` 背景
- 未播出: `--text-tertiary` 文字 + `--bg-fill` 背景
- Padding: 4px 8px, Radius: 9999px, Font: 11px weight 500

**Score Badge**
- Background: `rgba(255,159,10,0.12)`
- Text: `--warning` (`#ff9f0a`)
- Font: JetBrains Mono, 13px, weight 500
- Radius: 6px

## Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Base (Level 0) | `#000000` — 无 shadow | 页面底色 |
| Surface (Level 1) | `#1c1c1e` — 无 shadow 或极淡 `0 1px 2px rgba(0,0,0,0.20)` | 卡片、面板、侧栏 |
| Elevated (Level 2) | `#2c2c2e` + `0 8px 32px rgba(0,0,0,0.50)` | 下拉菜单、Tooltip、浮层面板 |
| Modal (Level 3) | `#2c2c2e` + `0 16px 48px rgba(0,0,0,0.60)` + 背景 `rgba(0,0,0,0.60)` overlay | 模态框、确认弹窗 |
| Navigation Glass | `rgba(0,0,0,0.80)` + `backdrop-filter: saturate(180%) blur(20px)` | 顶栏、移动端底栏 |
| Focus Ring | `0 0 0 3px rgba(10,132,255,0.40)` | 键盘焦点态，所有可交互元素 |

**Shadow 哲学：** 暗色主题 shadow 必须足够重（0.40–0.60 opacity）才能在黑色背景上可见。但 Level 0→1 的提升主要靠背景色差而非 shadow — 与 Apple 一致，shadow 留给真正"浮起来"的元素。

## Do's and Don'ts

### Do
- 用 `#0a84ff` (`--accent`) 作为**唯一**可点击操作色 — 按钮、链接、焦点环、进度条
- 用三层背景色差（`#000` → `#1c1c1e` → `#2c2c2e`）表达层级，而非堆 shadow
- 封面图使用 `aspect-ratio: 3/4` + `object-fit: cover`，保持网格整齐
- 所有可交互元素必须有 focus ring（`0 0 0 3px rgba(10,132,255,0.40)`）
- 新增 UI 文案时同步更新 `zh.js` 和 `en.js` 两个 locale 文件
- 用 `pickTitle(anime, lang)` 选择标题，不要手动判断语言
- 动画只服务于状态理解 — 卡片悬浮、模态进出、Toast 通知
- 保持 `font-variant-numeric: tabular-nums` 在所有数字场景（评分、集数、排名）
- 顶栏使用毛玻璃效果（`backdrop-filter: blur`）— 这是 Apple 暗色 UI 的标志

### Don't
- 不要引入蓝色以外的 accent 色 — 无紫色、无渐变、无霓虹
- 不要给卡片加 border-radius > 16px — `--radius-xl`(20px) 仅限大弹窗
- 不要对 Level 0/1 元素加 shadow — 纯黑背景上的卡片靠边框和色差区分
- 不要用 `#5ac8fa` (teal) 做可点击元素 — teal 严格限定为只读/信息场景
- 不要用纯装饰动画 — 无 parallax、无浮动粒子、无自动轮播
- 不要在暗色背景上用低透明度 shadow（< 0.3 opacity）— 会完全不可见
- 不要用 `#ffffff` 做大面积背景 — 本项目只有暗色主题
- 不要给封面图加圆角 > 12px — 封面图遵循卡片的 `--radius`
- 不要在正文里居中对齐 — 正文左对齐，只有 hero 标题和空状态可以居中

## Responsive Behavior

### Breakpoints
| Name | Width | Key Changes |
|------|-------|-------------|
| Mobile | < 600px | 2 列网格，底部导航栏，搜索收起为图标 |
| Tablet | 600–900px | 3 列网格，顶栏导航，侧边栏隐藏 |
| Desktop | 900–1400px | 6 列网格，完整顶栏 + 侧边信息面板 |
| Large Desktop | > 1400px | 内容居中，`max-width: 1400px`，两侧留白 |

### Touch Targets
- 所有按钮最小高度: 44px（Apple HIG 标准）
- 底部导航图标触控区: 48×48px
- 卡片整体可点击，无需精确点击小文字
- Genre Tag 间距 ≥ 8px，防止误触

### Collapsing Strategy
- **网格:** 6 列 → 3 列 → 2 列，`gap` 从 16px 缩为 12px
- **详情页:** 桌面双栏（封面+信息 | 剧集+评论）→ 移动端单栏堆叠
- **顶栏:** 桌面完整导航 → 移动端仅 Logo + 搜索图标 + 用户头像
- **导航:** 桌面顶栏 → 移动端底部 Tab Bar（首页/搜索/追番/我的）
- **弹幕面板:** 桌面侧边常驻 → 移动端底部 Sheet（上滑展开）
- **封面图:** 保持 `3:4` 比例不变，宽度随网格自适应

### Font Scaling
- Display (48px) → 移动端 32px
- H1 (32px) → 移动端 24px
- H2 (24px) → 移动端 20px
- Body (16px) → 不变
- 使用 `clamp()` 实现平滑缩放：`font-size: clamp(32px, 5vw, 48px)`

## Agent Prompt Guide

### Quick Color Reference
| Role | Value | Token |
|------|-------|-------|
| Page background | `#000000` | `--bg` |
| Card background | `#1c1c1e` | `--bg-card` |
| Elevated surface | `#2c2c2e` | `--bg-elevated` |
| Primary accent | `#0a84ff` | `--accent` |
| Accent hover | `#409cff` | — |
| Accent dim fill | `rgba(10,132,255,0.12)` | `--accent-dim` |
| Info teal | `#5ac8fa` | `--teal` |
| Primary text | `#ffffff` | `--text` |
| Secondary text | `rgba(235,235,245,0.60)` | `--text-secondary` |
| Tertiary text | `rgba(235,235,245,0.30)` | `--text-tertiary` |
| Success | `#30d158` | `--success` |
| Warning | `#ff9f0a` | `--warning` |
| Error | `#ff453a` | `--error` |
| Card border | `#38383a` | `--separator-opaque` |
| Focus ring | `0 0 0 3px rgba(10,132,255,0.40)` | — |
| Card hover shadow | `0 8px 24px rgba(0,0,0,0.40)` | — |
| Modal shadow | `0 16px 48px rgba(0,0,0,0.60)` | — |

### Example Component Prompts
- "创建一个 Anime Card：`#1c1c1e` 背景，`12px` 圆角，`1px solid #38383a` 边框。封面图 `aspect-ratio: 3/4`，`object-fit: cover`。标题 Sora 14px weight 600 白色，最多 2 行 `line-clamp`。副标题 DM Sans 13px `rgba(235,235,245,0.60)`。Hover 时 `translateY(-4px)` + `box-shadow: 0 8px 24px rgba(0,0,0,0.40)`，`transition 250ms ease-out`。"
- "创建主操作按钮：`#0a84ff` 背景，白色文字，`10px 20px` padding，`8px` 圆角。DM Sans 14px weight 500。Hover `#409cff`，Focus `0 0 0 3px rgba(10,132,255,0.40)`。Disabled opacity 0.35。"
- "创建顶部导航栏：sticky，56px 高，`rgba(0,0,0,0.80)` 背景 + `backdrop-filter: saturate(180%) blur(20px)`。Logo 用 Sora 20px weight 700。导航链接 DM Sans 14px weight 500，inactive `rgba(235,235,245,0.60)`，active 白色 + 底部 2px `#0a84ff` 下划线。"
- "创建模态弹窗：`#2c2c2e` 背景，`20px` 圆角，`24px` 内边距，`box-shadow: 0 16px 48px rgba(0,0,0,0.60)`。背景 overlay `rgba(0,0,0,0.60)`。标题 Sora 20px weight 600。关闭按钮右上角圆形 icon button。"
- "创建剧集列表项：`#1c1c1e` 背景，`12px` 圆角，`16px` padding。左侧集数 JetBrains Mono 13px `--warning`。标题 DM Sans 16px weight 500 白色。右侧播出日期 13px `--text-tertiary`。Hover 背景 `#2c2c2e`。"

### Iteration Checklist
1. 可点击 = `#0a84ff`，只读信息 = `#5ac8fa`，无例外
2. 三层背景：`#000` → `#1c1c1e` → `#2c2c2e`，层级靠色差不靠 shadow
3. 字体切换：标题/Display 用 Sora，正文/UI 用 DM Sans，数据/代码用 JetBrains Mono
4. 所有数字 `tabular-nums`，所有交互元素有 focus ring
5. 动画只做状态转换（hover/enter/exit），easing 统一 `cubic-bezier(0.4, 0, 0.2, 1)`
6. 新增文案必须同时写入 `zh.js` 和 `en.js`
7. 网格 6→3→2 列，断点 900px / 600px，`max-width: 1400px`
8. 封面图永远 `3:4` 比例，不裁切、不拉伸

## Decisions Log

| Date       | Decision                              | Rationale                                                              |
|------------|---------------------------------------|------------------------------------------------------------------------|
| 2026-03-27 | 放弃紫色 `#7c3aed`，换用 iOS Blue `#0a84ff` | 用户明确要求；Apple Blue 更克制，避免霓虹感                          |
| 2026-03-27 | 背景从蓝调暗色换为 Apple True Black    | 与 iOS Blue 体系一致；OLED 省电；视觉更沉稳                          |
| 2026-03-27 | 保留 Sora + DM Sans 字体组合           | Sora 已集成且有日系差异点；DM Sans 易读性好；竞品调研确认品类内少见   |
| 2026-03-27 | 副色选 iOS Teal `#5ac8fa`              | 与 iOS Blue 同属 Apple 色系，保持系统感；严格限定为只读/信息场景      |
| 2026-03-27 | 文字改用 Apple Label System（rgba）    | 比固定灰色更自然地适配不同背景层，层次感更丰富                        |
| 2026-03-27 | 初版设计系统建立                       | 由 /design-consultation 基于竞品调研（AniList、MAL）生成              |
