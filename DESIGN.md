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

- **全局主字体:** `--font-sans` = `--font-cjk`，也就是 PingFang SC 打头。
  **拉丁字符也走它**。原来是 `DM Sans, <cjk>`，于是「MADHOUSE · 24分/集」
  这样一行是两套字体拼出来的 —— 拉丁用 DM Sans、中文用 PingFang，x 高度、
  笔画对比、竖直度量都不一样。本站几乎每一行都中英混排，那就等于大多数句子
  中间有一道缝。PingFang 自带完整拉丁字符集（骨架源自 Helvetica Neue），
  一套字体能排完整行。
- **标题:** 同上。Sora 没有中日韩字形，中文标题无论如何都回落到 PingFang，
  所以标题不再单独指定显示字体 —— 层级靠字重和字号，不靠换字体。
- **Latin 显示字体:** `--font-latin`（Sora / DM Sans）改为**按需使用**，
  只用在「按定义就是拉丁文」且中性系统字体会显得没排过版的地方 —— 目前是
  hero 下面那行罗马字标题。
- **Data/Tables:** `--font-mono`（JetBrains Mono），用于字段标签和数字，
  配 `font-variant-numeric: tabular-nums`
- **Code:** JetBrains Mono 400 — 用于 API 输出、磁力链接、剧集编号
- **中文:** `--font-cjk` — PingFang SC / Hiragino Sans GB / Source Han Sans SC /
  Noto Sans CJK SC / Microsoft YaHei。上面三个网页字体都只加载了 latin 子集，
  **一个中日韩字形都没有**，所以站上每一个中文字都是由回落链渲染的。以前那一环
  是 `system-ui`（macOS 上是 PingFang，Windows 上是 Segoe UI，中日韩覆盖看安装
  情况，Linux 上什么都可能）。显式列出来是把它从「碰巧对」变成「有意如此」。
  拉丁字体仍排在最前：它们没有中日韩字形可以抢，浏览器会逐字回落，所以同一条
  声明能同时服务 “MADHOUSE” 和「葬送的芙莉莲」。
- **⚠️ 繁体缺口:** `--font-cjk` 整条链都是**简体**字体（PingFang **SC** /
  Hiragino Sans **GB** / Source Han Sans **SC** / Noto Sans CJK **SC**）。
  `/zh-Hant` 路由下 `html lang="zh-Hant"`，但每一个繁体字仍由这条 SC 链渲染，
  区域字形有差异的字会拿到简体骨架；机器上只装了繁体字体时，靠回落到 `system-ui`
  才碰巧对。这是**既有缺口**，修法是给 `--font-cjk` 加一条按 `:lang(zh-Hant)`
  切换的分支（PingFang TC / Noto Sans CJK TC 打头），需要单独验一遍再动。
- **日文:** `--font-jp` — Hiragino Sans / Yu Gothic / Noto Sans JP，尾部接
  `--font-cjk`。汉字在日文和简体中文里字形不同（直 骨 令 等），日文原名用中文
  字体排出来能读，但对认得出区别的人来说明显别扭。
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

### Per-Anime Poster Accent（"不要蓝色以外的 accent" 的唯一例外）
| Token                 | Value                    | Usage                    |
|-----------------------|--------------------------|--------------------------|
| `--poster-accent`     | 运行时从封面取样          | 封面光晕、hero 关系 chip |
| `--poster-accent-rgb` | 同上，逗号分隔的通道值    | 需要自定 alpha 时        |

这不是设计系统挑的颜色，是**每部番自己的颜色**（`anime_cache.poster_accent`，
由封面图取样得到），所以 "不要引入蓝色以外的 accent 色" 那条对它不适用 ——
那条规则约束的是品牌色。

作用范围：hero 光晕用**原色** `--poster-accent`（纯装饰，不承载文字）；
其余一律用派生的 `--poster-tone*`（见下节）。

**焦点环永远是 `--accent` 蓝，没有例外。** 焦点环是「你在这里」的信号，
不是身份色；`focusRing.test.ts` 的历史里最糟的一个坏环就是「随封面变色，
某些封面上根本看不见」。

按钮有**一个**记录在案的例外：详情页 hero 的主 CTA（`Button` 的
`.primary`，全站仅此一处）。它用 `--poster-tone` 做底 + 同色相 15% 明度做
字。这条例外是**对比度**给的，不是审美给的：白字在 `--accent` 上实测
**3.65:1**，低于 4.5:1 下限，而那是整页最显眼的按钮；深色字在
`--poster-tone` 上穷举 360 个色相是 **8.82–9.51:1**。

除此之外，可点击 = `--accent`。

globals.css 里那个紫色字面量只是取样值到达之前的占位；用它的光晕在
`[data-accent-ready="true"]` 之前是透明的，所以它不会被画出来。

#### 派生色阶 — 只借角度，不借颜色

| Token                 | Value                                | Usage                          |
|-----------------------|--------------------------------------|--------------------------------|
| `--poster-hue`        | 运行时算出的 OKLCH 色相角（0–360 裸数）| 下面四个的唯一输入              |
| `--poster-tone`       | `oklch(76% 0.085 var(--poster-hue))` | 详情页的强调文字、图标、hover   |
| `--poster-tone-quiet` | `oklch(68% 0.07 var(--poster-hue))`  | **仍是文字**，但压低一档的小标签 |
| `--poster-tone-mid`   | `oklch(52% 0.07 var(--poster-hue))`  | 边框、分隔线（非文字）          |
| `--poster-tone-low`   | `oklch(24% 0.045 var(--poster-hue))` | tint 底、chip 填充（纯装饰）    |

`--poster-accent` 是取样到的**原色**，它的对比度不受任何约束。实测 6 个真实
封面色对纯黑是 3.58:1 – 8.84:1，跨度 2.5 倍，其中 2 个（深蓝 `#2e6fbf`、
玫红 `#c2185b`）**低于 WCAG 4.5:1**。原因是封面画面本身 51.8% 偏暖、80.8%
高饱和 —— 这不是取样算法的缺陷，是"直接用画面颜色当 UI 颜色"这件事本身
没有下界。

所以派生色阶**只从封面拿色相角**，明度和彩度由设计系统固定。每部番仍然是
自己的颜色，但落在一条保证可读的带子里。

`76%` 不是拍脑袋：穷举全部 360 个色相，`oklch(76% 0.085 h)` 在最严的
`--bg-elevated` 上最低 6.22:1，全部通过；能过 4.5:1 的最小明度是 68%，
所以留了 8 个百分点余量。这条证明在 `lib/oklch.test.ts` 里是可执行的测试，
改 L 或 C 会直接告诉你哪些色相破了。

`--poster-tone-mid` 只到 3.65:1（够 WCAG 1.4.11 的非文字 3:1），
`--poster-tone-low` 只有 1.25:1 —— **这两个永远不要拿来写字**。

**`--poster-tone-quiet` 存在的唯一理由，就是堵住上面这句话留下的坑。**
详情页有一类小标签（角色卡的「主角 / 配角」）需要"番剧色，但比评分数字轻一档"。
色阶里唯一看起来符合"轻一档"的是 `--poster-tone-mid`，而它是给线条用的 ——
拿它写 10px 标签，跨全色相最差 **3.65:1**，不过 AA。这个错误在样式表里、在评审里都长得
完全正确，所以它需要的不是一句警告，而是一个能用的 token。

`68%` 同样是反解出来的，不是挑的：C=0.07 时能过 4.5:1 的最低明度，`--bg` 上是
57，`--bg-card` 上是 62.5，`--bg-elevated` 上是 **67.5**。token 必须扛得住它可能
落到的最严的那层背景，不是它今天恰好待着的那层。参考设计用的是 62 —— 那套设计
只有一个背景色，搬过来会"在页面上过、进卡片就不过"。

推论：`--poster-tone-quiet` 是**色阶里最后一档能写字的颜色**。还要更轻，就别用
色相了，改用中性文字色。这条和 `--poster-tone` 的 8 个百分点余量不同 ——
它按定义就贴着地板站，`lib/oklch.test.ts` 里三层背景 × 360 色相都钉住了。

##### 陷阱：三个 tone 必须在设 `--poster-hue` 的那个元素上声明

CSS 自定义属性的 `var()` 替换发生在**声明它的元素**上，不是使用它的元素上。
所以下面这样写是**无效的**：

```css
:root { --poster-hue: 292.7; --poster-tone: oklch(76% .085 var(--poster-hue)); }
.某部番 { --poster-hue: 135.8; }   /* 改不动 --poster-tone */
```

`--poster-tone` 在 `:root` 上就已经用 `:root` 的色相算完了，往下继承的是一个
算死的紫色，子元素再改 `--poster-hue` 也没用。实测：6 个不同色相全部渲染成
同一个紫，而样式表看起来完全正确 —— **这是个静默失效，代码审查和 markup
里都看不出来**。

正确做法是 `globals.css` 里的 `.poster-scope`：在写 `--poster-hue` 的**同一个
元素**上重新声明这三个 token。`HeroAccent` 同时输出 class 和行内 hue，两者
是一个机制，拆开任何一半都会退回上面那个失效状态。同样 6 个色相在修正后
渲染出 6 种颜色，对比度 7.50–7.81:1。

推论：**永远不要在比 `--poster-hue` 更靠上的选择器上组装 `--poster-tone*`。**

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

> **先说清楚这一节描述的是什么。** 下面是全站按钮的**约定**，站上大多数按钮
> 是按它手写出来的（内联样式或各自的组件）。共享组件 `components/ui/Button`
> 是另一回事：它目前只有 **3 个调用点，全部在详情页 hero 的动作行**
> （PlayButton / ShareButton / MagnetButton），实现的是那一行专用的三层权重，
> 而不是这一节。两者的差异是有意的，写在 [Anime Detail Page](#anime-detail-page详情页页面规范) 里。
> 往共享组件加第 4 个调用点之前，先决定它到底服务哪一套。

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

**Outlined（手写的三级操作）**
- Background: transparent
- Text: `rgba(235,235,245,0.60)` (`--text-secondary`)
- Padding: 8px 16px
- Radius: 8px
- Border: `1px solid rgba(84,84,88,0.65)` (`--separator`)
- Hover: border-color `#0a84ff`, text `#0a84ff`
- Use: 三级操作 — "Load More"、外链。**列表页、设置页这类平面背景上用这一档。**

**Glass（`Button` 组件的 `.outline`，只在详情页 hero）**
- Background: `rgba(255,255,255,0.08)` + `backdrop-filter: blur(12px)`
- Text: `rgba(255,255,255,0.90)`
- Border: `1px solid rgba(255,255,255,0.13)`
- Padding: 10px 18px，`min-height: 44px`，Radius 8px，13px / 600
- Hover: bg `0.14`，border `0.24`，text `#fff`，`translateY(-1px)`
- Use: 详情页 hero 动作行的次级控件（分享、磁力资源）

上面那个「透明 + 灰描边」在平面背景上是对的，放到 hero 上就不对了：hero 的
背景是一张**照片**，字底下没有可依赖的暗像素。页面上其他文字靠 text-shadow
解决这件事，控件该靠的是**一个面**。而且透明描边和纯文字工具挨在一起时读不出
差别 —— 那一行就变成"一个按钮加两个标签"。这一档拿白色低透明度而不是番剧色：
它是外壳，不是身份，身份色归旁边那个主按钮。

**焦点环两档共用同一个** —— `0 0 0 3px rgba(10,132,255,0.40)`，无例外。

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
- Font: JetBrains Mono, 13px, weight 500
- Radius: 6px
- Padding: 4px 12px
- **三档配色，背景与文字成对**：

| 分数 | 文字 | 背景 | Token |
|------|------|------|-------|
| ≥ 75 | `#30d158` (`--success`) | `rgba(48,209,88,0.12)` | `--score-high-fg` / `--score-high-bg` |
| 50–74 | `#ff9f0a` (`--warning`) | `rgba(255,159,10,0.12)` | `--score-mid-fg` / `--score-mid-bg` |
| < 50 | `#ff453a` (`--error`) | `rgba(255,69,58,0.12)` | `--score-low-fg` / `--score-low-bg` |

> **规则：** 背景和文字**必须同源**。唯一允许决定用哪一档的地方是
> `components/anime/scoreStyle.ts`，它一次返回一对。
>
> 这条规则是从一个线上缺陷倒推出来的：本节原先规定 score badge 恒为琥珀色，
> 没有分档；而详情页早已在按阈值算文字颜色，背景却硬编码成琥珀。
> 结果 ★9 和 ★8.3 在线上渲染成**绿字配琥珀底**，★6 和 ★5.7 才是对的。
> 规范和实现分别只错了一半，两边都看不出问题 —— 所以修的方式是让二者
> 无法再分开取值，而不是把已经成立的信息维度删掉。

**Score Badge — 封面上变体（`--score-scrim-bg`）**
- Background: `rgba(0,0,0,0.75)` + `backdrop-filter: blur(8px)`
- Text: 同上三档 fg
- Use: 番剧卡片右上角（badge 压在封面图上）

12% 的淡色底在封面上没有对比度保证 —— 动漫封面本来就极艳丽，
背后可能是任何颜色。所以压在图上的 badge 用不透明遮罩，只让**文字**带分档。
用 `scoreScrimStyle()`，不要把 `scoreBadgeStyle()` 拿去压图。

**Rating Bands（评分语义）**

阈值 75 / 50 是全站统一的评分语义，番剧卡片也用同一套：
≥75 好评、50–74 中评、<50 差评。改阈值要同时改 `scoreStyle.ts` 和本表，
`scoreStyle.test.ts` 会同时钉住两者。

## Anime Detail Page（详情页页面规范）

**这一页为什么单独立规范。** 它是全站唯一同时具备三个条件的页面：内容压在一张
照片上、每部番有自己的颜色、一屏之内要放下 6 种以上不同性质的信息。上面那些
component-level 的规则在平面背景上都成立，搬到这里会逐条失效 —— 灰描边在照片上
读不出来、蓝 accent 和番剧色打架、卡片边框把一页切成三十个盒子。所以这里写的不是
"详情页也可以这样"，而是**这一页的取值**，它和通用规范冲突时以这里为准。

实现落在 `app/[lang]/anime/[id]/page.module.css`（hero）、`sections.module.css`
（hero 以下六个区块）、`components/anime/EpisodesGrid.module.css`（集数区自带一套）。

### 一条主线：拆框

**边框只给"本身就是一个可点对象"的东西** —— 海报、按钮、卡片。分组交给留白、
对齐和字号，不交给容器。这一页早期是「有边框的卡片里装着两个有边框的盒子，
里面的缩略图还有自己的边框」，评审结论是"盒子太多，不舒服"。

推论，按优先级：

1. 文字周围不画框。行与行之间用 **1px 发丝线 `rgba(255,255,255,0.07)`** 分隔，
   hover 时给一个 **`rgba(255,255,255,0.045)` 的浮起面**，靠这两样把行认出来。
2. 图片周围可以画框 —— 因为画面本身就有边缘，不画反而会在深色封面上糊进背景。
   用 `inset 0 0 0 1px rgba(255,255,255,0.06)` 而不是 `border`，这样框不进盒模型、
   不会和 `aspect-ratio` 打架。
3. 层级来自**字号、字重、颜色**，不来自轮廓。

### 动作行的三层权重

hero 底部那一行是全页唯一的操作区，也是唯一需要严格排权重的地方。三档，从重到轻：

| 档 | 谁 | 底 | 边 | 字 |
|----|----|----|----|----|
| 实心 | 主 CTA（本地弹幕播放） | `--poster-tone` | 无 | `oklch(15% 0.03 var(--poster-hue))`，13px / 650 |
| 玻璃·重 | 追番入口（追番 / 添加到列表） | `rgba(255,255,255,0.12)` | `rgba(255,255,255,0.20)` | `#fff`，13px / 660 |
| 玻璃·轻 | 工具（分享、磁力资源） | `rgba(255,255,255,0.08)` | `rgba(255,255,255,0.13)` | `rgba(255,255,255,0.90)`，13px / 600 |

三档都 `min-height: 44px`、`border-radius: 8px`、`backdrop-filter: blur(12px)`，
行 `gap: 8px`、`flex-wrap: wrap`。

**整页只能有一个实心按钮。** 这条是硬约束，不是偏好。这一行曾经有两个 —— 主 CTA
用番剧色、追番用系统蓝 `#0a84ff` —— 结果是两个实心互抢，而且蓝色在这一页的调色板
里根本不存在（这页每一个有颜色的东西都带着番剧自己的色相），那个唯一的系统蓝
读起来像是从别的 App 掉进来的。追番是"开始追这部番"，不是"现在就看"，它属于第二档。

### Hero

#### 几何

| 项 | 值 | 说明 |
|----|----|------|
| 高度 | `clamp(400px, 44vw, 556px)` | 手机端另有覆盖，见下 |
| 海报宽 | `clamp(124px, 15.5vw, 216px)` | 比例 `210 / 300`，圆角 `10px` |
| 海报↔文字 | `clamp(16px, 3vw, 32px)` | |
| 内容离底 | `clamp(28px, 4.5vh, 48px)` | 内容 `align-items: flex-end`，坐在底边上 |
| banner 取景 | `object-position: center 38%` | 偏上，因为番剧 banner 的主体几乎总在上半部 |

banner 不是页面顶上的一条横幅，是 hero 的**背景**：`position: absolute; inset: 0`，
内容 `z-index: 1` 压在上面。压暗用两层渐变（一层竖直到底、一层 102° 斜向），
再叠一层 `mix-blend-mode: soft-light` 的番剧色，`opacity: 0.055` —— 这一层的作用是
让画面和这部番的颜色**是同一件事**，不是给画面调色，超过 0.06 就开始看得出来了。

**海报的阴影分两半，只有一半等颜色：**

```
基础（无条件）  0 24px 56px -20px rgba(0,0,0,0.92)
番剧色光晕      0 0 58px -40px var(--poster-tone)   ← 只在 [data-accent-ready="true"] 之后
```

投影是"把海报从画面上抬起来"，它和颜色无关、任何时候都成立，所以不该跟着取样
结果一起等 —— 挂上去等的那版，前 400ms 海报是**贴平**在 banner 上的。光晕才是身份，
它可以等。

光晕用 `--poster-tone` 而**不是** `--poster-accent`：原色是封面上取下来的那个像素，
饱和的封面会在海报周围画一圈刺眼的环，寡淡的封面等于没画。`spread: -40px` 也是
故意的 —— 这是一层要找才看得见的光，不是一道边。

> ⚠️ 这条规则住在 `globals.css` 的 `.hero-cover`，**不在** CSS Module 里。
> `[data-accent-ready="true"] .hero-cover` 是两个类选择器，压得过 module 的单类。
> 在 `page.module.css` 的 `.cover` 里写阴影是死代码 —— 写过一次，样式表看起来
> 完全正确而页面渲染的是另一套值。

#### 排版

| 元素 | 取值 |
|------|------|
| 标题 | `clamp(28px, 4.4vw, 58px)` / `1.08` / `-0.018em`，下边距 **10px** |
| 日文原名 | `--font-jp` 14.5px，`rgba(235,235,245,0.84)`，下边距 20px |
| 罗马字 | `--font-latin` 12px / 500 / `+0.1em` / uppercase，`rgba(235,235,245,0.68)`，左边距 15px |
| Facts 行 | 13.5px / `1.62`，`rgba(235,235,245,0.78)`，下边距 24px |

**hero 里每一段文字都带 text-shadow**，且是"宽而软"而不是投影 ——
`0 1px 2px rgba(0,0,0,0.5), 0 3px 24px rgba(0,0,0,0.72)`，模糊半径比偏移大一个数量级。
它做的不是投影，是**局部压暗字底下那块画面**。渐变只能保证一片暗的**场**，
保证不了任何一个笔画底下是暗像素 —— 封面上一处高光落在笔画后面，那个笔画就没了。
纯色背景上这东西不花钱，画面亮的时候它是唯一的救命稻草。

标题下边距 10px 不是 `--sp-xs`(4)：58px 的标题自带的下沉部分已经吃掉大半间距，
4px 会让标题和副标题互相钻进对方的行盒，读起来像一段折行的话。

#### Facts 行

一句话，中点分隔。**不是胶囊**。这一行的每一项都是"读一次就完"的事实
（评分、状态、集数、类型），没有一个是控件，而填充圆角矩形是本站表示"可以按"
的词汇。十四个胶囊堆三层还要吃掉简介上方约 90px，手机上正好是"落在正文"和
"落在装饰"的差别。

- 分隔点用 `::after` **画**出来，不写进 JSX —— 写进去它就进了无障碍树和爬虫读到的
  文本，整行变成 "9 · BGM 7.8 · TV" 这样一个句子。
- 必须挂在**前一项**的 `::after`，不能挂后一项的 `::before`：这一行手机上要折 3–4 行，
  `::before` 是独立的 flex item，会跟着后一项换行，于是每一折行都以一个孤零零的
  点开头。
- 分隔点 `margin: 0 9px`，字号钉死 13.5px（否则会继承主评分的 16px 变大一号），
  颜色 `rgba(235,235,245,0.28)`。
- **主评分是这一行唯一放大加粗的东西**：16px / 640 / `--poster-tone`。它旁边的
  "AniList" 标签保持 13.5px / 400。颜色一个人扛不住这个活 —— 13.5px/500 的时候它
  和后面的"已完结 · 13 集 · 动作"重量完全一样，得找才看得见。

### 区块节奏（hero 以下）

简介 / 作品信息 / 角色 & 配音 / 制作人员 / 相关作品 / 推荐这**六个**区块共用一套
头部：一条**短的**番剧色线 + 标题 + 计数。集数列表自带一套等价的头部
（它还要放语言开关和已看进度），改任何一边都要顺手对一下另一边。

| 项 | 取值 |
|----|------|
| 区块间距 | `margin-top: clamp(52px, 8vh, 88px)` |
| 头部下边距 | 22px |
| 标题 | 15px / **640** / `+0.01em` |
| 头部横线 | 18 × 2px，圆角 1px，`--sec-tone`，右边距 11px，`vertical-align: 0.34em` |
| 计数 | `--font-mono` 11.5px / 500 / `+0.05em`，`--text-tertiary` |

**是一条短线，不是一条贯穿整页的分隔线。** 一条横跨页面的线是用来分隔"上面"和
"下面"两样东西的，而这些区块上面没有需要被分开的东西 —— 它只是在说"这里开始
是个新的东西"。

标题 15px 只比它引出的 14.5px 正文高半个点，等级全靠**字重**和旁边那条线扛，
所以是 640 而不是 600（600 是正文里加粗值用的）。这里不换字体：Sora 没有中日韩
字形，中文标题无论如何都回落到 PingFang。

### 简介 + 评分

两栏，中间只有间距，没有分隔线也没有卡片。

```
grid-template-columns: minmax(0, 1.7fr) minmax(210px, 0.8fr)
gap: clamp(24px, 4vw, 56px)          ≤900px 塌成一栏，评分区改横排
```

| 元素 | 取值 |
|------|------|
| 正文 | 15px / `1.9`，`rgba(235,235,245,0.60)`，**`max-width: 62ch`** |
| 展开更多 | 13px / 600，`--poster-tone`，上边距 13px |
| 来源署名 | 11.5px / `1.6`，`rgba(235,235,245,0.35)`，上边距 14px |
| 分数 | `--font-mono` 34px / 700 / `-0.025em`；AniList 用 `--sec-tone`，Bangumi 用 `rgba(235,235,245,0.94)` |
| 分数标签 | `--font-mono` 9.5px / 600 / `+0.15em` / uppercase，`--text-tertiary`，下边距 8px |
| 进度条 | 高 2px，`max-width: 180px`，上边距 **10px**，底 `rgba(255,255,255,0.08)` |

**`62ch` 是这一节唯一不能省的数字。** 简介栏是 1.7fr，笔记本上约 880px，
15px 下就是一行 95 个字符 —— 读者回到行首会找不到下一行。62ch 把它锁在约 558px，
和栏有多宽无关；这是段落的 max-width 而不是把栏改窄，因为旁边的评分区还需要那个宽度。

进度条上边距 10px 而不是 6：6px 的时候它在数字自己的行盒里，读起来像下划线，
而它是数字下面**另一个**记号。

评分区**不是卡片，是两组对齐的数字**。AniList 的分数拿番剧色（页面第 4 个承重
位置），Bangumi 的保持中性 —— 一行里两个彩色数字就是两个标题在喊。

### 作品信息

无框定义列表，靠列对齐。`repeat(8, minmax(0, 1fr))`，≤1100px 变 4 列，
`gap: 22px 30px`。

- `dt`：`--font-mono` 9.5px / 600 / `+0.14em` / uppercase，`--text-tertiary`，下边距 7px
- `dd`：14.5px / 500，`--text`

八对标签/值用表格是错的容器：没有表头，行与行之间也没有关系，它就是八个独立
事实。定宽列 + 一个 mono 小标签就够了。

### 集数列表

一行，不是一格。早期是编号方块的网格，88px 的格子放得下大约四个字符 ——
于是每个标题都渲染成省略号，而"第 14 集和第 15 集有什么不同"这唯一的信息
从来没有可读过。行有那个宽度。

| 元素 | 取值 |
|------|------|
| 网格 | `repeat(auto-fill, minmax(258px, 1fr))`，`gap: 1px 26px` |
| 行 | `min-height: 44px`，`padding: 5px 6px`，`margin: 0 -6px`，圆角 8px，`gap: 10px` |
| 已看圆点 | 18 × 18px 圆，`1.5px` 边 `rgba(235,235,245,0.28)`；已看填 `--success` + 内嵌勾 |
| 集号 | `--font-mono` 11px / 600，`tabular-nums`，`--text-tertiary`，**右对齐** |
| 标题 | 14px / `1.45` / **490**，2 行 `line-clamp` |
| 原名 | `--font-jp` 11.5px / `1.5`，`rgba(235,235,245,0.42)`，单行省略 |
| 讨论角标 | 高 26px，`gap: 5px`，SVG 气泡 + 数字（**不是 emoji**） |

行的负外边距（`margin: 0 -6px`）配合 padding：hover 的面伸进两侧的水沟，读起来
是"列表的一行"而不是"文字周围冒出来一个盒子"。

**圆点固定 18px 且两态同尺寸** —— 未登录探测落地、或者切换已看状态时，格子的
高度不能变。这以前是"两个分支渲染同样的 markup"这种靠自觉维持的承诺，现在是
布局改不动的事实。

**集号右对齐**：`01…09` 和 `10…13` 收在同一个像素上，标题也就从同一个像素开始。
左对齐时数字自己能对齐但到标题的间距对不齐，一部番过了 99 集、编号宽出一位的
时候就看得见了。

标题 2 行截断而不是 1 行：集标题能长到 40 字以上（银魂有一整批），加宽列救不了
它，只会为一部番牺牲其余所有番的密度。

#### 集标题语言开关

区块头右侧三个**文字**档位，不是分段控件：

| 项 | 取值 |
|----|------|
| 档位 | 12.5px / 500，**`--text-secondary`**；hover `--text` |
| 选中 | `--text` + `text-decoration: underline`，色 `--poster-tone`，粗 2px，offset 5px |
| 命中区 | `padding: 14px 6px` + 等量负外边距 → 实测 **37 × 46px**，区块头不长高 |
| 组 | `role="group"` + `aria-label`，三个 `aria-pressed` 的真 `<button>` |

三个填充胶囊放在区块头里会压过旁边的标题，读起来像这一区的主操作 —— 它不是，
它改的是"这份列表怎么标注"，不是列表里有什么。

**未选中的两档用 `--text-secondary`，不是 `--text-tertiary`。** 这条踩过：
tertiary 是给"可以忽略的说明"的，实测 **2.25:1** —— 既低于 4.5:1 的正文线，
也低于 3:1 的非文字线。而这两档恰恰是读者正在扫、准备切过去的目标，是整个控件
里最该看清的东西。写成 tertiary 之后这个开关读起来是"一个标签加两个鬼影"。
secondary 是 6.36:1。

**命中区靠 padding + 等量负外边距买。** 12.5px / 1.4 的盒子只有 17px 高 ——
触屏上是个 17px 的目标。负外边距把空间原样还回去，所以区块头不长高、baseline
不动（padding 移动的是盒子，不是基线）。`.titleModes` 的 `gap` 读作**字与字**
之间的距离：padding 和负外边距在算式里相消，text-to-text 恰好等于 gap 的值。

**选中态用 `text-decoration` 而不是 `box-shadow`。** 两个原因，第二个是被迫的：
box-shadow 从边框盒起算，而边框盒现在比文字高出 14px，下划线会飘在词的下方；
而且焦点环也是 box-shadow，两个记号抢同一个属性 —— 之前的写法里，Tab 到选中项
会把"这项是选中的"这个唯一信号擦掉。

**默认是读者自己的语言**，不是并排。并排每行两条，13 集变 26 行，列表就从
"扫一眼"变成"读一遍"。开关只在**有东西可切**的时候出现（某一行的原名和显示
标题不同）——一个按了没反应的控件比没有控件更糟。

> **en 语境下这个开关不会出现，这是结构性的。** `EPISODE_TITLE_LADDER` 里
> en 是 `[name, nameCn]`，而"原名"取的就是 `name` 并在等于显示标题时置空 ——
> 所以英文下永远等于空，`hasOriginals` 恒为 false。实测 `/en/anime/116674`
> 渲染 0 个 `aria-pressed`。这是**当前数据模型只有两个字段**的结果，不是 bug：
> 英文读者的"显示标题"和"原名"是同一个字段。en 的三个档位文案因此是死字符串，
> 留着是为了将来 `name` / `nameEn` 分家时不用回头补 —— 但**别把它们当作已经
> 上线的文案去评审**。

偏好存 `localStorage` 的 `animego:episodeTitleMode`，通过 `useSyncExternalStore`
读（`lib/episodeTitleMode.ts`）。**不要用 `useState` + effect**：这个组件要水合，
惰性初始值会在水合渲染里读浏览器存储、和服务端的 markup 不一致；effect 里
`setState` 是级联渲染，也是本仓库 lint 闸门拦的那条。顺带白拿一个好处 ——
另一个标签页改了偏好，这个列表跟着动。

**这个选择有代价，记在这里免得下次当成 bug 查：** 服务端不知道 localStorage，
所以首屏一定画默认档，水合后才换成存的那档。dev build 实测约 0.8s；选了并排的
读者还会看到集数网格长高约 54px。可接受，因为另外两条路更糟（惰性初始值 =
水合不一致，effect = 级联渲染）。真要消掉，得把偏好搬到 cookie 让服务端能读 ——
那是另一件事，别顺手做。

**词典键走的是间接调用**（`t(TITLE_MODE_LABEL[mode])`），而
`spaDictCoverage.test.ts` 的扫描只认 `t("字面量")`。实测把三个键从 zh-spa.js 和
zh-Hant-spa.js **同时**删掉，33 个测试全绿 —— 它们看起来被覆盖只是因为
`hantDictParity` 钉住了 zh↔zh-Hant 的键集相等，而那只挡得住**单边**漂移。
现在由 `spaDictCoverage.test.ts` 里的 `INDIRECT_KEYS` 显式兜住。
**以后在客户端组件里写 `t(变量)`，就要往那张表里加一行。**

> **zh-Hant 的已知缺口（既有，不是这次引入的）：** migration 0022 只给作品标题和
> 简介加了 hant 列，**集标题没有繁体通道**，所以 `EPISODE_TITLE_LADDER` 里
> zh-Hant 和 zh 一样读 `nameCn` —— 繁体读者看到的是繁体的开关标签配**简体**的
> 集标题。数据到位之前这条改不了，改 CSS 也没用。

### 角色 / 制作人员 / 相关作品

| 区块 | 网格 | 关键取值 |
|------|------|----------|
| 角色 & 配音 | 1 → 2（≥880px）→ 3（≥1340px）列 | 行 `padding: 12px 10px`，`margin: 0 -10px`，圆角 10px |
| 制作人员 | `auto-fill minmax(220px, 1fr)`，`gap: 18px 32px` | 头像 40 × 40 圆 |
| 相关 / 推荐 | `auto-fill minmax(140px, 1fr)`，`gap: 16px` | 画框 `6 / 8.6`，圆角 9px，下边距 9px |

- 角色人像 **56 × 76**（圆角 7px）—— 和 hero 海报同一类物件的比例，但不和它抢。
  放到 64 × 86 时每行 110px 高，八个角色就是一整屏。
- 职位小标签 `--font-mono` 10px / 600 / `+0.08em`。**角色那一侧用
  `--poster-tone-quiet`，声优那一侧用中性 `--sec-meta`** —— 「主角/配角」是每行都
  重复的同三个字，给满 accent 的话一列八行读起来就是八个高亮。
- 角色名 15px / **560** / `1.35`：比正文重、比标题轻。它是这一行的主语，但这一行
  是列表项不是标题。
- 海报格是**整页唯一保留"卡"形态的东西** —— 卡片本身就是那个可点对象。它和 hero
  海报用同一个 `6 / 8.6`：同一页上同一批画面用两种比例，等于把同一张图裁两次。

### 手机端（≤600px）

hero 不堆叠，改成**两列网格 + 动作行跨栏**：

```
grid-template-columns: var(--hero-cover-w) minmax(0, 1fr);
.metaColumn { display: contents; }        海报和文字并排（第 1 行）
.actionSlot { grid-column: 1 / -1; }      动作行横跨两列（第 2 行）
```

| 元素 | 手机取值 |
|------|----------|
| hero 高 | **340px**（桌面是 400 起） |
| 标题 | 25px / `1.18` |
| 日文原名 | 14px，下边距 8px |
| Facts | 12px / `1.5`，下边距 12px；分隔点 `margin: 0 6px` |
| 罗马字 | **独占一行**，`margin-left: 0`，`white-space: normal`，字距收到 `+0.04em` |

堆叠是参考设计的做法，这里没采用：堆叠会把简介顶下第一屏，而简介正是搜索来的
访客要看的东西。代价是文字列在 390px 上只剩 218px。

**罗马字那条要连起来看：** 桌面上 `white-space: nowrap` 是对的（那是一个整词，
断在中间读起来像排版事故）；到了 218px 的列里，nowrap 不会让它留在一行，而是把
它推出视口被祖先裁掉 —— 字面上少了半截。所以这里换行，同时把字距从 `0.1em` 收到
`0.04em`：字距的作用是说"这是转写不是标题"，大写和拉丁字体已经说掉大半，而 25 个
字符下每 `0.01em` 值 3px。收完之后常见长度回到一行。

这条还有第二层：hero 是**底对齐**的固定 340px 盒子，所以副标题多一行不会把页面
往下推，它把**标题往上推**，推向导航栏。手机上任何增加 hero 内容高度的改动都要
按这个方向想一遍。

`@media` 块必须放在文件**末尾**：里面每条规则和它覆盖的基础规则同专一性，
靠源序决胜。放在 `.title` / `.facts` 上面时整个媒体查询是死的 —— 手机端的数字
加它之前和之后逐字节相同。

### 这一页的六条硬约束

1. **正文不带番剧色调。** 参考设计把正文设成 `oklch(80% 0.012 h)`，那在一部番上
   看着对；跨全库它不是一个颜色是 360 个 —— 色相 18 时解析成 `#c5bbbb`，色相 196
   时是 `#b5c0c0`，单通道差 16/255，读者看得出来，而他们看到的是"换一部番正文
   变色了"，读起来像渲染故障。身份归**关于这部番**的元素：分数、主按钮、区块线、
   hover 态。正文走中性文字色。
2. **文字色最多用到 `--poster-tone-quiet`。** 再往下（`-mid` / `-low`）是给线条和
   填充的，不到 4.5:1。
3. **焦点环永远是那一个蓝色 box-shadow**，`0 0 0 3px rgba(10,132,255,0.40)`。
   不要 outline（行的 `overflow: hidden` 会把它裁掉），不要番剧色。
4. **hero 里的文字要么带 text-shadow，要么坐在一个面上**，二选一，不能都没有。
5. **整页只有一个实心按钮。**
6. **`--poster-tone*` 只能在写 `--poster-hue` 的那个元素上声明**（`.poster-scope`）。
   见 Color 一节的陷阱说明 —— 违反它的表现是静默失效，不是报错。

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
- 用 `#0a84ff` (`--accent`) 作为**唯一**可点击操作色 — 按钮、链接、焦点环、进度条。
  唯一记录在案的例外是详情页 hero 的主 CTA（用番剧色，理由是对比度，见 Color 一节）
- 用三层背景色差（`#000` → `#1c1c1e` → `#2c2c2e`）表达层级，而非堆 shadow
- 封面图使用 `aspect-ratio: 3/4` + `object-fit: cover`，保持网格整齐（详情页例外，见 Responsive 一节）
- 所有可交互元素必须有 focus ring（`0 0 0 3px rgba(10,132,255,0.40)`）—— **焦点环
  永远是这一个蓝色，不随番剧色变**
- 新增 UI 文案时同步更新**六个**词典文件（三语 × 服务端/客户端两套），见 Iteration Checklist 第 6 条
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
- 不要拿 `--poster-tone-mid` / `--poster-tone-low` 写字 — 它们是线条和填充，
  分别只有 3.65:1 和 1.25:1。需要"番剧色但轻一档的文字"用 `--poster-tone-quiet`
- 不要假设 CSS Module 里的单类选择器能压过 `globals.css` —— `[data-x="true"] .y`
  是两个选择器，赢过 module 的 `.y`。这类冲突**不报错**：样式表读起来完全正确，
  页面渲染的是另一套值。改一个有全局同名类的元素之前，先在浏览器里看计算值

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
- **详情页:** 不是"双栏塌成单栏"。hero 手机端保持**海报和文字并排**、动作行横跨两列；
  简介/评分那一栏在 ≤900px 塌成单栏且评分改横排；作品信息 8 列 → 4 列（≤1100px）。
  完整取值见 [Anime Detail Page](#anime-detail-page详情页页面规范)，那一节是权威
- **顶栏:** 桌面完整导航 → 移动端仅 Logo + 搜索图标 + 用户头像
- **导航:** 桌面顶栏 → 移动端底部 Tab Bar（首页/搜索/追番/我的）
- **弹幕面板:** 桌面侧边常驻 → 移动端底部 Sheet（上滑展开）
- **封面图:** 网格卡片保持 `3:4`，宽度随网格自适应。**详情页是例外**：hero 海报
  `210 / 300`（7:10），相关/推荐格 `6 / 8.6`。AniList 的大图是 460×650，7:10 几乎
  不裁，`3:4` 会看得见地切掉画面；同一页上的这两处用同一个比例，否则等于把同一张
  图裁两次。
  > ⚠️ 实测全 `src/` 里封面比例有 **6 种**（`3/4`、`2/3`、`5/7`、`7/10`、`6/8.6`、
  > 库里的 `2/3`）。上面这条"永远 3:4"目前只在网格卡片成立。这是待收敛的漂移，
  > 不是详情页引入的 —— 收敛它需要单独看一遍每个调用点，别顺手改。

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
6. 新增文案要写进**六个**词典：三种语言 × 两套
   （`locales/{zh,en,zh-Hant}.ts` 服务端 + `{zh,en,zh-Hant}-spa.js` 客户端）。
   漏掉客户端那一半不会报错 —— `t()` 找不到键时返回**键本身**，页面上直接渲染
   出 `library.overflow.rescan` 这样的字符串。`spaDictCoverage.test.ts` 是这道闸门，
   但它只认 `t("字面量")`：写成 `t(TABLE[k])` 这种间接调用它看不见
7. 网格 6→3→2 列，断点 900px / 600px，`max-width: 1400px`
8. 网格卡片封面 `3:4`，不裁切、不拉伸；详情页另有比例（见 Responsive 一节的例外）

## Decisions Log

| Date       | Decision                              | Rationale                                                              |
|------------|---------------------------------------|------------------------------------------------------------------------|
| 2026-03-27 | 放弃紫色 `#7c3aed`，换用 iOS Blue `#0a84ff` | 用户明确要求；Apple Blue 更克制，避免霓虹感                          |
| 2026-03-27 | 背景从蓝调暗色换为 Apple True Black    | 与 iOS Blue 体系一致；OLED 省电；视觉更沉稳                          |
| 2026-03-27 | 保留 Sora + DM Sans 字体组合           | Sora 已集成且有日系差异点；DM Sans 易读性好；竞品调研确认品类内少见   |
| 2026-03-27 | 副色选 iOS Teal `#5ac8fa`              | 与 iOS Blue 同属 Apple 色系，保持系统感；严格限定为只读/信息场景      |
| 2026-03-27 | 文字改用 Apple Label System（rgba）    | 比固定灰色更自然地适配不同背景层，层次感更丰富                        |
| 2026-03-27 | 初版设计系统建立                       | 由 /design-consultation 基于竞品调研（AniList、MAL）生成              |
| 2026-08-27 | 31 个 token 全部落进 `globals.css`，并由 `globals.test.ts` 钉住 | 此前只落了 10 个且其中 6 个漂移；实测全 `src/` 里 `--accent` 9 处引用、`--bg` / `--text` 各 1 处、**其余调色板 0 处** —— 设计系统只存在于文档里。修正漂移值零风险：那 6 个没有任何 `var()` 引用 |
| 2026-08-27 | Score Badge 从"恒琥珀"改为三档，且背景文字成对 | 规范和实现各错一半：规范没有分档，实现按阈值算文字却硬编码琥珀背景 → 线上 ★9 是绿字琥珀底。选择修订规范匹配已成立的做法（番剧卡片也在用阈值），而不是删掉信息维度 |
| 2026-08-27 | `--poster-accent` 明确为"不要蓝色以外 accent"的例外 | 它是每部番自己的封面取样色，不是品牌色；但严格限定在 hero 光晕，不得用于可点击元素 |
| 2026-08-27 | `--text-quaternary` 保持 0.18 并标注为仅限禁用态 | ~2.5:1 低于 WCAG AA，但禁用控件本就豁免（1.4.3）；标注防止它被当成"更淡的正文色"使用 |
| 2026-08-30 | 详情页单独立**页面级**规范（本文 Anime Detail Page 一节） | 它是全站唯一同时"内容压在照片上 + 每部番一个颜色 + 一屏放六类信息"的页面，component-level 规则搬过来逐条失效（灰描边在照片上读不出、蓝 accent 和番剧色打架、卡片边框把一页切成三十个盒子）。与通用规范冲突时以该节为准 |
| 2026-08-30 | 新增 `--poster-tone-quiet` = `oklch(68% 0.07 h)` | 色阶里缺"番剧色但轻一档的**文字**"，最像的 `--poster-tone-mid` 是给线条的，拿它写 10px 标签跨全色相最差 3.65:1 不过 AA —— 而这个错在样式表和评审里都长得完全正确。68 是反解出来的：C=0.07 时三层背景的 4.5:1 明度地板分别是 57 / 62.5 / 67.5，token 要扛最严的那层。参考设计用 62（它只有一个背景色），搬过来会"页面上过、进卡片就不过" |
| 2026-08-30 | 海报光晕改用 `--poster-tone`，投影与光晕拆开 | 原来两层都用原色 `--poster-accent` 且都等 `data-accent-ready`：饱和封面画出刺眼红环、寡淡封面等于没画，且前 400ms 海报贴平在 banner 上。投影和颜色无关，不该跟着等 |
| 2026-08-30 | hero 动作行钉死"整页只有一个实心按钮" | 追番曾是系统蓝实心，和番剧色主 CTA 两个实心互抢；且蓝色不在这一页的调色板里（其余每个有色元素都带番剧色相），那个唯一的系统蓝读起来像从别的 App 掉进来 |
| 2026-08-30 | 集数区加集标题语言开关，默认**读者自己的语言** | 原来硬编码并排，每行两条、13 集变 26 行，列表从"扫"变成"读"。开关只在有东西可切时出现；偏好走 `useSyncExternalStore` + localStorage，不用 `useState`+effect（水合不一致 / 级联渲染，后者是 lint 闸门拦的那条） |
| 2026-08-30 | `components/ui/Button` 的适用范围写进文档：只服务详情页 hero 三个调用点 | 它的 `.primary` 是 `--poster-tone` 不是 `#0a84ff`，`.outline` 是玻璃不是灰描边 —— 和 Buttons 一节描述的全站约定是两套东西。此前文档只写了约定，读者会以为共享组件实现了它 |
