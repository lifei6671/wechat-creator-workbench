# 公众号排版来源

锁定 [lifei6671/plainly@73d906300817523b313f96d5acbbbbd96f23fbb4](https://github.com/lifei6671/plainly/tree/73d906300817523b313f96d5acbbbbd96f23fbb4)。代码与主题的来源如下。

| 此处模块 | Plainly 来源 | 处理与许可 |
| --- | --- | --- |
| `themes/wechat-default.ts`、`themes/wechat-elegant.ts`、`themes/wechat-tech.ts` | `src/theme/rico/upstream/wechat-{default,elegant,tech}.js` | 保留名称和内容组件样式，移除文章容器整页底色，用稳定 ID 注册。上游为 [ricocc/rico-md@8c22fe5711365ffe646a0987b6d670d22511de58](https://github.com/ricocc/rico-md/tree/8c22fe5711365ffe646a0987b6d670d22511de58)，Copyright (c) 2024–2026 Rico (ricoui.com)，MIT。完整文本见 [LICENSE-RICO](themes/LICENSE-RICO)。 |
| `index.ts` 中公众号表格宽度处理 | `src/utils/converter.ts` 的 `solveWeChatHtml` | 保留内联后给全宽表格补 `width="100%"` 的行为。使用独立渲染结果，GPL-3.0，见根目录 [LICENSE](../../LICENSE)。 |
| `index.ts` 的主题注册和 Markdown 扩展 | `src/theme/registry.ts`、`src/utils/helper.ts` | 按新工作区的输入快照和轻量主题定义实现。复用 markdown-it、Highlight.js、Juice 和 Mermaid，上游依赖版本见锁文件。 |

公众号渲染在 WebView 中运行，脚注复用 Plainly 使用的 markdown-it-footnote。Rust 提取公式和图表的来源，供渲染和派生素材清理共用。公式使用 MathJax 3 的本地 SVG 字形，图表使用本地打包的 Mermaid。二者在复制和导出时以 PNG 登记为派生素材。markdown-it-dollarmath 补丁更新了 Markdown-it 14.x 的 ESM 依赖路径，并保留同一行多个展示公式之间的正文。图床 URL 验证、剪贴板写入和文件落盘使用 Rust 命令。

任务列表复用 [mdit-plugins/mdit-plugins](https://github.com/mdit-plugins/mdit-plugins) 的 `@mdit/plugin-tasklist@0.23.2`（MIT），该版本兼容项目的 markdown-it 14.x。复用其任务 token 识别，在既有 renderer 扩展点输出静态勾选标记，关闭 label 包装；不开放 HTML 表单标签。项目适配任务标记后的制表符，使其与编辑器 GFM 契约一致。提示块的 13 种名称共同映射为四组语义色，发布与编辑使用同一分组。

## GZH Design 主题

固定来源：[isjiamu/gzh-design-skill@750a50dffdc4abb5e853b98136dad13a57e64ce3](https://github.com/isjiamu/gzh-design-skill/tree/750a50dffdc4abb5e853b98136dad13a57e64ce3)。Copyright (C) 2026 甲木 (Jiamu) × 摸鱼小李 (Moyu Xiaoli)。上游及改编文件 `themes/gzh-design.ts` 采用 AGPL-3.0-or-later，完整许可见 [LICENSE-GZH-DESIGN](themes/LICENSE-GZH-DESIGN)。修改日期：2026-11-20。

仅将 `references/theme-{moyu-green,red-white,graphite-minimal,zen-whitespace,moyu-ticket,olive-journal}.md`、`theme-index.md` 和 `common-components.md` 中适用于 Markdown 的排版组件改编为确定性主题。复用本项目现有 Markdown 解析、净化、语法高亮、公式与图片处理、Juice 内联和发布流程，不引入 Skill 安装、提示词、Python 校验器、主题生成器或 AI 调用。

六套主题通过文章主题菜单选择。顶层二级标题添加章节编号；已有编号保持原样，明确的结语标题使用 ∞。原文加粗映射为下划线强调，高亮、引用、列表、表格、图片和代码沿用原始内容。不自动生成封面、目录、摘要、关键词、署名，不替换原文标点。代码保留原始空白与换行，使用单独语言栏，文字节点补 `span leaf`。可折叠块在公众号输出中展开显示，保留内容及链接；脚注仍保留本项目的锚点契约。

适配项目 UI 规范：颜色使用 Radix 浅色阶的固定值（独立于工作台明暗主题），边框为 0.5px，字号限定为 12/15/20px，不加入装饰眉题与动画。编辑视图使用 Radix 语义令牌提供对应主题色，章节装配只发生于公众号预览、复制与 HTML 导出。

编辑、阅读与发布从同一份最终主题 CSS 取得引用、列表、表格和代码块布局；主题投影使用现有 Juice 内联器处理缩写、子节点规则与优先级。GZH 代码语言栏复用编辑器原有语言编辑入口，非激活时采用主题栏布局；源码激活、表格操作和字体行宽保留编辑用途。透明色兼容 CSSOM 的 `initial`、`transparent` 及零 alpha 表示，避免 Chromium 与 WebKit 产生额外底色。

引用样稿包含普通与末尾两个段落，分别读取通用段距和末段下边距，避免 `:last-child` 影响所有段落。真实浏览器回归见 `tests/browser/README.md`，不以 jsdom 的长短边距属性解析结果代替 Chromium、WebKit 验证。

所有主题的文章容器不设置整页背景色，预览、复制与 HTML 导出一致；引用、代码块、表头和高亮等内容组件保留各自底色。手机屏幕的亮色、暗色模拟独立于工作台外观，默认亮色；暗色仅转换预览 DOM 的文字、背景和边框，图片保留原色，切回亮色恢复原始内联样式。模拟表面与颜色转换均不写入复制或导出的 HTML。

本项目 GPLv3 部分与上述 AGPLv3 部分依两种许可第 13 条组合，不能将上游改编部分作为 GPL-only 重新许可；组合体须遵守网络交互时的源码提供要求。当前桌面应用通过「关于」中的项目地址和开源声明提供来源，打包时附带上游完整许可证。参考 [GPLv3 §13](https://www.gnu.org/licenses/gpl-3.0.html#section13) 与 [AGPLv3 §13](https://www.gnu.org/licenses/agpl-3.0.html#section13)。
