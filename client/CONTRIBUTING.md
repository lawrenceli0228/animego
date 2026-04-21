# Contributing to animego/client

## JSX-only 政策（强制）

本仓库前端只接受 **纯 JavaScript (`.js` / `.jsx`)**。禁止引入 `.ts` / `.tsx` 文件。

### 原因

- 现有工具链（Vite 7 + Vitest 4）未配置 TypeScript 编译。
- 混合 JS/TS 会拖慢构建并引入 `tsc` 维护负担，与项目维护模式定位不符。
- 类型安全通过 JSDoc 按需补充即可。

### 第三方组件接入规则

使用 `shadcn/ui`、`radix-ui` 示例、或任何 CLI 生成的组件时：

1. **禁止直接 copy `.tsx` 进仓**。
2. 将 TSX 源转为 JSX：去掉类型注解、`interface` / `type` 声明、`React.FC` 等类型特性。
3. 必要时用 JSDoc 保留 Props 形状：
   ```js
   /**
    * @typedef {Object} ButtonProps
    * @property {'primary'|'ghost'} [variant]
    * @property {() => void} [onClick]
    */

   /** @param {ButtonProps & React.ComponentProps<'button'>} props */
   export function Button({ variant = 'primary', ...rest }) { /* ... */ }
   ```
4. 保留 Radix primitives 的 runtime 行为（asChild / forwardRef）不变。

### shadcn CLI 使用建议

- `npx shadcn@latest add <component>` 输出 TSX 后，手动逐文件转 JSX 再 commit。
- 或使用 `--yes` + 本地脚本批量重命名 + strip 类型，然后 `npm run lint` 验证。

### ESLint 约束（如需强制）

若要在 CI 层硬拦截，可在 `eslint.config.js` 添加：

```js
{
  ignores: ['**/*.ts', '**/*.tsx'],
}
```

并在 `package.json` scripts 里加一条 `"check:no-ts": "test -z \"$(find src -name '*.ts' -o -name '*.tsx')\""`。

---

## 其它约定

- CSS 单一数据源：`--xxx` 变量在 `:root` 定义，`@theme inline` 桥接到 Tailwind。新增颜色/间距/圆角优先走 tokens，不要硬编码。
- 组件单文件 < 400 行；工具函数单文件 < 200 行。
- 弹幕播放器 (`Artplayer` + `artplayer-plugin-danmuku`) 不可替换。
