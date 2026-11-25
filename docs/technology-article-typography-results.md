# 科技文章排版改造验证

实施基线：`d103b3c`。仅调整工作区文章内容及必要的节点适配，不改变数据库、Markdown 保存格式、同步协议或应用布局。

## 实现与调用边界

- `DocumentEditor → MarkdownEditor → Milkdown/ProseMirror` 同时承担编辑与只读阅读。移除 `wechatEditorStyles` 向工作区注入发布主题样式的接线，使用同一份 `article.css`；公众号 `MarkdownPreview → renderWechat` 继续独立维护。
- 原生字体栈、16px/1.8 正文、H1–H6 层级、段距、代码与表格集中在文章作用域中。沿用已有行宽偏好，启用限制时最大 800px；窄编辑区保留原有区块操作槽，阅读区使用对称边距。
- 颜色引用 Radix gray/indigo 语义令牌，正文及链接在两种外观中实测达到 4.5:1 对比度。主题通过 CSS 切换，不重建文档或图表。
- 图片独占段落的标记加入原有、按文档变更范围缓存的装饰流程；行内图片保持行内语义。使用原有加载器返回的尺寸，避免放大小图，保留选择、源码、重试和放大入口。
- 普通图片的非空 alt 同时用作图下居中的灰色小字，原 Markdown 和图片 alt 保持。已有显式 `<figure>/<figcaption>` 时使用独立图注；发布时转成 `section`/`p` 并内联说明样式。原有脚本、事件和 URL 过滤不变，title 不作为图注。
- 表格仅增加一层局部滚动容器，操作控件仍在外层；相对外层计算滚动后的手柄位置。复用原有选区、行列增删、排序、拖动和剪贴板实现。
- 阅读模式直接点击 HTTP(S) 链接进入现有 `desktop.openLink`；编辑模式维持普通单击编辑、Windows Ctrl/macOS ⌘ 单击打开。未扩大允许的协议。
- Mermaid 和透明技术图片使用浅色画布保证深色阅读可辨认；不改变原始像素、不对普通图片反色，不因外观切换重绘 Mermaid。公式继续使用现有渲染与深色适配。

## 可见内容及用途

| 区域 | 最终用户用途 |
| --- | --- |
| 正文与 H1–H6 | 通过字号、字重和留白识别文章结构，控制长文行宽。 |
| 链接 | 下划线、主题色及焦点轮廓帮助识别可访问目标，长 URL 可折行。 |
| 图片与显式图注 | 保留原图比例、小图清晰度和作者明确提供的说明。 |
| 行内代码及代码块 | 等宽字体区分代码，局部滚动保留原始缩进与长行。 |
| 表格 | 清晰的表头、水平分隔和局部滚动支持宽表格阅读与编辑。 |
| 引用、提示块、列表、分割线 | 用层级和间距组织论证、步骤及补充信息。 |
| Mermaid 与公式 | 保留既有复杂节点和编辑入口，控制宽内容溢出。 |

没有新增应用按钮、通知、帮助文字或设置项；文章内容及图注来自作者原文。

## 变更文件

生产实现：

```text
apps/desktop/src/styles/article.css
apps/desktop/src/styles/desktop-shell.css
apps/desktop/src/workspace/Document.tsx
packages/editor-react/image-view.ts
packages/editor-react/index.tsx
packages/editor-react/presentation.ts
packages/editor-react/table-view.ts
packages/markdown-core/index.ts
```

回归与样稿：

```text
apps/desktop/src/editor/editor-session.test.tsx
apps/desktop/src/editor/editor-spacing.test.tsx
apps/desktop/src/editor/markdown-core.test.ts
apps/desktop/src/editor/wechat-renderer.test.ts
apps/desktop/src/workspace/document.test.tsx
apps/desktop/src/workspace/workspace-session.test.tsx
apps/desktop/tests/article-typography.html
apps/desktop/tests/article-typography.tsx
fixtures/technology-article.md
tests/browser/article-typography.spec.ts
tests/browser/theme-quotes.spec.ts
```

文档：`docs/ui-design-guidelines.md`、`tests/browser/README.md`、本文件。

## 实际验证

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 最终独立全量 40 个文件、573 项全部通过，82.33 秒；见下方计时回归处理 |
| 编辑器、文档、Markdown 安全、公众号渲染专项 | 4 文件、170 项通过，包含新增图注隔离与三类发布输出断言 |
| 综合科技文章 Chromium/WebKit | 14 项通过，覆盖深浅外观、360px/1200px、编辑/阅读、AA 对比度、图片、图注、溢出、表格、主题选区、撤销重做和长文输入 |
| 发布主题/脚注浏览器回归 | 74 项通过，覆盖 9 套主题及 LF/CRLF、普通引用、13 类提示块、脚注和 URL 换行；工作区新段距与各发布主题原段距分别断言 |
| Markdown 源码浏览器回归 | 92 项均已通过；其中 WebKit 一项键盘进入源码测试全量时首次失败，未改变实现及断言，针对性重跑两引擎通过 |
| `pnpm tauri build --debug --no-bundle` | Windows 通过，包含 web 生产构建 |
| 真实 Windows WebView2 | 通过；独立应用标识、全新工作区、原生导入 PNG 素材、综合 Markdown 加载、图注/图表、真实输入及保存、阅读与深浅色切换 |

全量测试先出现同步按钮反馈计时失败；同一机器、同一锁文件的隔离 `d103b3c` 基线 569 项通过，不能把失败归为已证实的历史问题。该测试的真实 1 秒等待与产品要求的 1 秒结果锁边界重合，现复用项目已有虚拟时钟：反馈到期后，先断言尚在回放时仍禁用，再保留回放完成后恢复可用的原断言；不延长超时、不修改同步逻辑，定向验证通过。随后与构建并发的一轮发生未修改目录测试的 5 秒超时，最终全量改为独立执行，没有调整其断言或时限。

独立代码评审使用 `CHILD_AGENT / FULL_SCOPE`，覆盖本轮全部 22 个文件及 Canvas、Collection 相邻消费者，未发现 P0/P1。曾发现的主题文档残留已修正；虚拟时钟验证与脚注投影选择器的增量评审通过。

500 个附加段落、20 次外观切换并同步计算布局的本机采样，最终综合测试 p95：Chromium 7.70ms、WebKit 23.00ms。测试也确认编辑器和图表 DOM 身份不变。没有增加逐段 React 组件、光标触发的全文解析或同步尺寸扫描；这些采样没有旧版本同机对照，不能据此承诺所有设备性能不变。

综合原文：`fixtures/technology-article.md`。测试页位于 `apps/desktop/tests/article-typography.*`，不参与生产入口。真实 WebView2 脚本与结果位于忽略目录 `output/typography/`；明暗截图位于 `output/playwright/technology-native-{light,dark}.png`。测试应用已正常退出，独立工作区保留，正式工作区未修改，临时应用标识没有写入生产配置。

## 未执行的验收与边界

- macOS 实机 WKWebView 尚未验证；Windows 上的 Playwright WebKit 不能替代 macOS 原生验收。
- 未操作真实图床或公众号后台，无法宣称实际粘贴、上传及后台保存通过。现有导出结构、链接、图注文字、代码、表格、引用和图片元信息已通过自动回归。
- 没有新增 SVG 素材导入能力或图片背景开关，格式边界沿用现有素材服务；原生烟雾测试图片为 PNG，Mermaid/公式使用现有 SVG 渲染。
- 下载之前没有尺寸信息的外链图片仍可能产生布局变化；本次没有引入远端探测或修改历史数据模型。
- 没有新增数据库迁移、依赖或网络字体。
