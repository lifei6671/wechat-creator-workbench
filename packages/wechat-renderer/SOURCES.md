# Plainly 排版来源

锁定 [lifei6671/plainly@73d906300817523b313f96d5acbbbbd96f23fbb4](https://github.com/lifei6671/plainly/tree/73d906300817523b313f96d5acbbbbd96f23fbb4)。代码与主题的来源如下。

| 此处模块 | Plainly 来源 | 处理与许可 |
| --- | --- | --- |
| `themes/wechat-default.ts`、`themes/wechat-elegant.ts`、`themes/wechat-tech.ts` | `src/theme/rico/upstream/wechat-{default,elegant,tech}.js` | 保留原样式和名称，用稳定 ID 注册。上游为 [ricocc/rico-md@8c22fe5711365ffe646a0987b6d670d22511de58](https://github.com/ricocc/rico-md/tree/8c22fe5711365ffe646a0987b6d670d22511de58)，Copyright (c) 2024–2026 Rico (ricoui.com)，MIT。完整文本见 [LICENSE-RICO](themes/LICENSE-RICO)。 |
| `index.ts` 中公众号表格宽度处理 | `src/utils/converter.ts` 的 `solveWeChatHtml` | 保留内联后给全宽表格补 `width="100%"` 的行为。使用独立渲染结果，GPL-3.0，见根目录 [LICENSE](../../LICENSE)。 |
| `index.ts` 的主题注册和 Markdown 扩展 | `src/theme/registry.ts`、`src/utils/helper.ts` | 按新工作区的输入快照和轻量主题定义实现。复用 markdown-it、Highlight.js、Juice 和 Mermaid，上游依赖版本见锁文件。 |

公众号渲染在 WebView 中运行，脚注复用 Plainly 使用的 markdown-it-footnote。Rust 提取公式和图表的来源，供渲染和派生素材清理共用。公式使用 MathJax 3 的本地 SVG 字形，图表使用本地打包的 Mermaid。二者在复制和导出时以 PNG 登记为派生素材。markdown-it-dollarmath 补丁更新了 Markdown-it 14.x 的 ESM 依赖路径，并保留同一行多个展示公式之间的正文。图床 URL 验证、剪贴板写入和文件落盘使用 Rust 命令。
