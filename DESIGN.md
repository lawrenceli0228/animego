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

## Decisions Log

| Date       | Decision                              | Rationale                                                              |
|------------|---------------------------------------|------------------------------------------------------------------------|
| 2026-03-27 | 放弃紫色 `#7c3aed`，换用 iOS Blue `#0a84ff` | 用户明确要求；Apple Blue 更克制，避免霓虹感                          |
| 2026-03-27 | 背景从蓝调暗色换为 Apple True Black    | 与 iOS Blue 体系一致；OLED 省电；视觉更沉稳                          |
| 2026-03-27 | 保留 Sora + DM Sans 字体组合           | Sora 已集成且有日系差异点；DM Sans 易读性好；竞品调研确认品类内少见   |
| 2026-03-27 | 副色选 iOS Teal `#5ac8fa`              | 与 iOS Blue 同属 Apple 色系，保持系统感；严格限定为只读/信息场景      |
| 2026-03-27 | 文字改用 Apple Label System（rgba）    | 比固定灰色更自然地适配不同背景层，层次感更丰富                        |
| 2026-03-27 | 初版设计系统建立                       | 由 /design-consultation 基于竞品调研（AniList、MAL）生成              |
