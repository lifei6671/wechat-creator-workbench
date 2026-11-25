# 莫兰迪公众号主题验证

主题 ID：`morandi`，显示名：`莫兰迪`。基于当前工作区的 Markdown、图片及发布实现新增，没有更改历史主题 ID、默认项、数据模型、同步协议或数据库迁移。

## 调用链与样式边界

`WechatPublicationPanel → wechatThemes → queue.edit({ themeId }) → renderWechat → parseWechat / sanitizeRenderedMarkdown → 图片及 Mermaid 处理 → applyMorandi → Juice → 类名/内部数据清理 → MarkdownPreview 或 renderForPublication → clipboard_write_html / HTML 导出`。

- `themes/morandi.ts` 集中管理初始色板、字号、段距、边框、代码配色和装饰结构。默认只使用灰蓝 `#849AA9`、灰绿 `#879D8B` 与中性边框，灰紫/棕/玫瑰保留为色板数据，没有新增配色选择控件。
- 根容器不写背景色；正文、标题、强调、列表、表格、链接和脚注使用 `color:inherit`。普通内容不写固定前景色。提示块与高亮覆盖既有共享规则，避免引入旧主题的固定文字/背景颜色。
- H1 短线、H2 竖线、H3 圆点使用内联元素及基本边框/尺寸。装饰标记内加入不可见空格，避免使用完全空的元素，不进入提取后的纯文本标题；真实客户端是否保留仍需下方验收。
- 代码块复用现有高亮；固定浅底 `#F4F3F0` 与深色文字 `#25272A` 成对设置，代码区之外的普通文字继续继承。长行保持原始空白、缩进及换行，通过局部滚动呈现。
- 各主题发布解析保留安全的显式 `<figure>/<figcaption>`，统一转换为 `section`/`p`。普通图片的非空 alt 同时作为图下说明；已有显式图注时优先使用图注。说明字号 13px、居中、与图间隔 8px、颜色为 Radix Gray 11；模拟暗色预览由既有颜色转换器适配。图片 alt 保留，title 不自动转换为图注，公式和 Mermaid 的内部替代文字不生成说明。
- `MarkdownPreview` 复用现有亮/暗按钮及颜色转换器；莫兰迪默认跟随外层应用主题，手动选择可模拟另一种外观，应用主题再次变化时重新跟随。外观变化只更新展示 DOM，保留滚动位置，不重新解析文章或渲染图表。
- 复制和导出重新从 Markdown 调用渲染器，不读取模拟预览 DOM；产物仅含内联 CSS，没有应用 CSS 变量、主题类或交互控件。预览专用 `data-line` 保留给导航，复制/HTML 导出时清理。

## 文件与用途

| 文件 | 用途 |
| --- | --- |
| `packages/wechat-renderer/themes/morandi.ts` | 主题参数、继承颜色规则及短线/圆点 |
| `packages/wechat-renderer/index.ts` | 注册主题，复用既有渲染/内联/清理链路，限定新主题布局 |
| `packages/markdown-core/index.ts` | 可选保留安全图注标签，其他调用默认不变 |
| `apps/desktop/src/workspace/Document.tsx` | 新主题的预览默认跟随应用外观 |
| `apps/desktop/src/workspace/document.test.tsx` | 主题切换保留编辑器和 Markdown 的回归 |
| `apps/desktop/src/editor/morandi-theme.test.ts` | 三种输出的颜色、内联、清理、链接策略、图注及图表服务链路 |
| `fixtures/morandi-theme.md` | 覆盖全部所需元素的综合样稿 |
| `apps/desktop/tests/morandi-theme.html` / `.tsx` | 真实预览组件和模拟原生图片/图表服务的浏览器夹具 |
| `tests/browser/morandi-theme.spec.ts` | 两引擎外观、对比度、宽度、导出隔离、真实侧栏选择及长文验证 |
| `packages/wechat-renderer/SOURCES.md`、`tests/browser/README.md`、本文件 | 实现说明、运行方式和人工验收 |

此前工作区已有的科技文章排版修改保留；本次不将那些修改重新归为莫兰迪实现。

## 可见内容及用途

- 主题菜单新增「莫兰迪」，用于选择发布样式；现有预览标签显示所选主题名称。
- 灰蓝标题装饰和短分割线用于识别章节，灰绿引用边框用于区分引文。
- 正文、列表和表格沿用客户端文字颜色；图片说明使用居中的灰色小字。
- 现有亮/暗预览按钮保留，用于检查另一种阅读外观；没有新增按钮、通知或说明文案。

## 自动化结果

验证日期：2026-11-25，Windows。新主题测试先复现未注册/回退默认主题，并发现、修正了提示标题共享颜色的优先级覆盖。

| 命令或检查 | 实际结果 |
| --- | --- |
| `pnpm test` | 41 个文件、584 项通过 |
| 定向运行 `morandi-theme.test.ts`、`editor-spacing.test.tsx`、`document.test.tsx`、`theme-integration.test.tsx`、`wechat-renderer.test.ts` | 5 个文件、104 项通过 |
| `pnpm typecheck` | 通过 |
| `pnpm test:browser tests/browser/morandi-theme.spec.ts tests/browser/theme-quotes.spec.ts` | Chromium/WebKit 共 68 项通过，包含新主题及旧主题回归 |
| 最终再次运行 `pnpm test:browser tests/browser/morandi-theme.spec.ts` | 两引擎共 14 项通过 |
| `pnpm tauri build --debug --no-bundle` | 通过，包含生产前端构建；生成 Windows 调试应用，未生成安装包 |
| `git diff --check` | 通过 |

浏览器验证覆盖 390px/1200px、浅色/深色、所有层级标题、正文与代码高亮参考对比度 ≥4.5:1、原始 Markdown 不变、预览 DOM/滚动位置不变、外观切换前后 HTML 导出完全一致、真实 Mermaid 渲染、图注和局部溢出。已检查手机宽度的浅深色截图，结果保存在 `output/playwright/morandi-*.png`。

构建仅报告既有 Vite 配置、体积与混合导入警告，以及 Windows 链接器生成库文件的提示，未修改依赖或构建配置。本轮未启动构建后的原生应用；WebKit 浏览器测试不能代替 macOS 原生验收。

400 个附加段落的热渲染初步样本（每主题两次，包含图表与样式内联）：Chromium 技术主题约 95–113ms、莫兰迪约 115–119ms；WebKit 技术主题约 319–415ms、莫兰迪约 274–350ms。样本少且受调度影响，只用于识别明显退化，不能视为所有机器的性能保证。

## 微信公众号人工验收清单

本地模拟不是微信客户端验收，以下项目尚未执行。

1. 在现有公众号侧栏选择「莫兰迪」，确认文章内容不变；准备含完整样稿元素的文章，按现有方式配置图片上传、链接转脚注。
2. 点击真实「复制公众号格式」，粘贴到新的公众号草稿；确认没有残留 `asset://` 地址、图片占位或未转换的外链。
3. 检查 H1 短线、H2 的 4px 竖线、H3 圆点及 48px 短分割线。确认编辑器没有过滤标记或边框，保存后仍然存在。
4. 保存草稿、离开并重新打开，核对正文、粗体、斜体、删除线、任务标记、引用/嵌套引用、图注和完整 URL。
5. 在 iOS、Android 微信手机端分别检查浅色和深色：正文、标题、列表、表头/表格正文、脚注和图注应可读，不应出现固定整页底色或被固定暗色文字覆盖。
6. 检查代码底色与所有高亮文字配对可读；复制含缩进、空行及很长行的代码，核对文本完整性。验证横向滚动是否被保留，以及文章整体有没有被撑宽。
7. 检查普通表格、八列表格、长单词/连续字符与行内代码；确认断行及表格内容完整，并记录移动端对宽表格的实际处理。
8. 检查真实上传图片、透明架构图和 Mermaid 派生图片，保存及重新打开后仍能访问；图注不代替 alt 描述。
9. 检查公众号文章链接、脚注文本及脚注编号，确认现有微信链接策略保持；实际打开目标应正确。
10. 对照一套既有主题的同一文章，确认新主题接入没有改变原主题输出。保留客户端版本、系统、截图和发现的问题，再决定是否用于正式发布。

## 已知边界

- 微信对内联 CSS、空白、滚动、深色颜色及图片的重写行为不能由模拟预览保证；未宣称后台保存或微信真机通过。
- 正文的实际对比度取决于客户端继承的颜色；自动检查使用本应用的明暗阅读表面作为参考。
- 预览和长文测试使用真实图形渲染与模拟素材服务，真实图床传输和 macOS 原生应用仍需独立验收。
- 没有新增依赖、网络字体、同步字段或迁移。
